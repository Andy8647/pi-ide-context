-- pi-ide: Neovim 端 — 暴露编辑器状态给 pi(协议 v0.2)
-- 写入 <state_dir>/<pid>.json,pi 扩展读取并注入 LLM 上下文
-- 协议定义见 repo 根 docs/protocol.md
--
-- v0.2 语义:列号统一 1-based;selection 带 selected_at(用户最后一次选择的时刻),
-- 由 pi 端按新鲜度决定是否注入,不再用寄存器猜"有没有选区"。

local M = {}

local state_dir = (os.getenv("XDG_RUNTIME_DIR") or "/tmp") .. "/pi-ide"

--- 去抖动间隔 (ms)
local DEBOUNCE_MS = 200
-- 用 uv timer 替代 vim.defer_fn(避免 close 已失效 timer 报错)
local uv = vim.uv or vim.loop
local timer = nil

--- 本进程内最后一次退出 visual 模式的时间(unix 秒);nil = 本进程还没主动选过。
-- 这是 selected_at 的来源:marks '< '> 在退出 visual 后一直残留,
-- 不能靠"有没有 marks"判断,要靠"上次选择是什么时候"。
local last_visual_exit = nil
--- 最后一次退出时所在的 visual 模式("v" / "V" / "\22" block),用于退出后精确重建选区文本
local last_visual_mode = nil

local function is_visual_mode(mode)
  return mode == "v" or mode == "V" or mode == "\22"
end

--- 把两个位置规范化为 (start, end)(行优先,同行比列;列 1-based byte)
local function ordered(p1, p2)
  if p1[2] < p2[2] or (p1[2] == p2[2] and p1[3] <= p2[3]) then
    return p1, p2
  end
  return p2, p1
end

--- 行内切片:byte 列 1-based 闭区间,越界安全
local function slice_line(line, col_from, col_to)
  local len = #line
  local a = math.max(1, math.min(col_from, len + 1))
  local b = math.max(0, math.min(col_to, len))
  if b < a then return "" end
  return string.sub(line, a, b)
end

--- 从规范化后的两个位置取选区文本 + 起止列。
-- 规则:单行按列精确裁剪;多行首尾行裁剪、中间整行;V 行选择整行。
-- 返回 text_lines(lines 数组)、start_col、end_col
local function capture_selection(s, e, mode)
  local sln, eln = s[2], e[2]
  local scl, ecl = s[3], e[3]
  local line

  if mode == "V" then
    -- 行选择:全行,列即整行
    local lines = vim.fn.getline(sln, eln)
    local last = lines[#lines]
    return lines, 1, #last
  end

  if sln == eln then
    line = vim.fn.getline(sln)
    return { slice_line(line, scl, ecl) }, scl, ecl
  end

  local lines = {}
  line = vim.fn.getline(sln)
  lines[#lines + 1] = slice_line(line, scl, #line)
  for i = sln + 1, eln - 1 do
    lines[#lines + 1] = vim.fn.getline(i)
  end
  line = vim.fn.getline(eln)
  lines[#lines + 1] = slice_line(line, 1, ecl)
  return lines, scl, ecl
end

--- 获取当前 buffer 状态(协议 v0.2,列号一律 1-based)
local function get_buffer_state()
  local fname = vim.api.nvim_buf_get_name(0)
  local ft = vim.bo.filetype
  local lines_total = vim.api.nvim_buf_line_count(0)
  local mod = vim.bo.modified

  -- 光标:nvim_win_get_cursor 列是 0-based,协议统一 1-based
  local cursor0 = vim.api.nvim_win_get_cursor(0)
  local cursor = { line = cursor0[1], column = cursor0[2] + 1 }

  local mode = vim.fn.mode()
  local in_visual = is_visual_mode(mode)

  -- 选区:marks '< '> 反映最近一次 visual。只有「正在 visual」或本进程主动选过才报告,
  -- selected_at 交给 pi 端判新鲜度——旧选区不注入、不误报。
  local selection = nil
  local mark_lnum = vim.fn.line("'<")
  if mark_lnum > 0 and (in_visual or last_visual_exit ~= nil) then
    local a, b
    if in_visual then
      a = vim.fn.getpos("v")
      b = vim.fn.getpos(".")
    else
      a = vim.fn.getpos("'<")
      b = vim.fn.getpos("'>")
    end
    local s, e = ordered(a, b)
    local mode_for_text = mode
    if not in_visual then
      -- 刚退出 visual:marks 仍在,用退出时刻记下的模式重建选区文本,
      -- 这样 Esc 后切到 pi 的常见路径也能拿到精确选区(而非整行)。
      mode_for_text = last_visual_mode or "V"
    end
    if mode_for_text == "\22" then
      -- visual block:整行拉取,列为两个 anchor 的 byte 列(近似,协议注明)
      local text_lines = vim.fn.getline(s[2], e[2])
      selection = {
        start = { line = s[2], column = s[3] },
        ["end"] = { line = e[2], column = e[3] },
        text = table.concat(text_lines, "\n"),
      }
    else
      local text_lines, sc, ec = capture_selection(s, e, mode_for_text)
      selection = {
        start = { line = s[2], column = sc },
        ["end"] = { line = e[2], column = ec },
        text = table.concat(text_lines, "\n"),
      }
    end
    selection.selected_at = in_visual and os.time() or last_visual_exit
  end

  return {
    file = fname ~= "" and fname or nil,
    name = fname ~= "" and vim.fn.fnamemodify(fname, ":t") or "[No Name]",
    language = ft ~= "" and ft or nil,
    cursor = cursor,
    selection = selection,
    modified = mod,
    lines_total = lines_total,
  }
end

--- 带值 nvim flag:其下一个参数是它的值,需一并丢弃
-- 无值 flag(--embed、--headless、-R、-n 等)不在此列
local VALUE_FLAGS = {
  ["-c"] = true, ["-u"] = true, ["-S"] = true, ["-i"] = true, ["-l"] = true,
  ["-p"] = true, ["-o"] = true, ["-t"] = true, ["-q"] = true, ["-w"] = true, ["-W"] = true,
  ["--cmd"] = true, ["--listen"] = true,
}

--- 启动参数(vim.v.argv 去掉 argv[0]),用于区分同 cwd 下多个实例
-- 只保留位置参数(文件/目录):丢弃 - 开头的 flag 及其带值 flag 的伴随值,
-- 这样 "nvim --embed pi/" → { "pi/" },"nvim -c cmd dir/" → { "dir/" }
local function launch_argv()
  local argv = vim.v.argv or {}
  local out = {}
  local skip_next = false
  for i = 2, #argv do
    local a = argv[i]
    if type(a) ~= "string" then
      skip_next = false
    elseif skip_next then
      skip_next = false -- 上一个 flag 的值,丢弃
    elseif a:sub(1, 1) == "-" then
      skip_next = VALUE_FLAGS[a] == true
    elseif a ~= "" then
      out[#out + 1] = a
    end
  end
  return out
end

--- 写入状态文件(原子:先写 .tmp 再 rename)
local function write_state()
  vim.fn.mkdir(state_dir, "p", tonumber("700", 8))

  local state = {
    pid = vim.fn.getpid(),
    cwd = vim.fn.getcwd(),
    timestamp = os.time(),
    app = "nvim",
    argv = launch_argv(),
    active_buffer = get_buffer_state(),
  }

  local fname = state_dir .. "/" .. vim.fn.getpid() .. ".json"
  local tmp = fname .. ".tmp"
  local f = io.open(tmp, "w")
  if f then
    f:write(vim.json.encode(state))
    f:close()
    os.rename(tmp, fname)
  end
end

--- 去抖动的写入(uv timer)
local function debounced_write()
  if timer then
    timer:stop()
    timer:close()
    timer = nil
  end
  timer = uv.new_timer()
  timer:start(DEBOUNCE_MS, 0, function()
    timer:stop()
    timer:close()
    timer = nil
    vim.schedule(write_state)
  end)
end

--- 启动自动追踪
function M.setup(opts)
  last_visual_exit = nil
  last_visual_mode = nil
  vim.fn.mkdir(state_dir, "p", tonumber("700", 8))
  write_state()

  local group = vim.api.nvim_create_augroup("PiIdeContext", { clear = true })

  vim.api.nvim_create_autocmd({ "CursorMoved", "CursorMovedI" }, {
    group = group,
    callback = debounced_write,
  })

  vim.api.nvim_create_autocmd({ "TextChanged", "TextChangedI" }, {
    group = group,
    callback = debounced_write,
  })

  -- 文件/窗口切换立即写入
  vim.api.nvim_create_autocmd({ "BufEnter", "WinEnter", "BufWritePost" }, {
    group = group,
    callback = write_state,
  })

  -- 进入 visual:立即写入(marks 已就位,selected_at 用当前时刻)
  vim.api.nvim_create_autocmd("ModeChanged", {
    group = group,
    pattern = "*:v,*:V,*:\22",
    callback = write_state,
  })

  -- 退出 visual:记下选择完成时刻与模式,立即写入(这是 fresh 窗口的起点)
  vim.api.nvim_create_autocmd("ModeChanged", {
    group = group,
    pattern = "v:*,V:*,\22:*",
    callback = function()
      local old = vim.v.event.old_mode
      last_visual_exit = os.time()
      last_visual_mode = (old == "v" or old == "V" or old == "\22") and old or "V"
      write_state()
    end,
  })

  -- 退出时清理
  vim.api.nvim_create_autocmd("VimLeavePre", {
    group = group,
    callback = function()
      os.remove(state_dir .. "/" .. vim.fn.getpid() .. ".json")
    end,
  })
end

--- 手动触发写入
function M.flush()
  write_state()
end

return M

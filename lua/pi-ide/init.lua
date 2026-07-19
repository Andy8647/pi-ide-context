-- pi-ide: Neovim 端 — 自动暴露编辑器状态给 pi 读取
-- 写入 /tmp/pi-ide/<pid>.json，pi 扩展在 before_agent_start 时读取

local M = {}

local state_dir = (os.getenv("XDG_RUNTIME_DIR") or "/tmp") .. "/pi-ide"

--- 去抖动间隔 (ms)
local DEBOUNCE_MS = 200
-- 用 uv timer 替代 vim.defer_fn（避免 close 已失效 timer 报错）
local uv = vim.uv or vim.loop
local timer = nil

--- 获取当前 buffer 状态
local function get_buffer_state()
  local fname = vim.api.nvim_buf_get_name(0)
  local ft = vim.bo.filetype
  local lines = vim.api.nvim_buf_line_count(0)
  local mod = vim.bo.modified

  -- 光标
  local cursor = vim.api.nvim_win_get_cursor(0)
  local row, col = cursor[1], cursor[2]

  -- 选区 (visual mode marks '< '>)
  local sel = nil
  local sln = vim.fn.line("'<")
  local scl = vim.fn.col("'<")
  local eln = vim.fn.line("'>")
  local ecl = vim.fn.col("'>")

  if sln > 0 and eln >= sln then
    -- 在 visual mode 里时，用当前选区代替 marks
    local mode = vim.fn.mode()
    local sel_lines = {}
    if mode == "v" or mode == "V" or mode == "\22" then
      -- 用 v 和 . 标记当前 visual selection 的边界
      local v_start = vim.fn.getpos("v")
      local v_end = vim.fn.getpos(".")
      sln = math.min(v_start[2], v_end[2])
      eln = math.max(v_start[2], v_end[2])
      scl = v_start[3]
      ecl = v_end[3]
      if mode == "V" then
        scl = 1
        ecl = #vim.fn.getline(eln)
      end
      sel_lines = vim.fn.getline(sln, eln)
    elseif #vim.fn.getreg('"') > 0 and vim.fn.getregtype('"') ~= "" then
      -- 刚退出 visual mode，用 unnamed register 判断是否有最近选区
      sel_lines = vim.fn.getline(sln, eln)
    else
      sel_lines = vim.fn.getline(sln, eln)
    end

    sel = {
      start = { line = sln, column = scl },
      ["end"] = { line = eln, column = ecl },
      text = table.concat(sel_lines, "\n"),
    }
  end

  return {
    file = fname ~= "" and fname or nil,
    name = fname ~= "" and vim.fn.fnamemodify(fname, ":t") or "[No Name]",
    language = ft ~= "" and ft or nil,
    cursor = { line = row, column = col },
    selection = sel,
    modified = mod,
    lines_total = lines,
  }
end

--- 写入状态文件
local function write_state()
  vim.fn.mkdir(state_dir, "p")

  local state = {
    pid = vim.fn.getpid(),
    cwd = vim.fn.getcwd(),
    timestamp = os.time(),
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

--- 去抖动的写入（uv timer）
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
  vim.fn.mkdir(state_dir, "p")
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

  -- 退出 visual mode 立即写入（捕获选区 marks）
  vim.api.nvim_create_autocmd("ModeChanged", {
    group = group,
    pattern = "v:*,V:*,\22:*",
    callback = write_state,
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

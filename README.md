# pi-ide-context

自动将 Neovim / VS Code 的编辑器状态注入到 pi 消息中。

在编辑器里选中一段代码、切到 pi 发消息，pi 自动知道你在哪个文件、光标在哪、选中了什么。

## 安装

### Pi 扩展

```bash
pi install git:github.com/andy/pi-ide-context
# 或本地开发
pi install ~/Projects/fork/pi/pi-ide-context
```

然后在 pi 里 `/reload`。

### Neovim 插件 (lazy.nvim)

```lua
{
  "andy/pi-ide-context",
  -- 自动启动，无需额外配置
  -- 可选：手动设置
  -- opts = {}
}
```

## 工作原理

```
┌───────────┐  写 JSON    ┌──────────────┐  读 JSON    ┌────────┐
│  Neovim   │ ──────────► │ /tmp/pi-ide/ │ ◄────────── │   pi   │
│  autocmd  │  每 300ms   │  <pid>.json  │  before_    │  auto  │
│  hooks    │             │              │  agent_     │ inject │
└───────────┘             └──────────────┘  start      └────────┘
```

- Neovim 端：autocmd 监听 CursorMoved / TextChanged / BufEnter 等事件，去抖动写入状态 JSON
- Pi 端：`before_agent_start` hook 读取 JSON，匹配 cwd，格式化为 LLM 上下文注入
- 匹配策略：精确 cwd → 子目录前缀 → 最新文件
- 过期处理：>30s 未更新的文件视为过期，优先用未过期的

## 协议

状态文件格式 (`/tmp/pi-ide/<pid>.json`)：

```json
{
  "pid": 12345,
  "cwd": "/Users/andy/my-project",
  "timestamp": 1700000000,
  "active_buffer": {
    "file": "/Users/andy/my-project/src/main.ts",
    "name": "main.ts",
    "language": "typescript",
    "cursor": { "line": 42, "column": 10 },
    "selection": {
      "start": { "line": 40, "column": 0 },
      "end": { "line": 45, "column": 20 },
      "text": "selected code here..."
    },
    "modified": false,
    "lines_total": 200
  }
}
```

VS Code 端也可以写相同格式的文件到同一目录，pi 扩展无需修改。

## TODO

- [ ] VS Code 扩展（写协议文件）
- [ ] 多编辑器同时打开时的优先级处理
- [ ] 项目级 `.pi-ide-ignore` 排除敏感文件

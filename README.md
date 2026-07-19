# pi-ide-context

> `/ide` for pi — like Claude Code's IDE integration, but for Neovim and VS Code.

[![npm version](https://img.shields.io/npm/v/pi-ide-context)](https://www.npmjs.com/package/pi-ide-context)
[![GitHub](https://img.shields.io/badge/github-Andy8647/pi--ide--context-blue)](https://github.com/Andy8647/pi-ide-context)

Select text in Neovim, switch to pi — pi already knows which file you're in, where your cursor is, and what you selected. No copy-paste. No `:PiAsk`. It just works.

## Install

### Pi extension

```bash
pi install npm:pi-ide-context
```

Then `/reload` in pi.

### Neovim plugin (lazy.nvim)

```lua
{
  "Andy8647/pi-ide-context",
  lazy = false,
}
```

## Usage

```
pi starts → widget shows · main.ts (detected, not connected)
  ↓
/ide → pick editor from list → connected
  ↓
widget shows ▸ main.ts → LLM receives editor context automatically
  ↓
/ide off → disconnect
```

When connected, every message you send to pi automatically includes:

```
### IDE Context
- File: /Users/andy/my-project/src/main.ts
- Language: typescript
- Cursor: line 42, column 10
- Buffer: 200 lines (modified)
- Selection: lines 40–45
  ```typescript
  const foo = bar();
  // ...
  ```
```

## How it works

```
┌──────────┐  writes JSON   ┌──────────────┐  reads JSON   ┌────────┐
│  Neovim  │ ─────────────► │ /tmp/pi-ide/ │ ◄──────────── │   pi   │
│ autocmd  │  debounced     │  <pid>.json  │  before_      │  auto  │
│  hooks   │  every 200ms   │              │  agent_start  │ inject │
└──────────┘                └──────────────┘               └────────┘
```

**Neovim side**: autocmd on CursorMoved / TextChanged / BufEnter / ModeChanged writes
editor state to a JSON file. Zero dependencies — a single Lua file.

**Pi side**: `before_agent_start` hook reads the JSON, matches by cwd, and injects
formatted editor context. A `setInterval` widget shows live file/selection info below
the input area.

## Protocol

Editor state is written to `/tmp/pi-ide/<pid>.json`:

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

Same protocol works for VS Code — just write the same JSON format. The pi extension
needs zero changes.

## License

MIT

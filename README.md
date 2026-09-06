# pi-ide-context

> `/ide` for pi — like Claude Code's IDE integration, but for Neovim, VS Code and Obsidian.

[![npm version](https://img.shields.io/npm/v/pi-ide-context)](https://www.npmjs.com/package/pi-ide-context)
[![GitHub](https://img.shields.io/badge/github-Andy8647/pi--ide--context-blue)](https://github.com/Andy8647/pi-ide-context)

Select text in Neovim (or VS Code / Obsidian), switch to pi — pi already knows which
file you're in, where your cursor is, and what you selected. No copy-paste. No
`:PiAsk`. It just works.

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

### VS Code extension

Not published to the marketplace yet — build and install locally:

```bash
cd editors/vscode
npm install && npm run build
code --extensionDevelopmentPath="$PWD"   # dev instance, or package + install a vsix
```

### Obsidian plugin

In the community plugin directory — search **pi-ide-context** under Settings →
Community plugins → Browse, or install from
[community.obsidian.md/plugins/pi-ide-context](https://community.obsidian.md/plugins/pi-ide-context).

To build from source instead:

```bash
cd editors/obsidian
npm install && npm run build
mkdir -p "<vault>/.obsidian/plugins/pi-ide-context"
cp main.js manifest.json "<vault>/.obsidian/plugins/pi-ide-context/"
```

Then enable **pi-ide-context** under Settings → Community plugins.

## Usage

```
pi starts in a project where nvim is running
  ↓
auto-connects to the single live nvim for this cwd — widget shows `in main.ts`
  ↓
select lines in nvim → widget shows `5 lines selected in main.ts`
  ↓
ask pi → context injected automatically (selection fresh for 60s)
  ↓
/ide off → disconnect; new sessions auto-connect again
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

Selection text is injected only while fresh (within 60s of making it); after
that the file/cursor context is still sent but the selection text is not — same
as Claude Code's chip disappearing. Widget text is pure ASCII (no Nerd Font
needed). If several nvim instances share this cwd, `/ide` lists them by launch
args (`nvim pi/` vs `nvim pi-ide-context/`) so you can pick the right one.

## How it works

```
┌──────────┐  writes JSON   ┌──────────────┐  reads JSON   ┌────────┐
│  Neovim  │ ─────────────► │ /tmp/pi-ide/ │ ◄──────────── │   pi   │
│ autocmd  │  debounced     │  <pid>.json  │  before_      │  auto  │
│  hooks   │  every 200ms   │              │  agent_start  │ inject │
└──────────┘                └──────────────┘               └────────┘
```

**Neovim side**: autocmd on CursorMoved / TextChanged / BufEnter / ModeChanged writes
editor state to a JSON file. Zero dependencies — a single Lua file. Sends its launch
args (`argv`) so same-cwd instances can be told apart.

**Pi side**: `before_agent_start` reads the JSON for the connected editor and injects
formatted editor context (lightweight file/cursor/buffer every time; selection text
only while fresh). Auto-connects to a unique live nvim for this cwd, shows a widget
below the editor, and a `/ide` command for manual pick / off.

Full protocol in [`docs/protocol.md`](docs/protocol.md).

## Protocol

Editor state is written to `/tmp/pi-ide/<pid>.json`:

```json
{
  "pid": 12345,
  "cwd": "/Users/andy/my-project",
  "timestamp": 1700000000,
  "app": "nvim",
  "argv": ["pi-ide-context/"],
  "active_buffer": {
    "file": "/Users/andy/my-project/src/main.ts",
    "name": "main.ts",
    "language": "typescript",
    "cursor": { "line": 42, "column": 10 },
    "selection": {
      "start": { "line": 40, "column": 1 },
      "end": { "line": 45, "column": 20 },
      "text": "selected code here...",
      "selected_at": 1700000000
    },
    "modified": false,
    "lines_total": 200
  }
}
```

Columns are 1-based. `selected_at` drives the freshness window (60s on the pi
side). The same protocol works for VS Code / Obsidian — just write this JSON. The pi
extension is editor-agnostic; all three clients (Neovim, VS Code, Obsidian)
write it. See `editors/` for the VS Code and Obsidian clients.

## License

MIT

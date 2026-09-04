# pi-ide-context Protocol v0.2

Single source of truth for the editor ↔ pi state exchange. The pi extension, the
Neovim client, and any future editor clients (VS Code, Obsidian) all follow this
document.

## State file

Each running editor writes one JSON file:

```
<state_dir>/<pid>.json
```

- `state_dir` = `$XDG_RUNTIME_DIR/pi-ide` when `XDG_RUNTIME_DIR` is set, else `/tmp/pi-ide`.
- The directory **must be created 0700** (owner-only). The file is inside that
  directory, so `0600` semantics are implied. Editors that support it should
  also `chmod` the file to `0600`.
- Writes are atomic: write to `<pid>.json.tmp`, then rename.
- The editor deletes its file on clean exit (`VimLeavePre` etc.). Stale files
  from killed editors are tolerated: the pi side checks process liveness via
  `kill(pid, 0)` and ignores dead ones.

## Freshness model

Two different clocks, do not confuse them:

| Field | Meaning | Used for |
|---|---|---|
| `timestamp` | Last time the editor wrote the file (info only) | debugging, last-write insight |
| `selection.selected_at` | When the user last *made* a selection (unix seconds) | freshness: pi injects the selection text only while fresh |

`selected_at` is **not** the write time. The Neovim client sets it to the moment
the user left visual mode (or `now` while still inside visual mode), and keeps
reporting the old marks afterwards. This is what lets the pi side tell "just
selected, meant for this prompt" apart from "selected ten minutes ago, stale
marks" — and never guess from registers.

The pi side defines one window, `SELECTION_FRESH_SECONDS = 60`:

- selection `now - selected_at <= 60s` → **fresh**: injected in full, widget shows `N lines selected in <name>`
- selection older → **stale**: treated as no selection; widget shows only `in <name>`, text is not injected

## Fields

```json
{
  "pid": 12345,
  "cwd": "/Users/andy/my-project",
  "timestamp": 1700000000,
  "app": "nvim",
  "active_buffer": {
    "file": "/Users/andy/my-project/src/main.ts",
    "name": "main.ts",
    "language": "typescript",
    "cursor": { "line": 42, "column": 10 },
    "selection": null,
    "modified": false,
    "lines_total": 200
  }
}
```

| Field | Type | Notes |
|---|---|---|
| `pid` | number | Editor process id; pi checks liveness with `kill(pid, 0)` |
| `cwd` | string | Working directory pi matches against to auto-connect |
| `timestamp` | number | Unix seconds of last write (informational) |
| `app` | string | Editor kind: `"nvim"`, `"vscode"`, `"obsidian"` (future) |
| `argv` | string[] (optional) | Launch args without argv[0], e.g. `["pi-ide-context/"]` from `nvim pi-ide-context/`. Stable per instance — disambiguates same-cwd editors |
| `active_buffer.file` | string \| null | Absolute path; `null` for unnamed buffers |
| `active_buffer.name` | string | Display name (basename for files) |
| `active_buffer.language` | string \| null | `filetype` (nvim) / language id (vscode) |
| `active_buffer.cursor` | `{line, column}` | **1-based** line and **1-based byte** column |
| `active_buffer.selection` | object \| null | See below; `null` when the user has no recent selection |
| `active_buffer.modified` | boolean | Buffer has unsaved changes |
| `active_buffer.lines_total` | number | Line count of the buffer |

`cursor.line`/`cursor.column` may be `null` for hosts without a cursor concept;
clients that always have one (nvim, vscode) write real values.

### selection object

```json
"selection": {
  "start": { "line": 40, "column": 1 },
  "end":   { "line": 45, "column": 20 },
  "text": "selected code...",
  "selected_at": 1700000000
}
```

- `start`/`end` are normalized (start ≤ end, line-wise then column-wise), **1-based inclusive**.
- `text` is the selected lines, joined with `\n`.
- `selected_at`: unix seconds the user last made this selection; `null` if unknown
  (e.g. marks restored from a session, no timestamp available — pi then treats
  it as stale).
- Clients should report the exact column range for single-line selections and
  full lines for multi-line ones. Multi-line `start.column`/`end.column` refer
  to the first/last line edges only.
- Neovim visual-block selections are reported as full lines with approximate
  columns (byte columns of the two anchors).

## Injection semantics (pi side)

On every user prompt, while connected to a live editor with a real file:

- Always inject the lightweight block: file, language, cursor, buffer size/modified.
- Inject the selection text **only when fresh** (see freshness model).
- Stale or absent selection → no selection section at all (matches Claude Code's
  chip disappearing).

## Widget text (pi side)

Pure ASCII, no icons (Nerd Font independence). Truncated by the pi extension if
the name is too long.

| State | Widget |
|---|---|
| Connected, fresh selection | `5 lines selected in main.ts` |
| Connected, no/stale selection | `in main.ts` |
| Editor dead or disconnected | (widget cleared) |

## Multi-editor notes

- One editor instance per pid; several editors may write at once. Pi auto-connects
  only when exactly one live editor matches `cwd`; otherwise it waits for `/ide`.
- **Same-cwd instances** (e.g. `nvim pi-ide-context/` and `nvim pi/` both launched
  from the repo root): `cwd`, git root and explorer root all coincide, so they
  cannot be told apart automatically. The `/ide` picker shows each instance's
  `argv` (launch args — a stable fingerprint) plus how long ago it was active
  (`timestamp`); touch the target editor, then pick the top entry.
- VS Code and Obsidian clients write this same JSON (see `editors/vscode/` and
  `editors/obsidian/`). The pi extension is editor-agnostic — it reads whatever
  editor wrote the file and never asks which one.

## Changelog

- **v0.2** — `app` field; `argv` field (launch args for same-cwd disambiguation);
  `selection.selected_at` + freshness model; columns normalized to 1-based; no
  more register/recency guessing on the client.
- v0.1 — initial file/cursor/selection state (columns 0-based for cursor,
  1-based for selection — inconsistent, fixed in v0.2).

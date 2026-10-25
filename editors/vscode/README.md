# pi-ide-context (VS Code)

Share the file you have open — and the lines you have selected — with
[pi](https://github.com/Andy8647/pi-ide-context), the coding agent in your terminal.
No copy-paste, no `:PiAsk`, no round trip through the clipboard.

This is the editor half. It writes a tiny state file (file, language, cursor,
selection) for the window you attach; the pi extension reads it and puts that
block at the top of your next prompt.

```
you select 6 lines in deep-q-learning.md, switch to the terminal, type "explain this"
pi receives:  File, Language, Cursor, Buffer, and those 6 lines verbatim
```

## Install

1. **This extension** — VS Code Marketplace, or
   `code --install-extension AndyLuo.pi-ide-context-vscode`.
2. **The pi side** — in your terminal:

   ```bash
   pi install npm:pi-ide-context
   ```

   Without it this extension only writes a state file nothing reads.

## Use

1. Open the folder you work in, so the editor reports a useful `cwd`.
2. In pi, run `/ide` and pick this window. It stays connected until you
   `/ide off` or close the window.
3. Ask anything. The context goes along with the prompt; a selection is attached
   in full only while it is fresh (60 seconds), so an old selection never rides
   along by accident.

The same state also feeds the status pill in pi's footer: which editor is
attached, and what language the open file is.

## What it writes, and where

One JSON file per VS Code window under `$XDG_RUNTIME_DIR/pi-ide/` (or `/tmp/pi-ide/`
when that variable is unset), named after the process id:

```json
{ "pid": 4242, "app": "vscode", "cwd": "~/code/app",
  "active_buffer": { "file": "src/main.ts", "language": "typescript",
                     "cursor": { "line": 18, "column": 12 },
                     "selection": { "text": "…", "selected_at": 1761... } } }
```

Nothing leaves the machine: no server, no network, no telemetry. The file is
deleted when the window closes.

## Settings

None. Everything is decided by pi: which window is attached, whether a selection
is fresh, and whether context is injected at all.

## Links

- Everything else (Neovim, Obsidian, the protocol): [Andy8647/pi-ide-context](https://github.com/Andy8647/pi-ide-context)
- Wire format: [docs/protocol.md](https://github.com/Andy8647/pi-ide-context/blob/main/docs/protocol.md)

MIT licensed.

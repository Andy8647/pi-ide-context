# Changelog

What changed in each released version of pi-ide-context, and what you need to do
about it. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and versions follow [semantic versioning](https://semver.org/spec/v2.0.0.html).

The `## [x.y.z]` section for a version is what the publish workflow posts as
that version's [GitHub release](https://github.com/Andy8647/pi-ide-context/releases)
notes, so write it for someone reading the releases page, not for someone reading
the diff. A tag with no section here fails the release before anything reaches npm.

## [0.4.1] - 2026-09-22

Sent messages now show what was selected in the editor when you asked.

### Added

- **Selection quote on your own messages.** When you send a prompt while an
  editor selection is fresh (≤ 60 s — the same freshness rule as context
  injection), the sent message renders a gray quote line inside its own box:
  `│ ↳ main.ts:40-45 · const foo = bar() …`. It rides pi's markdown
  transformer API, so it sits flush inside the message instead of a line below
  it, truncates to the current width, and never touches what the model
  receives. The selection data is persisted as a custom session entry, so the
  quote survives session resume.
- **Compatibility note:** with pi-starline's user-message styling you need
  pi-starline ≥ 0.3.6 — earlier versions bypass pi's markdown transformer
  pipeline entirely and the quote line silently doesn't render.

## [0.4.0] - 2026-09-20

Connecting is now fully manual, and `/ide` no longer decides which editors
"belong" to your project.

### Changed

- **BREAKING: No auto-connect.** Sessions never attach to an editor on their
own anymore — run `/ide` and pick one. Context injection only happens after an
explicit choice, so nothing gets stuffed into your prompts unless you asked for
it.
- **BREAKING: No project matching.** `/ide` lists every live editor (nvim / VS
Code / Obsidian) regardless of where it was started or which file it has open.
The tier-0/tier-1 cwd/file/argv evidence scoring is gone; the list shows each
editor's directory and launch args so you can tell instances apart yourself.
- **A dead editor no longer triggers reconnect logic.** When the connected
editor exits, the session disconnects with a notice; run `/ide` again to pick a
new one.

### Removed

- The project-matching code (`matchTier` and friends), the "No running editor
found in this project" warning, and all auto-discovery in the poller.

## [0.3.1] - 2026-09-18

`/ide` no longer says "no running editor found" when the editor is obviously in
the same project but was started from the directory above it.

### Fixed

- **Match an editor by project, not by exact `cwd`.** `cd ~/Projects && nvim
  my-project/` leaves nvim's `getcwd()` in `~/Projects`, while pi started in
  `my-project` had nothing to match — `/ide` reported "No running editor found in
  this project". The pi side now scores live editors and keeps the best
  non-empty tier: `cwd` equal to pi's (tier 0), or the editor's `cwd`, its active
  file, or a launch-argument directory being inside pi's cwd (tier 1, absolute
  paths only — Obsidian reports a vault-relative file). Tiers never mix, and a
  bare ancestor `cwd` is still not evidence, so `nvim ~/Projects` on a file from
  another project does not claim `~/Projects/x`.
- **The "not found" warning now says where the editors are.** Instead of a dead
  end, it lists live editors in other directories (`nvim (PID 45223,
  /Users/andy/Projects/UNSW)`), which names the mismatch in one line.
- **Neovim client: write state on `DirChanged`.** `:cd` / `:tcd` previously
  depended on a follow-up `CursorMoved` (and its 200 ms debounce) to refresh
  `cwd`; now the file is correct the moment the directory change completes.

### Added

- `npm run test` — `node --test` regression tests for the match rule, wired into
  `npm run verify` (which the publish workflow runs before npm).

### Hardened before release

- **A state file with a missing `active_buffer.file` no longer kills pi.** The
  Neovim client writes `file` as Lua `nil` for an unnamed buffer, so the key is
  *absent* from the JSON — not `null`. The first cut of the match rule tested
  `file !== null`, called `path.isAbsolute(undefined)`, and the throw surfaced as
  an unhandled rejection from the 1 s poll timer, which Node treats as fatal
  (`pi exiting due to uncaughtException`). Fixed twice over: every field the
  match rule reads is now type-checked, and the poll tick is wrapped so a future
  malformed payload cannot take the process down.
- **Neovim client writes explicit JSON `null`** for `active_buffer.file` /
  `language` / `selection` (`vim.NIL`), matching what the protocol documents and
  what the VS Code and Obsidian clients already did.
- `test/fixtures/nvim-unnamed-buffer.json` is a real capture of that payload
  (key absent), excluded from Biome formatting so it stays byte-faithful.

## [0.3.0] - 2026-09-09

The editor status moved into Starline's editor row, `/ide` gained a way out, and
the VS Code and Obsidian clients landed.

### Added

- **VS Code client** (`editors/vscode/`) — writes the same protocol v0.2 JSON
  (`app: "vscode"`, `process.pid`, workspace root as `cwd`, `workspace.name` as
  the `argv` fingerprint). Selection `selected_at` is stamped when the selection
  becomes non-empty; a restored-from-session selection reports `selected_at:
  null` (treated stale, per protocol).
- **Obsidian client** (`editors/obsidian/`) — same JSON (`app: "obsidian"`,
  vault root as `cwd`, vault name as `argv`, vault-relative `file`, CM6
  line/character offsets). Uses `EditorView.updateListener` to stamp
  `selected_at` on non-empty selections (Obsidian's `editor-change` only fires
  on content edits). Cleanup on quit goes through `Workspace.on("quit")` —
  `onunload` is not reliably called on OS quit.
- **Shared client module** (`editors/shared/protocol.ts`) — the editor-agnostic
  schema types + state-file I/O (state dir 0700, atomic tmp-then-rename write,
  removal), now that two editor clients exist. Keeps the two from drifting.
- **Disconnecting is discoverable.** When connected, `/ide` lists a
  `✕ Disconnect` row at the end of the picker, and `/ide ` + Tab completes
  `off`. `/ide off` still works exactly as before — this is only about finding
  it. Disconnecting suppresses auto-connect for the session; new sessions
  reconnect on their own.

### Changed

- **The status line is now an extension status, not a widget.**
  `in main.ts` / `5 lines selected in main.ts` is published through
  `ctx.ui.setStatus("pi-ide", …)` instead of a widget below the editor. Two
  reasons: widgets can only render above or below the editor, and pi-starline
  can place an extension status on the editor's bottom-right metadata row
  (`"extensionStatuses": { "placements": { "pi-ide": "editor" } }`).
  Without Starline the text shows up in Pi's built-in footer status line
  instead of taking a row of its own. No config or protocol change.
- Root `npm run verify` now also typechecks both editor clients; CI builds them.

### Fixed

- **`nvim .` no longer shows up as a bare `.`** in the `/ide` picker. Launch
  arguments that are paths are normalized against the editor's cwd for display:
  `.` and `./` become the directory name, `./src` becomes `src`, and an absolute
  path inside the cwd becomes relative. Flags and plain file names are
  untouched. Display-only — the injected context and the protocol are
  unchanged.

## [0.2.0] - 2026-09-03

Claude Code-style editor context with a real freshness model.

- **Auto-connect** to the single live Neovim instance for the cwd — no manual
  `/ide` needed. `/ide` still lists/picks when there are several, and shows each
  instance's launch args (e.g. `nvim pi/` vs `nvim pi-ide-context/`) so
  same-cwd instances are distinguishable.
- **Injection freshness**: lightweight file/cursor/buffer context is injected on
  every message; selection text only while fresh (within 60s of making it).
  Old selections no longer leak into unrelated prompts.
- **Pure-ASCII widget** — `5 lines selected in main.ts` / `in main.ts`, no Nerd
  Font glyphs. `/ide` picker rows are column-aligned.
- **`/ide off` truly disconnects** (no 1s resurrection). New sessions auto-connect.
- **Protocol v0.2** (`docs/protocol.md`): `app`, `argv`, `selection.selected_at`,
  1-based columns. State dir is created 0700.

**Breaking**

- Protocol schema changed (v0.1 → v0.2): adds fields and normalizes columns to
  1-based. Editor clients must write the new fields; the pi side reads whatever
  is present.
- Only the Neovim client is implemented. VS Code / Obsidian share the protocol
  but have no client yet.

## [0.1.1] - 2026-07-19

Initial release. Select text in Neovim, switch to pi — pi already knows the
file, cursor and selection. `/ide` command, widget, before_agent_start injection.

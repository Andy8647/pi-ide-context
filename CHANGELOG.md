# Changelog

What changed in each released version of pi-ide-context, and what you need to do
about it. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and versions follow [semantic versioning](https://semver.org/spec/v2.0.0.html).

The `## [x.y.z]` section for a version is what the publish workflow posts as
that version's [GitHub release](https://github.com/Andy8647/pi-ide-context/releases)
notes, so write it for someone reading the releases page, not for someone reading
the diff. A tag with no section here fails the release before anything reaches npm.

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

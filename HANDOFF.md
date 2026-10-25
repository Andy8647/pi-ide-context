# Handoff — pi-ide-context

编辑器 ↔ pi 上下文注入（nvim / VS Code / Obsidian 客户端 + pi 扩展）。npm `pi-ide-context`，独立 repo。

当前没有 in-flight 工作。

# 历史

> 迁入自 `fork/pi/AGENTS.md`（2026-10-23），为让 AGENTS.md 不再每 session 加载 74KB 历史。按时间倒序。

## pi-ide-context — 0.2.0 released (2026-09-03)

`pi-ide-context/` is an **independent repo** (`Andy8647/pi-ide-context`, npm `pi-ide-context`),
not part of the pi monorepo. It started as a single-extension repo; it now hosts
the pi extension plus per-editor clients under one roof.

**Released 0.2.0** via a new publish pipeline (ported from pi-starline):
`tag → verify → tag/version + changelog check → OIDC npm publish (with
provenance) → auto GitHub release`. npm `0.2.0` + GitHub release `v0.2.0` are live.

**Protocol v0.2 is the single source of truth for the editor↔pi contract** —
[`pi-ide-context/docs/protocol.md`](pi-ide-context/docs/protocol.md). Read it
before touching any client. Key fields: `app` (`nvim`/`vscode`/`obsidian`),
`argv` (launch args, disambiguates same-cwd instances), `selection.selected_at`
(drives the 60s freshness window — selection text injects only while fresh),
1-based columns.

What 0.2.0 changed (neovim + pi sides): auto-connect to the unique live editor
for the cwd; lightweight file/cursor context injected every prompt, selection
text only while fresh; pure-ASCII widget (`5 lines selected in x.ts` / `in x.ts`);
`/ide off` truly disconnects; `/ide` lists instances by launch argv + activity,
column-aligned; state dir 0700. The old v0.1 register-guessing and the
`/ide off`-resurrects bug are gone.

**VS Code + Obsidian clients landed (2026-09-04, not yet published).** Both write
the v0.2 JSON — the pi extension needed zero changes. Layout: `editors/shared/`
(protocol types + atomic state-file I/O, extracted now that two clients exist),
`editors/vscode/`, `editors/obsidian/`. Real-env verified against VS Code 1.133
and Obsidian in the live vault; build/typecheck wired into `npm run verify` + CI.

Notes that still stand / decisions made:

- **`argv` sources**: VS Code has no launch args and no public window-title API,
  so it uses `vscode.workspace.name`; Obsidian uses `app.vault.getName()`. Same-cwd
  double-open falls back to the `pid` column in `/ide` (always shown).
- **Obsidian has no `file:line:col`**: `file` is vault-relative, cursor/selection
  are CM6 line/character offsets (1-based char column, not byte).
- **Obsidian selection detection** uses `registerEditorExtension(EditorView.
  updateListener)` — `editor-change` only fires on content edits, never on
  selection. This is the one real-environment finding: without the CM6 listener,
  `selected_at` would never update on a plain selection.
- **Obsidian quit cleanup** goes through `Workspace.on("quit")`, not `onunload` —
  `onunload` is *not* called on OS quit (verified with a marker). The `quit`
  event is documented "not guaranteed to run", and the pi side tolerates stale
  files via `kill(pid, 0)`, so cleanup is best-effort.
- **Publish channels still differ**: VS Code → marketplace vsix (still not
  published); Obsidian → community directory (**published 0.1.2, 2026-09-06**).

### Publishing — where the limits are (2026-09-04)

**VS Code** — decided to go **manual vsix upload**, not CI automation. Publisher
id is `AndyLuo` (not `Andy8647`). The limit: **VS Code Marketplace auth is
mid-migration right now** — Azure DevOps global PATs retire **2026-12-01**, and
Microsoft's replacement (Entra ID workload-identity federation) still requires
an Azure subscription + service principal + managed identity, i.e. *not* a
free path for individual publishers. New publishers already report no
"Marketplace" scope in the PAT page (vsmarketplace #1926). So: `npm run package`
(`npx @vscode/vsce package`) produces the vsix, then upload by hand at
marketplace.visualstudio.com/manage. Revisit CI publish only after Microsoft
sorts out the individual-publisher Entra path.

**Obsidian** — no secret, no registry. **The old fork+PR flow is dead**: since
2026-05-12 `obsidianmd/obsidian-releases` has PRs disabled — Obsidian moved to the
**Obsidian Community** dashboard (community.obsidian.md). **Published 2026-09-06
as 0.1.2** (Obsidian account + GitHub link → add repo → automated review →
Publish). The stale `Andy8647/obsidian-releases` fork is deleted.

Hard-won specifics about the new flow (learned by getting it wrong twice):

- **The review reads the release tag's commit, not the branch HEAD.** The 0.1.0
  tag pointed at `598df11` (before the root manifest existed), so it failed with
  "Manifest file not found in repository root" plus a cascade "release with tag
  undefined". Fixing `main` was not enough — the version had to be bumped so the
  *new* tag pointed at a commit carrying the root manifest.
- **`manifest.json` must be at the repo ROOT** (the dashboard ignores
  subdirectories). Monorepo answer: mirror `editors/obsidian/manifest.json` at the
  root and guard drift with a `cmp` check in both `ci.yml` and
  `publish-obsidian.yml` — an obsidian version bump now touches both files or CI
  fails.
- **`authorUrl` must be a personal/org profile, not the plugin's own repo** —
  `https://github.com/Andy8647`, not `.../pi-ide-context`.
- **"Check for new releases"** (dashboard → More actions) is the manual trigger to
  re-scan after pushing a new release; the automatic pickup lags otherwise.
- **Warnings ≠ blockers.** The remaining review output is all Warning/Recommendation:
  `no-unsafe-*` (mostly in `src/index.ts` + `editors/vscode/`, not the plugin),
  "Direct Filesystem Access" (the plugin reads/writes its state file by design),
  and a Recommendation to add GitHub artifact attestations to the release assets
  (nice-to-have; the npm side already has SLSA provenance via trusted publishing).
- **Protocol untouched.** v0.2 already covered both hosts (`app`, nullable
  line/column, `selected_at`); no schema change was needed.


## pi-ide-context 0.4.2 — released 2026-09-22 (Obsidian paths were unreadable)

Andy hit this live: pi read `Career/review/career-review-八股-基础与后端.md`
straight out of the injected `### IDE Context` block, got `ENOENT`, and it took
three failed searches to believe the file wasn't there. It was there the whole
time — in a **different iCloud container**: vault at
`~/Library/Mobile Documents/iCloud~md~obsidian/Documents/Vault`, pi's cwd at
`~/Library/Mobile Documents/com~apple~CloudDocs/Documents/Career/Resume`.

- **Root cause:** Obsidian writes `active_buffer.file` as a vault-relative path
  (protocol v0.2), and `formatContext` injected it verbatim. The model has no
  vault root, so it resolved the path against **pi's cwd**. The matching side has
  had an `isAbsolute` guard since 0.3.1 (so the tier logic never treated a
  vault-relative path as absolute) — the **injection** side was the untouched
  hole. `read` failed loudly; `write`/`edit` would have silently built a shadow
  `Career/review/` tree inside the project dir.
- **Fix:** `absoluteFile()` in `src/index.ts` — resolve a relative `file` against
  `state.cwd` (= vault root for Obsidian; nvim/VS Code are already absolute and
  pass through; non-FileSystemAdapter vaults whose `cwd` is just the vault name
  are left alone rather than guessed at). Protocol unchanged, reader-side only.
- 3 tests in `test/format.test.ts` (vault-relative → resolved; non-absolute cwd →
  untouched; absolute → never rewritten); `docs/protocol.md`'s `active_buffer.file`
  row and injection section now say pi resolves before injecting.
- **Verified end to end against the live state file**, not just fixtures: fed
  `/tmp/pi-ide/32219.json` (real Obsidian, PID 32219) through the **installed**
  published copy — injected path is absolute and `exists: true, 48531 bytes`.
  Note `node` refuses to type-strip under `node_modules`, so the check has to copy
  `src/index.ts` out to a temp `.mts` first.
- Released via tag push (`publish.yml` triggers on `v*.*.*`, unlike pi-toolbox):
  commit `c23cecc` → CI green → tag `v0.4.2` → OIDC publish with SLSA provenance
  → GitHub release. Tarball `diff`ed against the repo (byte-identical). npm's
  version endpoint 404'd for ~75 s after the release job went green — expected.
  Local install already on 0.4.2 (`pi update npm:pi-ide-context` worked; the old
  ERESOLVE zombie problem did not bite this time).
- 0.4.0 (manual-only connect, `/ide` picker) and 0.4.1 (gray selection quote on
  sent messages) were released 2026-09-20/22 without an entry here — the repo
  CHANGELOG is the record for those.


## pi-ide-context 0.3.1 — released 2026-09-18

User-reported: `/ide` said "No running editor found in this project" while nvim was
plainly open in that project. Cause: `cd ~/Projects && nvim my-project/` leaves
nvim's `getcwd()` in the parent, and the pi side compared `cwd` for equality.
Shipped as **0.3.1** (npm + GitHub release `v0.3.1`, provenance attestations).

- **Match tiers** (`src/index.ts`: `matchTier` / `findCandidates`): tier 0 = `cwd`
  equals pi's; tier 1 = the editor's `cwd`, its active file, or an existing `argv`
  directory is inside pi's `cwd`. Tiers never mix, and an ancestor `cwd` alone is
  not evidence, so `nvim ~/Projects` with another project's file cannot claim
  `~/Projects/x`. VS Code / Obsidian are unaffected (their `cwd` is the workspace
  or vault root) — except that Obsidian's `file` is vault-relative, hence the
  `isAbsolute` guard.
- The "not found" warning now lists editors found in **other** directories. That
  one line is what would have replaced this entire debugging session.
- nvim client: also writes on `DirChanged` (`:cd` previously waited for a
  follow-up `CursorMoved` + its 200 ms debounce), and writes explicit JSON `null`
  for `file` / `language` / `selection` via `vim.NIL`.
- **The part worth remembering: a state file can kill pi.** Lua `nil` *drops the
  key*, so an unnamed buffer produces a payload with no `file` field at all —
  `file !== null` let `undefined` reach `path.isAbsolute`, and because the throw
  came from the 1 s poll timer's async function Node treated it as an unhandled
  rejection and exited (`pi exiting due to uncaughtException`). Both halves are
  guarded now (type-check every field read + `.catch()` on the poll tick), and
  `test/fixtures/nvim-unnamed-buffer.json` is a byte-faithful capture of that
  payload. Biome excludes `test/fixtures/` so it stays faithful.
- **Zero-cost real-Pi check** (no API call, no TTY): start the real editor, then
  `cd <project> && pi --mode rpc --no-extensions -e <…>/src/index.ts` and grep
  stdout for `"statusKey":"pi-ide"` / `"method":"notify"`. That is how both the
  fix and the crash were confirmed end to end. Remember the extension loads from
  `~/.pi/agent/npm/node_modules/pi-ide-context/src/index.ts`, so a source edit
  needs a copy there (or `-e`).
- Release order that worked: commit → push `main` → CI green → `git tag v0.3.1`
  → push the tag. npm's packument lagged ~5 minutes; the version endpoint 404ing
  right after a successful `npm publish` is expected, not a failure.
- Andy's installs: `pi update npm:pi-ide-context` → 0.3.1 (the temporary
  hotpatch copy is gone); nvim plugin pulled to `2f65c63` with
  `~/.config/nvim/lazy-lock.json` updated to match.


## pi-ide-context 0.3.0 + pi-starline 0.3.5 — released 2026-09-09

The `in main.ts` line moved off its own row below the editor into Starline's
editor bottom-right hint slot, and both repos shipped.

**Why it needed both sides.** Widgets only render `aboveEditor`/`belowEditor`,
and only their owning extension can clear them; the metadata row is Starline's
to draw. So pi-ide-context stopped using `setWidget` and publishes
`ctx.ui.setStatus("pi-ide", …)` instead, and Starline gained a fourth
`extensionStatuses.placements` value: `"editor"`. Any extension's status can
take that slot, not just pi-ide's.

- **pi-ide-context 0.3.0** (npm + GitHub release `v0.3.0`): `widgetLine` →
  `statusLine`, `setWidget` → `setStatus`, `/ide off` clears it; `/ide` gained
  a `✕ Disconnect` picker row and `off` argument completion; path-ish `argv` is
  normalized for the picker (`nvim .` → directory name, `launchLabel` /
  `resolveLaunchArg`); README screenshot in `assets/demo.png`. No protocol
  change. Also carries the unreleased VS Code + Obsidian clients.
- **pi-starline 0.3.5** (npm + GitHub release `v0.3.5`, via PR #10): `editor`
  placement in config + `/starline` Extension segments cycle, `editor` bucket in
  `collectExtensionStatusSegments`, `composeRightStatus` takes it (order:
  vim mode ⋅ editor status ⋅ hints), statuses getter wired into
  `PolishedEditor`/`WrappedPolishedEditor`. Tests:
  `test/editor-status-row.test.ts` plus additions to
  extension-status/config/extension-compliance.
- **Constraint found:** the status map only reaches Starline through its own
  footer factory, so `editor` placement needs `features.statusLine` **and**
  `features.editor`. Documented in docs/configuration.md + CHANGELOG.
- **Publish-workflow bug fixed on the way:** pi-ide-context's `publish.yml` ran
  `npm run verify` without `npm ci --prefix editors/vscode|obsidian`, so the
  first `v0.3.0` tag died at `typecheck:vscode` (`Cannot find module 'vscode'`)
  before npm. CI had the step; publish did not. Fixed in `e8303ee`, dry run
  green, then the tag was deleted and re-pushed on the fix (Andy authorized;
  nothing had been published under the failed tag).
- **Real-Pi verified** (installed pi 0.85.1, `INSTALLED=1`) with
  `pi-starline/scripts/pty-ide-status-row.py` (untracked): fakes a live nvim
  state file and asserts `in main.ts` sits between the editor borders, that
  `/ide` resolves `nvim .` to the directory name, and that picking Disconnect
  clears the status. Harness gotchas: Pi reports the `/private/var/...`
  realpath, so the state file's `cwd` must be realpath'd; and relative package
  paths in `settings.json` resolve against the agent dir, so a temp agent dir
  needs them absolutized.
- **Andy's config:** `~/.pi/agent/starline.json` has
  `extensionStatuses.placements["pi-ide"] = "editor"`. The chezmoi source
  (`dot_pi/agent/starline.json`) was stale (colors, fixedEditor→mouse
  migration) until re-added 2026-10-07 (dotfiles `005e369`).
- **Local installs:** back on npm — `npm:pi-starline@0.3.5` +
  `npm:pi-ide-context@0.3.1` (0.3.1 as of 2026-09-18). The nvim plugin
  (`~/.local/share/nvim/lazy/pi-ide-context`) is at `2f65c63` (= `v0.3.1`);
  it had been sitting at `01c7631` (protocol v0.1 → `/ide` showed
  `app: undefined`), then at `303a959` until the 0.3.1 release.
  `~/.config/nvim/lazy-lock.json` tracks it.


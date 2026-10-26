# pi-ide-context — JetBrains client

Kotlin plugin for IntelliJ Platform IDEs (WebStorm, PyCharm, IDEA, DataGrip,
GoLand, RubyMine…). It writes the same state file the Neovim, VS Code and
Obsidian clients write — see [`../../docs/protocol.md`](../../docs/protocol.md).
No network, no UI, no settings.

## Build

```fish
cd editors/jetbrains
./gradlew buildPlugin -PlocalIdePath="/Applications/WebStorm.app"   # fast: uses an installed IDE
./gradlew buildPlugin                                               # CI: downloads IntelliJ IDEA CE 2025.2.5
./gradlew test                                                      # protocol JSON shape is pinned here
```

The zip lands in `build/distributions/pi-ide-context-jetbrains-<version>.zip`.

First build needs a JDK 21 toolchain; the foojay resolver downloads one if the
machine has none (~200 MB, once).

`-PlocalIdePath` accepts any JetBrains IDE bundle, which is how you avoid a
~1 GB platform download while iterating. The committed default is
`intellijIdeaCommunity("2025.2.5")` so CI stays hermetic.

## Install (from disk, no Marketplace review)

Settings → Plugins → ⚙ → **Install Plugin from Disk…** → pick the zip → restart
the IDE. Works the same in every JetBrains IDE; `since-build` is `252`
(2025.2, the compile baseline, verified by the CI-default build) with no upper
bound. Lowering it needs `pluginVerifier` runs against the older IDE first.

## Verify it works

With pi running in a terminal and the IDE open on the same project:

```fish
cat /tmp/pi-ide/$(pgrep -f "WebStorm.app")*.json 2>/dev/null
# in pi: /ide
```

The pi status pill should show the JetBrains mark (`U+E808`) plus the file's
language mark. Moving the caret, switching files and selecting text should each
update `timestamp` within ~200 ms.

## Known limitations

- **One file per process.** A single IDE process hosts all open project windows,
  so the last window you touched wins; switching windows updates state on the
  next caret move or file switch. Tracking several windows at once needs a
  multi-instance state file name (protocol v0.3).
- **Selection age after a file switch.** `selection.selected_at` is reset to
  `null` on switch, matching the VS Code client — pi then treats the selection
  as stale and injects only the file/cursor block.
- **Non-local files** (screenshots, remote dev) report `file: null`.
- **DataGrip consoles work, and their path is real.** A console is a plain
  `console.sql` under
  `~/Library/Application Support/JetBrains/DataGrip<ver>/consoles/db/<data-source-uuid>/`,
  kept in sync with the buffer (verified: `modified: false`, file bytes match the
  visible text), so pi can `read` it. The `<uuid>` directory is the data source's
  `uuid` from the project's `.idea/dataSources.local.xml`, which is how the data
  source name could be shown without any `com.intellij.database` dependency.
  Nothing DB-specific is sent today.

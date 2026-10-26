# pi-ide-context — JetBrains client

Kotlin plugin for IntelliJ Platform IDEs (WebStorm, PyCharm, IDEA, DataGrip,
GoLand, RubyMine…). It writes the same state file the Neovim, VS Code and
Obsidian clients write — see [`../../docs/protocol.md`](../../docs/protocol.md).
No network, no UI, no settings.

## Build

```fish
cd editors/jetbrains
# fast local loop: reuse installed IDEs, no download
./gradlew buildPlugin -PlocalIdePath="/Applications/WebStorm.app" \
                      -PlocalDatabaseIde="/Applications/DataGrip.app"
./gradlew buildPlugin    # CI: downloads DataGrip 2026.2.6 for the compile baseline
./gradlew test           # protocol JSON shape is pinned here
```

The zip lands in `build/distributions/pi-ide-context-jetbrains-<version>.zip`.

The compile baseline is **DataGrip**, not IDEA CE, because the optional database
block needs `com.intellij.database` classes at compile time. The plugin still
only *depends* on `com.intellij.modules.platform`: the database descriptor is an
`<depends optional="true" config-file="pi-ide-database.xml">`, so WebStorm /
PyCharm / GoLand never load a `com.intellij.database.*` class.

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

## Database context (DataGrip, IDEA Ultimate)

When the selected editor is a table view, the plugin adds a `database` block to
the state file: table, data source, schema, primary key, columns (name + type),
foreign keys with delete rules, the current filter, and the selected cell's
value. pi turns it into a compact summary — it is a summary, not DDL: 40 columns
max, 10 foreign keys, a 200-character cell value, binary values as `<N bytes>`.

Everything comes from the model the IDE has already introspected, so nothing
waits on a database round trip. The flip side: a table reached only through a
result set may have no `DasTable`, and then only the grid part (name, cell,
filter) is sent.

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

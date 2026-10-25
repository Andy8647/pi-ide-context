/**
 * Nerd Font glyphs for the status pill.
 *
 * The pill is a glance, so it says *what* is attached with a glyph rather than a
 * filename: the editor's own mark when one is connected, then the file's
 * language. Nothing here is required for correctness — a terminal without a
 * Nerd Font shows boxes — but the extension already assumes one for the editor
 * clients' own UI.
 *
 * Codepoints come from Nerd Fonts' glyphnames.json (v3). Every one of them was
 * checked against the cmap of Maple Mono NF and Maple Mono NF CN, because a glyph
 * the font does not carry does not fall back cleanly in a terminal: it renders as
 * a box or as overlapping junk. `custom-obsidian` (U+E6BB) and `cod-vscode`
 * (U+EC29) are in glyphnames but missing from that font, so Obsidian uses a note
 * mark and VS Code uses the devicons mark.
 */

/** Generic "an editor is attached" mark, used while nothing is connected. */
export const IDE_ICON = "\ueae3"; // cod-editor_layout

/** Shown for a file whose language has no glyph of its own. */
export const FILE_ICON = "\uea7b"; // cod-file

/** Editor mark per `app` in the protocol; unknown apps get the generic one. */
const APP_ICONS: Record<string, string> = {
	nvim: "\ue6ae", // custom-neovim
	neovim: "\ue6ae",
	vscode: "\ue8da", // dev-vscode (cod-vscode is absent from Maple Mono NF)
	obsidian: "\ueb26", // cod-note (custom-obsidian is absent too)
};

/** Display names, because `nvim` is not how anyone writes Neovim in a bubble. */
const APP_NAMES: Record<string, string> = {
	nvim: "Neovim",
	neovim: "Neovim",
	vscode: "VS Code",
	obsidian: "Obsidian",
};

const LANGUAGE_ICONS: Record<string, string> = {
	markdown: "\ue73e", // dev-markdown
	typescript: "\ue8ca", // dev-typescript
	typescriptreact: "\ue8ca",
	javascript: "\ue781", // dev-javascript
	javascriptreact: "\ue781",
	json: "\ue80b", // dev-json
	jsonc: "\ue80b",
	python: "\ue73c", // dev-python
	rust: "\ue7a8", // dev-rust
	go: "\ue724", // dev-go
	java: "\ue738", // dev-java
	css: "\ue6b8", // custom-css
	scss: "\ue6b8",
	less: "\ue6b8",
	html: "\ue736", // dev-html5
	yaml: "\ue8eb", // dev-yaml
	yml: "\ue8eb",
	shell: "\ue760", // dev-bash
	bash: "\ue760",
	zsh: "\ue760",
	sh: "\ue760",
	sql: "\ue706", // dev-database
	ruby: "\ue739", // dev-ruby
	c: "\ue771", // dev-c
	cpp: "\ue61d", // custom-cpp
	lua: "\ue826", // dev-lua
	toml: "\ue6b2", // custom-toml
	dockerfile: "\ue7b0", // dev-docker
	xml: "\ue8ea", // dev-xml
	vue: "\ue8dc", // dev-vuejs
	svelte: "\ue8b7", // dev-svelte
	kotlin: "\ue634", // custom-kotlin
	swift: "\ue755", // dev-swift
	php: "\ue73d", // dev-php
	haskell: "\ue777", // dev-haskell
	dart: "\ue798", // dev-dart
};

/** Extension fallback, for clients that report a language the table lacks. */
const EXTENSION_ICONS: Record<string, string> = {
	md: "\ue73e",
	markdown: "\ue73e",
	ts: "\ue8ca",
	tsx: "\ue8ca",
	mts: "\ue8ca",
	cts: "\ue8ca",
	js: "\ue781",
	jsx: "\ue781",
	mjs: "\ue781",
	cjs: "\ue781",
	json: "\ue80b",
	jsonc: "\ue80b",
	py: "\ue73c",
	rs: "\ue7a8",
	go: "\ue724",
	java: "\ue738",
	css: "\ue6b8",
	scss: "\ue6b8",
	less: "\ue6b8",
	html: "\ue736",
	htm: "\ue736",
	yaml: "\ue8eb",
	yml: "\ue8eb",
	sh: "\ue760",
	bash: "\ue760",
	zsh: "\ue760",
	sql: "\ue706",
	rb: "\ue739",
	c: "\ue771",
	h: "\ue771",
	cpp: "\ue61d",
	cc: "\ue61d",
	cxx: "\ue61d",
	hpp: "\ue61d",
	lua: "\ue826",
	toml: "\ue6b2",
	xml: "\ue8ea",
	vue: "\ue8dc",
	svelte: "\ue8b7",
	kt: "\ue634",
	swift: "\ue755",
	php: "\ue73d",
	hs: "\ue777",
	dart: "\ue798",
};

/** The editor's mark; the generic one for anything this build does not know. */
export function appIcon(app: string): string {
	return APP_ICONS[app] ?? IDE_ICON;
}

/** `nvim` → `Neovim`, unknowns passed through as they came. */
export function appName(app: string): string {
	return APP_NAMES[app] ?? app;
}

/**
 * The file's language mark.
 *
 * Language id first, because the clients report it precisely (`typescriptreact`,
 * `dockerfile`); the filename extension second, because Obsidian reports a
 * language but not always one this table has, and nvim's filetype can be empty
 * on a buffer it has not parsed yet.
 */
export function languageIcon(language: string | undefined, file?: string): string {
	const id = (language ?? "").toLowerCase();
	if (id && LANGUAGE_ICONS[id]) return LANGUAGE_ICONS[id];
	const name = (file ?? "").toLowerCase();
	const dot = name.lastIndexOf(".");
	if (dot >= 0) {
		const ext = name.slice(dot + 1);
		if (EXTENSION_ICONS[ext]) return EXTENSION_ICONS[ext];
	}
	// A Dockerfile/Makefile has no extension worth reading.
	if (name.endsWith("dockerfile")) return LANGUAGE_ICONS.dockerfile ?? FILE_ICON;
	return FILE_ICON;
}

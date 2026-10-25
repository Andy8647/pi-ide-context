import assert from "node:assert/strict";
import { test } from "node:test";
import { appIcon, appName, FILE_ICON, IDE_ICON, languageIcon } from "../src/icons.ts";

// Codepoints are pinned here rather than compared against the module's own
// tables: a wrong glyph renders as a box, and nothing else would catch it.
const GLYPHS = {
	neovim: "\ue6ae",
	vscode: "\ue8da",
	obsidian: "\ueb26",
	genericIde: "\ueae3",
	typescript: "\ue8ca",
	markdown: "\ue73e",
	python: "\ue73c",
	file: "\uea7b",
};

test("each known editor has its own mark", () => {
	assert.equal(appIcon("nvim"), GLYPHS.neovim);
	assert.equal(appIcon("vscode"), GLYPHS.vscode);
	assert.equal(appIcon("obsidian"), GLYPHS.obsidian);
});

test("an unknown editor still gets a mark, so the pill is never blank", () => {
	assert.equal(appIcon("emacs"), GLYPHS.genericIde);
	assert.equal(appIcon(""), GLYPHS.genericIde);
});

test("display names read as products", () => {
	assert.equal(appName("nvim"), "Neovim");
	assert.equal(appName("vscode"), "VS Code");
	assert.equal(appName("obsidian"), "Obsidian");
	assert.equal(appName("emacs"), "emacs");
});

test("the language id wins over the filename", () => {
	assert.equal(languageIcon("typescript", "/tmp/main.ts"), GLYPHS.typescript);
	assert.equal(languageIcon("markdown", "/tmp/notes.txt"), GLYPHS.markdown);
});

test("the extension is the fallback when the language is unknown or missing", () => {
	assert.equal(languageIcon("plaintext", "/tmp/app.py"), GLYPHS.python);
	assert.equal(languageIcon(undefined, "/tmp/README.md"), GLYPHS.markdown);
});

test("a file with no known language falls back to a generic file mark", () => {
	assert.equal(languageIcon("plaintext", "/tmp/notes.zzz"), GLYPHS.file);
	assert.equal(languageIcon(undefined), GLYPHS.file);
	assert.notEqual(FILE_ICON, IDE_ICON);
	assert.equal(FILE_ICON, GLYPHS.file);
});

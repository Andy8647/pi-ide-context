import assert from "node:assert/strict";
import { test } from "node:test";
import { appIcon, appName, FILE_ICON, IDE_ICON, languageIcon } from "../src/icons.ts";

// Codepoints are pinned here rather than compared against the module's own
// tables: a wrong glyph renders as a box, and nothing else would catch it.
const GLYPHS = {
	neovim: "\ue6ae",
	vscode: "\uec29",
	obsidian: "\ue6bb",
	jetbrains: "\ue808", // dev-jetbrains, present in Maple Mono NF CN v8
	webstorm: "\ue8e4", // dev-webstorm, same family
	genericIde: "\ueae3",
	typescript: "\ue8ca",
	markdown: "\ue73e",
	python: "\ue73c",
	tex: "\ue69b", // seti-tex, present in Maple Mono NF CN v8
	file: "\uea7b",
};

test("each known editor has its own mark", () => {
	assert.equal(appIcon("nvim"), GLYPHS.neovim);
	assert.equal(appIcon("vscode"), GLYPHS.vscode);
	assert.equal(appIcon("obsidian"), GLYPHS.obsidian);
	assert.equal(appIcon("jetbrains"), GLYPHS.jetbrains);
});

test("an unknown editor still gets a mark, so the pill is never blank", () => {
	assert.equal(appIcon("emacs"), GLYPHS.genericIde);
	assert.equal(appIcon(""), GLYPHS.genericIde);
});

test("display names read as products", () => {
	assert.equal(appName("nvim"), "Neovim");
	assert.equal(appName("vscode"), "VS Code");
	assert.equal(appName("obsidian"), "Obsidian");
	assert.equal(appName("jetbrains"), "JetBrains");
	assert.equal(appName("emacs"), "emacs");
});

test("a product wins over its app, both for the mark and the name", () => {
	// 四个 JetBrains IDE 都报 app: "jetbrains",不区分就全叫 jetbrains。
	assert.equal(appIcon("jetbrains", "WebStorm"), GLYPHS.webstorm);
	assert.equal(appName("jetbrains", "WebStorm"), "WebStorm");
	assert.equal(appIcon("jetbrains", "DataGrip"), "\ue7bd");
	assert.equal(appIcon("jetbrains", "PyCharm"), "\ue877");
	assert.equal(appIcon("jetbrains", "IntelliJ IDEA"), "\ue7b5");
});

test("a product name with a version or two words still resolves", () => {
	assert.equal(appIcon("jetbrains", "WebStorm 2026.2.3"), GLYPHS.webstorm);
	assert.equal(appIcon("jetbrains", "Android Studio 2026.1"), "\ue71a");
});

test("an unknown product falls back to the app's mark", () => {
	assert.equal(appIcon("jetbrains", "Fleet"), GLYPHS.jetbrains);
	assert.equal(appIcon("jetbrains", ""), GLYPHS.jetbrains);
});

test("the language id wins over the filename", () => {
	assert.equal(languageIcon("typescript", "/tmp/main.ts"), GLYPHS.typescript);
	assert.equal(languageIcon("markdown", "/tmp/notes.txt"), GLYPHS.markdown);
});

test("the extension is the fallback when the language is unknown or missing", () => {
	assert.equal(languageIcon("plaintext", "/tmp/app.py"), GLYPHS.python);
	assert.equal(languageIcon(undefined, "/tmp/README.md"), GLYPHS.markdown);
});

test("TeX, LaTeX and BibTeX language ids use the TeX mark", () => {
	for (const language of ["tex", "latex", "plaintex", "bibtex", "LaTeX"]) {
		assert.equal(languageIcon(language), GLYPHS.tex, language);
	}
	assert.equal(languageIcon("latex", "/tmp/notes.py"), GLYPHS.tex);
	assert.equal(languageIcon("python", "/tmp/notes.tex"), GLYPHS.python);
});

test("LaTeX source, bibliography, style and class extensions use the TeX mark", () => {
	for (const ext of ["tex", "ltx", "bib", "sty", "cls", "bst", "TEX", "BIB"]) {
		for (const language of [undefined, "", "plaintext"]) {
			assert.equal(languageIcon(language, `/tmp/notes.${ext}`), GLYPHS.tex, ext);
		}
	}
});

test("LaTeX build artifacts keep the generic file mark", () => {
	for (const ext of ["aux", "log", "toc", "pdf"]) {
		assert.equal(languageIcon(undefined, `/tmp/notes.${ext}`), GLYPHS.file, ext);
	}
});

test("a file with no known language falls back to a generic file mark", () => {
	assert.equal(languageIcon("plaintext", "/tmp/notes.zzz"), GLYPHS.file);
	assert.equal(languageIcon(undefined), GLYPHS.file);
	assert.notEqual(FILE_ICON, IDE_ICON);
	assert.equal(FILE_ICON, GLYPHS.file);
});

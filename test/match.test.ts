/**
 * 项目匹配规则的回归测试 —— 对应 nvim 的经典坑:
 *   cd ~/Projects && nvim my-project/     # 在子目录开着 nvim,pi 也在子目录里
 *   cd ~/Projects/my-project && pi
 * nvim 的 getcwd() 停在父目录,旧实现要求 cwd 逐字相等,于是 pi 永远找不到它。
 *
 * 运行:node --test test/match.test.ts(经 `npm run verify` 跑)
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { isInside, matchTier, noEditorWarning } from "../src/index.ts";

type State = Parameters<typeof matchTier>[0];

let root: string;
let project: string;
let sibling: string;

before(() => {
	root = mkdtempSync(join(tmpdir(), "pi-ide-match-"));
	project = join(root, "my-project");
	sibling = join(root, "other-project");
	mkdirSync(join(project, "src"), { recursive: true });
	mkdirSync(sibling, { recursive: true });
	writeFileSync(join(project, "src", "main.ts"), "// x\n");
});

after(() => {
	rmSync(root, { recursive: true, force: true });
});

function state(over: Partial<State> & { cwd: string }): State {
	return {
		pid: 1,
		timestamp: 0,
		app: "nvim",
		active_buffer: {
			file: null,
			name: "[No Name]",
			language: null,
			cursor: null,
			selection: null,
			modified: false,
			lines_total: 1,
		},
		...over,
	};
}

describe("isInside", () => {
	it("accepts strict descendants", () => {
		assert.equal(isInside("/a/b/c", "/a/b"), true);
	});

	it("rejects the directory itself", () => {
		assert.equal(isInside("/a/b", "/a/b"), false);
	});

	it("rejects siblings sharing a name prefix", () => {
		assert.equal(isInside("/a/bc", "/a/b"), false);
	});

	it("rejects ancestors and unrelated paths", () => {
		assert.equal(isInside("/a", "/a/b"), false);
		assert.equal(isInside("/x/y", "/a/b"), false);
	});

	it("ignores a trailing slash on the parent", () => {
		assert.equal(isInside("/a/b/c", "/a/b/"), true);
	});
});

describe("real client payloads", () => {
	/**
	 * 真实 nvim 写的状态文件(lazy checkout、无打开的 buffer)。刻意不重新格式化、不补
	 * 字段:被测试的就是这个形状的 payload,靠的是原样字节。biome 排除了 test/fixtures。
	 */
	function realState(): State {
		const raw = readFileSync(
			new URL("./fixtures/nvim-unnamed-buffer.json", import.meta.url),
			"utf-8",
		);
		return JSON.parse(raw) as State;
	}

	it("the fixture really is missing the file key", () => {
		// 如果哪天 fixture 被改成 file: null,这个用例就失去了意义
		assert.equal(Object.hasOwn(realState().active_buffer, "file"), false);
	});

	it("tolerates an absent active_buffer.file", () => {
		const s = realState();
		assert.doesNotThrow(() => matchTier(s, "/nonexistent-pi-cwd"));
		assert.equal(matchTier(s, "/nonexistent-pi-cwd"), null);
		assert.equal(matchTier({ ...s, cwd: project }, project), 0);
	});

	it("still matches by launch argument when no file is open", () => {
		// 同一个 payload,但 nvim 就停在项目目录上:argv 是唯一的证据
		const s = realState();
		assert.equal(matchTier({ ...s, cwd: root, argv: ["my-project/"] }, project), 1);
	});

	it("returns null instead of throwing on garbage", () => {
		const bad = [null, 3, "x", {}, { cwd: 42 }, { cwd: project, active_buffer: undefined }];
		for (const s of bad) {
			assert.doesNotThrow(() => matchTier(s as unknown as State, project));
		}
		assert.equal(matchTier({ cwd: project, active_buffer: {} } as unknown as State, project), 0);
	});
});

describe("noEditorWarning", () => {
	it("names the cwd pi searched and points at the editor's project", () => {
		const msg = noEditorWarning(project, [state({ cwd: root, app: "nvim" })]);
		assert.match(msg, /No running editor found in this project \(\/.*my-project\)\./);
		assert.match(msg, /1 editor running elsewhere: nvim \(PID 1, \/.*\)/);
	});

	it("pluralizes and lists every foreign editor", () => {
		const msg = noEditorWarning(project, [
			state({ cwd: root }),
			state({ cwd: sibling, pid: 2, app: "vscode" }),
		]);
		assert.match(msg, /2 editors running elsewhere: nvim \(PID 1, .*\), vscode \(PID 2, .*\)/);
	});

	it("falls back to the plain hint when no editor is running at all", () => {
		const msg = noEditorWarning(project, []);
		assert.match(msg, /Make sure Neovim with pi-ide is running in this project\./);
	});
});

describe("matchTier", () => {
	it("tier 0 when the editor cwd is exactly the project", () => {
		assert.equal(matchTier(state({ cwd: project }), project), 0);
	});

	it("tier 0 also with a trailing slash on either side", () => {
		assert.equal(matchTier(state({ cwd: `${project}/` }), project), 0);
	});

	it("tier 1 when the editor sits in a subdirectory of the project", () => {
		assert.equal(matchTier(state({ cwd: join(project, "src") }), project), 1);
	});

	it("tier 1 for `nvim my-project/` launched from the parent (active file)", () => {
		const s = state({
			cwd: root,
			active_buffer: {
				file: join(project, "src", "main.ts"),
				name: "main.ts",
				language: "typescript",
				cursor: { line: 1, column: 1 },
				selection: null,
				modified: false,
				lines_total: 1,
			},
		});
		assert.equal(matchTier(s, project), 1);
	});

	it("tier 1 for `nvim my-project/` launched from the parent (netrw, no file)", () => {
		assert.equal(matchTier(state({ cwd: root, argv: ["my-project/"] }), project), 1);
	});

	it("tier 1 when argv points at the project via an absolute path", () => {
		assert.equal(matchTier(state({ cwd: root, argv: [project] }), project), 1);
	});

	it("ignores argv entries that are not existing directories", () => {
		// vscode/obsidian write a workspace/vault *name*, nvim may hold plain file
		// names — neither points at a real directory here
		assert.equal(
			matchTier(state({ cwd: sibling, argv: ["my-project", "notes.md"] }), project),
			null,
		);
	});

	it("does not match when argv points at an ancestor of the project", () => {
		// `nvim ~/Projects/` from somewhere else must not claim every project under it
		assert.equal(matchTier(state({ cwd: sibling, argv: [root] }), project), null);
	});

	it("no match for an editor parked in the shared parent directory", () => {
		// `nvim ~/Projects` with a file from another project must not auto-connect
		const s = state({
			cwd: root,
			active_buffer: {
				file: join(sibling, "index.ts"),
				name: "index.ts",
				language: "typescript",
				cursor: null,
				selection: null,
				modified: false,
				lines_total: 1,
			},
		});
		assert.equal(matchTier(s, project), null);
	});

	it("no match for a sibling project", () => {
		assert.equal(matchTier(state({ cwd: sibling }), project), null);
	});

	it("ignores non-absolute buffer paths (obsidian reports vault-relative)", () => {
		const s = state({
			cwd: root,
			active_buffer: {
				file: "my-project/src/main.ts",
				name: "main.ts",
				language: "typescript",
				cursor: null,
				selection: null,
				modified: false,
				lines_total: 1,
			},
		});
		assert.equal(matchTier(s, project), null);
	});
});

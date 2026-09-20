/**
 * 状态行 / 注入上下文 / 展示工具的回归测试。
 * v0.4 起不再有项目匹配逻辑,这里只覆盖留下的纯函数:
 *   - statusLine:新鲜选区 vs 普通 buffer;无名 buffer 不占状态行
 *   - formatContext:轻量块必带,selection 文本只在新鲜时附上,超长截断
 *   - relTime / shortDir:展示格式
 *
 * 运行:node --test test/*.test.ts(经 `npm run verify` 跑)
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
	dispWidth,
	formatContext,
	pickerRows,
	relTime,
	shortDir,
	statusLine,
} from "../src/index.ts";

type State = Parameters<typeof statusLine>[0];

const NOW = 1_800_000_000;

function state(over: {
	file?: string | null;
	name?: string;
	selection?: {
		text: string;
		selected_at: number | null;
		startLine?: number;
		endLine?: number;
	} | null;
}): State {
	const sel = over.selection;
	return {
		pid: 1,
		cwd: "/tmp/proj",
		timestamp: NOW,
		app: "nvim",
		active_buffer: {
			file: over.file === undefined ? "/tmp/proj/main.ts" : over.file,
			name: over.name ?? "main.ts",
			language: "typescript",
			cursor: { line: 42, column: 10 },
			selection: sel
				? {
						start: { line: sel.startLine ?? 40, column: 1 },
						end: { line: sel.endLine ?? 45, column: 1 },
						text: sel.text,
						selected_at: sel.selected_at,
					}
				: null,
			modified: false,
			lines_total: 200,
		},
	};
}

describe("statusLine", () => {
	it("plain buffer shows `in <name>`", () => {
		assert.equal(statusLine(state({})), "in main.ts");
	});

	it("fresh selection shows line count", () => {
		// statusLine 内部用真实当前时间,选区时间戳必须相对 Date.now() 构造
		const s = state({
			selection: { text: "x", selected_at: Date.now() / 1000 - 10, startLine: 40, endLine: 45 },
		});
		assert.equal(statusLine(s), "6 lines selected in main.ts");
	});

	it("stale selection falls back to `in <name>`", () => {
		const s = state({ selection: { text: "x", selected_at: Date.now() / 1000 - 3600 } });
		assert.equal(statusLine(s), "in main.ts");
	});

	it("null selected_at counts as stale", () => {
		const s = state({ selection: { text: "x", selected_at: null } });
		assert.equal(statusLine(s), "in main.ts");
	});

	it("unnamed buffer (no file key at all) takes no status line", () => {
		// nvim 客户端的 nil 会让 file 整个 key 消失,不是 null
		const raw = JSON.parse(
			readFileSync(join(import.meta.dirname, "fixtures", "nvim-unnamed-buffer.json"), "utf-8"),
		);
		assert.equal(statusLine(raw), null);
	});
});

describe("formatContext", () => {
	it("always includes the lightweight block", () => {
		const out = formatContext(state({}), NOW);
		assert.match(out, /### IDE Context/);
		assert.match(out, /\*\*File\*\*: `\/tmp\/proj\/main\.ts`/);
		assert.match(out, /\*\*Cursor\*\*: line 42, column 10/);
		assert.match(out, /\*\*Buffer\*\*: 200 lines/);
	});

	it("fresh selection embeds its text with a fence", () => {
		const out = formatContext(
			state({ selection: { text: "const a = 1;", selected_at: NOW - 5 } }),
			NOW,
		);
		assert.match(out, /\*\*Selection\*\*: lines 40-45/);
		assert.match(out, /```typescript\nconst a = 1;\n```/);
	});

	it("stale selection injects no text", () => {
		const out = formatContext(
			state({ selection: { text: "secret", selected_at: NOW - 120 } }),
			NOW,
		);
		assert.ok(!out.includes("Selection"));
		assert.ok(!out.includes("secret"));
	});

	it("selection over 2000 chars is truncated", () => {
		const out = formatContext(
			state({ selection: { text: "y".repeat(5000), selected_at: NOW - 5 } }),
			NOW,
		);
		assert.match(out, /\.\.\. \(truncated\)/);
		assert.ok(out.length < 3000);
	});
});

describe("relTime", () => {
	it("formats age buckets", () => {
		assert.equal(relTime(NOW - 2, NOW), "just now");
		assert.equal(relTime(NOW - 30, NOW), "30s ago");
		assert.equal(relTime(NOW - 300, NOW), "5m ago");
		assert.equal(relTime(NOW - 7200, NOW), "2h ago");
	});

	it("clamps future timestamps to just now", () => {
		assert.equal(relTime(NOW + 100, NOW), "just now");
	});
});

describe("pickerRows", () => {
	type Live = Parameters<typeof pickerRows>[0][number];
	const mk = (app: string, pid: number, cwd: string, name: string): Live => ({
		pid,
		cwd,
		timestamp: NOW,
		app,
		argv: [],
		active_buffer: {
			file: `${cwd}/x`,
			name,
			language: null,
			cursor: null,
			selection: null,
			modified: false,
			lines_total: 1,
		},
	});

	const live: Live[] = [
		mk("vscode", 1696, "/tmp/proj", "[No File]"),
		mk("nvim", 432, "/tmp/proj", "[No Name]"),
		mk(
			"obsidian",
			333,
			"/Users/andy/Library/Mobile Documents/iCloud~md~obsidian/Documents/Vault",
			"笔记-模型.md", // CJK 文件名:对齐必须按显示宽度而非 string.length
		),
	];

	/** 每行 relTime 列之前部分的显示宽度(relTime 是最后一列,宽度允许不同) */
	const prefixWidths = (rows: string[]) =>
		rows.map((r, i) => dispWidth(r) - dispWidth(relTime(live[i].timestamp, NOW)));

	it("every row has the same display width up to the activity column", () => {
		const rows = pickerRows(live, null);
		assert.equal(rows.length, 3);
		const ws = prefixWidths(rows);
		assert.ok(
			ws.every((w) => w === ws[0]),
			`misaligned: ${ws}`,
		);
	});

	it("the connected marker keeps alignment", () => {
		const rows = pickerRows(live, 432);
		assert.ok(rows[1].startsWith("✓ "));
		assert.ok(rows[0].startsWith("  "));
		const ws = prefixWidths(rows);
		assert.ok(
			ws.every((w) => w === ws[0]),
			`misaligned: ${ws}`,
		);
	});
});

describe("shortDir", () => {
	it("collapses $HOME to ~", () => {
		const home = process.env.HOME;
		assert.ok(home, "HOME must be set for this test");
		assert.equal(shortDir(join(home, "Projects", "fork")), "~/Projects/fork");
	});

	it("keeps the tail of over-long paths", () => {
		const long = `/Users/andy/Library/Mobile Documents/iCloud~md~obsidian/Documents/Vault`;
		const s = shortDir(long, 40);
		assert.ok(s.startsWith("…"));
		assert.ok(s.endsWith("Vault"));
	});

	it("leaves short non-home paths alone", () => {
		assert.equal(shortDir("/tmp/proj"), "/tmp/proj");
	});
});

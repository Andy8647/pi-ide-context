import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { EditorState, Selection } from "../src/index.ts";
import { bubbleContent, type PillDeps } from "../src/starline-pill.ts";

const ctx = {} as ExtensionContext;

function editor(overrides: Partial<EditorState> = {}): EditorState {
	return {
		pid: 100,
		cwd: "/Users/andy/proj",
		timestamp: 1_700_000_000,
		app: "nvim",
		...overrides,
		active_buffer: {
			file: "/Users/andy/proj/main.ts",
			name: "main.ts",
			language: "typescript",
			cursor: { line: 42, column: 10 },
			selection: null,
			modified: false,
			lines_total: 200,
			...overrides.active_buffer,
		},
	};
}

function selection(): Selection {
	return {
		start: { line: 42, column: 1 },
		end: { line: 44, column: 9 },
		text: "abc",
		selected_at: 1_700_000_000,
	};
}

function deps(overrides: Partial<PillDeps> = {}): PillDeps {
	return {
		connectedPid: () => null,
		readState: async () => null,
		scanLiveStates: async () => [],
		isFreshSelection: () => true,
		selectedLineCount: () => 3,
		connect: () => {},
		disconnect: () => {},
		openPicker: () => {},
		snapshot: () => ({ state: null, live: [] }),
		...overrides,
	};
}

function targets(body: ReturnType<typeof bubbleContent>["body"]) {
	return body.filter(
		(line): line is { text: string; onSelect: () => void } =>
			typeof line !== "string" && typeof line.onSelect === "function",
	);
}

const NVIM = "\ue6ae";
const VSCODE = "\uec29";

test("one row carries the editor, directory, file, cursor and selection", () => {
	const state = editor({ active_buffer: { ...editor().active_buffer, selection: selection() } });
	const content = bubbleContent(state, [state], state.pid, deps(), ctx);

	assert.equal(content.title, "IDE · main.ts");
	// Everything fits at this width: no fact has to be dropped, only padded so the
	// separators line up with the other rows.
	assert.equal(
		content.body[0],
		`\u25cf ${NVIM} Neovim · proj · main.ts · line 42:10 · 3 lines selected`,
	);
	assert.equal(targets(content.body)[0]?.text, "\u2715 Disconnect");
});

test("keeps the directory while the row fits", () => {
	const content = bubbleContent(editor(), [editor()], 100, deps(), ctx);

	assert.equal(content.body[0], `\u25cf ${NVIM} Neovim · proj · main.ts · line 42:10`);
});

test("stays inside one bubble line even for a deep path and a long name", () => {
	const deep = editor({
		cwd: "/Users/andy/Library/Mobile Documents/iCloud~md~obsidian/Documents/Vault/UNSW/wiki",
		active_buffer: {
			...editor().active_buffer,
			name: "deep-q-learning-and-a-very-long-note-name.md",
			selection: selection(),
		},
	});
	const content = bubbleContent(deep, [deep], deep.pid, deps(), ctx);
	const row = String(content.body[0]);

	assert.ok([...row].length <= 62, `row is ${[...row].length} columns: ${row}`);
	// The filename is clipped from the left and the editor's name survives: it is the
	// one fact the row cannot lose.
	assert.ok(row.includes("Neovim"));
	assert.ok(row.endsWith(".md"), row);
	assert.ok(row.includes("\u2026"), row);
});

test("drops a stale selection", () => {
	const state = editor({ active_buffer: { ...editor().active_buffer, selection: selection() } });
	const content = bubbleContent(
		state,
		[state],
		state.pid,
		deps({ isFreshSelection: () => false }),
		ctx,
	);

	assert.ok(!content.body.some((line) => typeof line === "string" && line.includes("selected")));
});

test("one app, several products: the bubble names the product, not the vendor", () => {
	const connected = editor({ app: "jetbrains", product: "WebStorm" });
	const other = editor({
		pid: 200,
		cwd: "/Users/andy/other",
		app: "jetbrains",
		product: "DataGrip",
	});
	const content = bubbleContent(connected, [connected, other], connected.pid, deps(), ctx);

	assert.equal(content.body[0], `\u25cf \ue8e4 WebStorm · proj  · main.ts · line 42:10`);
	const row = targets(content.body).find((line) => line.text.startsWith("\u25b8"));
	assert.equal(row?.text, `\u25b8 \ue7bd DataGrip · other · main.ts`);
});

test("a bubble lists every live editor, and only caps itself past a dozen", () => {
	// /ide 会列出全部;气泡也没有高度预算,所以常见规模下就该全列。
	const connected = editor();
	const sevenOthers = Array.from({ length: 7 }, (_, i) =>
		editor({ pid: 200 + i, cwd: `/Users/andy/p${i}`, timestamp: 1_700_000_000 - i }),
	);
	const content = bubbleContent(connected, [connected, ...sevenOthers], connected.pid, deps(), ctx);

	const rows = targets(content.body).filter((line) => line.text.startsWith("\u25b8"));
	assert.equal(rows.length, 7);
	assert.ok(
		!content.body.some((line) =>
			String(typeof line === "string" ? line : line.text).includes("more"),
		),
	);
});

test("past a dozen, the bubble says how many it hid and opens the picker", () => {
	const connected = editor();
	const fifteenOthers = Array.from({ length: 15 }, (_, i) =>
		editor({ pid: 300 + i, cwd: `/Users/andy/q${i}`, timestamp: 1_700_000_000 - i }),
	);
	let opened = 0;
	const content = bubbleContent(
		connected,
		[connected, ...fifteenOthers],
		connected.pid,
		deps({ openPicker: () => opened++ }),
		ctx,
	);

	const switchRows = targets(content.body).filter((line) => line.text.startsWith("\u25b8"));
	assert.equal(switchRows.length, 13); // 12 editors + the overflow row
	assert.equal(switchRows.at(-1)?.text, "\u25b8 \u2026and 3 more \u00b7 /ide");

	switchRows.at(-1)?.onSelect();
	assert.equal(opened, 1);
});

test("lists other live editors as switch targets, with their own marks", () => {
	const connected = editor();
	const other = editor({ pid: 200, cwd: "/Users/andy/other", app: "vscode" });
	const connectedTo: number[] = [];
	const content = bubbleContent(
		connected,
		[connected, other],
		connected.pid,
		deps({ connect: (_ctx, state) => connectedTo.push(state.pid) }),
		ctx,
	);

	const row = targets(content.body).find((line) => line.text.startsWith("\u25b8"));
	assert.ok(row, "expected a switch row");
	// 两行同列对齐:编辑器名列吃到 "VS Code" 的宽度,目录列吃到 "other" 的宽度。
	assert.equal(row.text, `\u25b8 ${VSCODE} VS Code · other · main.ts`);
	assert.equal(content.body[0], `\u25cf ${NVIM} Neovim  · proj  · main.ts · line 42:10`);
	row.onSelect();
	assert.deepEqual(connectedTo, [200]);
});

test("offers a disconnect row only while connected", () => {
	const connected = bubbleContent(editor(), [], 100, deps(), ctx);
	assert.ok(targets(connected.body).some((line) => line.text === "\u2715 Disconnect"));

	const idle = bubbleContent(null, [], null, deps(), ctx);
	assert.equal(idle.title, "IDE context");
	assert.deepEqual(idle.body, ["no editor running · start one, then /ide"]);
});

test("an unnamed buffer still names the editor", () => {
	const state = editor({
		active_buffer: { ...editor().active_buffer, file: null, name: "[No Name]", language: null },
	});
	const content = bubbleContent(state, [state], state.pid, deps(), ctx);

	assert.equal(content.body[0], `\u25cf ${NVIM} Neovim · proj · [No Name] · line 42:10`);
});

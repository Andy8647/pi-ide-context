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
		shortDir: (path) => path.replace("/Users/andy", "~"),
		isFreshSelection: () => true,
		selectedLineCount: () => 3,
		connect: () => {},
		disconnect: () => {},
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
const TS = "\ue8ca";

test("describes the connected buffer, cursor and fresh selection in one row", () => {
	const state = editor({ active_buffer: { ...editor().active_buffer, selection: selection() } });
	const content = bubbleContent(state, [state], state.pid, deps(), ctx);

	assert.equal(content.title, "IDE · main.ts");
	assert.equal(
		content.body[0],
		`\u25cf ${NVIM} Neovim · ~/proj · main.ts · line 42:10 · 3 lines selected`,
	);
	assert.equal(targets(content.body)[0]?.text, "\u2715 Disconnect");
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
	assert.equal(row.text, `\u25b8 ${VSCODE} VS Code · ~/other · main.ts`);
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

	assert.equal(content.body[0], `\u25cf ${NVIM} Neovim · ~/proj · [No Name] · line 42:10`);
});

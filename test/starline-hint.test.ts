/**
 * Starline 编辑器顶栏那句中转:
 *   - 文案:行数 + buffer 名;行数不可知时退成 "selection in x"
 *   - 去重:同样的内容不重复推,否则每秒一次轮询都会让宿主重绘
 *   - 没装 starline(globalThis 上没有 API)时全程 no-op
 */

import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import type { EditorState } from "../src/index.ts";
import {
	clearSelectionHint,
	HINT_KEY,
	publishSelectionHint,
	selectionHintText,
} from "../src/starline-hint.ts";

const HINT_SYMBOL = Symbol.for("pi-starline.editor-hint-api.v1");

/** 和 pill 同一套字形:`nvim` 标记 + typescript 标记 */
const NVIM = "\ue6ae";
const TS = "\ue8ca";

function state(over: { name?: string; app?: string } = {}): EditorState {
	return {
		pid: 1,
		cwd: "/tmp/proj",
		timestamp: 1_800_000_000,
		app: over.app ?? "nvim",
		active_buffer: {
			file: "/tmp/proj/packages/shared/src/patient.ts",
			name: over.name ?? "patient.ts",
			language: "typescript",
			cursor: { line: 80, column: 13 },
			selection: null,
			modified: false,
			lines_total: 84,
		},
	};
}

type Recorded = Array<[string, string | null]>;

/** 冒充 starline 发布的那套 API,记录每次调用 */
function installApi(): Recorded {
	const calls: Recorded = [];
	(globalThis as Record<symbol, unknown>)[HINT_SYMBOL] = {
		version: 1,
		setHint: (key: string, text: string | null) => {
			calls.push([key, text]);
		},
	};
	return calls;
}

afterEach(() => {
	delete (globalThis as Record<symbol, unknown>)[HINT_SYMBOL];
	clearSelectionHint();
});

describe("selectionHintText", () => {
	it("leads with the editor and language marks the pill uses", () => {
		assert.equal(selectionHintText(state(), 5), `${NVIM} ${TS} 5 lines selected in patient.ts`);
	});

	it("names the buffer, not the whole path", () => {
		assert.doesNotMatch(selectionHintText(state(), 5) ?? "", /packages\/shared/);
	});

	it("says line, not lines", () => {
		assert.equal(selectionHintText(state(), 1), `${NVIM} ${TS} 1 line selected in patient.ts`);
	});

	it("falls back when the client reports no line numbers", () => {
		assert.equal(selectionHintText(state(), null), `${NVIM} ${TS} selection in patient.ts`);
	});

	it("says nothing for an empty range", () => {
		assert.equal(selectionHintText(state(), 0), null);
	});
});

describe("publishSelectionHint", () => {
	it("is a no-op without starline", () => {
		assert.doesNotThrow(() => publishSelectionHint("5 lines selected in patient.ts"));
	});

	it("publishes under the same key the status line uses", () => {
		const calls = installApi();
		publishSelectionHint("5 lines selected in patient.ts");
		assert.deepEqual(calls, [[HINT_KEY, "5 lines selected in patient.ts"]]);
	});

	it("does not repeat itself: the poll runs every second", () => {
		const calls = installApi();
		publishSelectionHint("5 lines selected in patient.ts");
		publishSelectionHint("5 lines selected in patient.ts");
		assert.equal(calls.length, 1);
	});

	it("clears with null, and republishes after a clear", () => {
		const calls = installApi();
		publishSelectionHint("5 lines selected in patient.ts");
		publishSelectionHint(null);
		publishSelectionHint("5 lines selected in patient.ts");
		assert.deepEqual(calls, [
			[HINT_KEY, "5 lines selected in patient.ts"],
			[HINT_KEY, null],
			[HINT_KEY, "5 lines selected in patient.ts"],
		]);
	});

	it("sends the clear even when nothing was published, so a stale hint cannot survive a reload", () => {
		const calls = installApi();
		clearSelectionHint();
		assert.deepEqual(calls, [[HINT_KEY, null]]);
	});
});

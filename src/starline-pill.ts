/**
 * Starline pill for the `pi-ide` status.
 *
 * The status text is two glyphs — the connected editor's mark and the file's
 * language; Starline draws it as a pill in the footer and this file says what a
 * click does. The bubble is the part with room: the connected editor with its
 * file, cursor and selection, every other live editor (click one to switch), and
 * a disconnect row.
 *
 * Starline publishes its pill API on `globalThis`, so nothing here imports
 * `pi-starline` and the extension behaves exactly as before when it is not
 * installed: the status still appears in Pi's own footer, it is just not
 * clickable. The same registration also makes `/starline pi-ide` work.
 *
 * Editor state and helpers arrive through `PillDeps` instead of an import, so this
 * module never participates in a cycle with `index.ts`.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { appIcon, appName } from "./icons.ts";
import type { EditorState, Selection } from "./index.ts";

// ---- Starline pill API, as much of it as this file uses ----

type BubbleLine = string | { text: string; onSelect: () => void; current?: boolean };
type BubbleContent = { title?: string; body: BubbleLine[]; hint?: string };
type BubbleHandle = {
	refresh(): void;
	close(): void;
	isOpen(): boolean;
	onClose(callback: () => void): void;
};
type StarlinePillApi = {
	version: number;
	register(
		key: string,
		action: (context: { ctx: ExtensionContext; pill?: unknown }) => void | Promise<void>,
	): () => void;
	showBubble(
		ctx: ExtensionContext,
		content: BubbleContent | (() => BubbleContent),
		pill?: unknown,
	): BubbleHandle | undefined;
};

const PILL_API_SYMBOL = Symbol.for("pi-starline.pill-api.v1");

/** The status key this pill belongs to; the same one `setStatus` uses. */
export const PILL_KEY = "pi-ide";

/** Starline's API, or undefined when it is not loaded (or older than 0.4). */
function pillApi(): StarlinePillApi | undefined {
	return (globalThis as Record<symbol, unknown>)[PILL_API_SYMBOL] as StarlinePillApi | undefined;
}

// ---- Bubble ----

/** How often an open bubble re-reads the state files. */
const LIVE_TICK_MS = 1_000;
/** Rows for other live editors; a bubble is a glance, not a picker. */
const MAX_OTHER_ROWS = 5;
/**
 * Starline lays the bubble out at up to 64 columns, so a row longer than this
 * wraps — and a wrapped row in a one-fact-per-line list reads as a mistake.
 *
 * Facts are dropped in reverse order of importance (the directory first, then the
 * selection and cursor) and whatever is left is clipped from the left, which keeps
 * the tail of a filename: `…-q-learning.md` still says which note it is.
 */
const MAX_ROW_WIDTH = 52;

function textWidth(text: string): number {
	return [...text].length;
}

function clip(text: string, max: number): string {
	return textWidth(text) <= max ? text : `…${[...text].slice(-(max - 1)).join("")}`;
}

function fitRow(parts: string[], lead: string): string {
	const SEPARATOR = " \u00b7 ";
	// The bullet and its space count against the row: they are drawn, not metadata.
	const budgetFor = (text: string) => MAX_ROW_WIDTH - textWidth(lead) - textWidth(text);
	let current = [...parts];
	if (textWidth(current.join(SEPARATOR)) > budgetFor("") && current.length > 2) {
		// The directory goes first: the editor and the file identify the context on
		// their own, and the path is the part that grows without bound.
		current = [current[0] ?? "", ...current.slice(2)];
	}
	while (textWidth(current.join(SEPARATOR)) > budgetFor("") && current.length > 2) current.pop();
	// A long filename is clipped on its own, so the editor's name survives: it is
	// the one fact the row cannot lose.
	if (current.length > 1 && textWidth(current.join(SEPARATOR)) > budgetFor("")) {
		const fixed = [current[0] ?? "", ...current.slice(2)].join(SEPARATOR);
		const budget = budgetFor(fixed) - textWidth(SEPARATOR);
		if (budget > 8) current[1] = clip(current[1] ?? "", budget);
	}
	const row = current.join(SEPARATOR);
	return `${lead}${textWidth(row) > budgetFor("") ? clip(row, budgetFor("")) : row}`;
}

/** The last directory in a path, which is all a bubble row has room for. */
function baseDir(path: string): string {
	const trimmed = path.replace(/\/+$/, "");
	return trimmed.split("/").pop() ?? path;
}

export type PillDeps = {
	connectedPid(): number | null;
	readState(pid: number): Promise<EditorState | null>;
	scanLiveStates(): Promise<EditorState[]>;
	isFreshSelection(selection: Selection): boolean;
	selectedLineCount(selection: Selection): number | null;
	/** Connect to `state`, the same path `/ide` takes. */
	connect(ctx: ExtensionContext, state: EditorState): void;
	disconnect(ctx: ExtensionContext): void;
};

/** `buffer.ts · line 12:3 · 4 lines selected`: the current editor in one row. */
function currentRow(state: EditorState, deps: PillDeps): string {
	const buffer = state.active_buffer;
	const parts = [`${appIcon(state.app)} ${appName(state.app)}`, baseDir(state.cwd), buffer.name];
	const cursor = buffer.cursor;
	if (cursor && cursor.line !== null) {
		parts.push(
			cursor.column === null ? `line ${cursor.line}` : `line ${cursor.line}:${cursor.column}`,
		);
	}
	const selection = buffer.selection;
	if (selection && deps.isFreshSelection(selection)) {
		const lines = deps.selectedLineCount(selection);
		parts.push(lines === null ? "selection" : `${lines} line${lines === 1 ? "" : "s"} selected`);
	}
	return fitRow(parts, "\u25cf ");
}

/** One live editor that is not the connected one; clicking it switches over. */
function liveRow(editor: EditorState): string {
	const parts = [`${appIcon(editor.app)} ${appName(editor.app)}`, baseDir(editor.cwd)];
	parts.push(editor.active_buffer.name);
	return fitRow(parts, "\u25b8 ");
}

/**
 * The open bubble's content. `state` is the connected editor (null once the
 * connection dropped), `live` is every editor found on disk.
 *
 * Read-only rows come first — the connection and what the injected context will
 * say — then the editors a click can switch to, then the way out. The pill has
 * one glyph per fact; this is where the same facts get words.
 */
export function bubbleContent(
	state: EditorState | null,
	live: EditorState[],
	connectedPid: number | null,
	deps: PillDeps,
	ctx: ExtensionContext,
): BubbleContent {
	const body: BubbleLine[] = [];

	if (state) body.push(currentRow(state, deps));

	const others = live
		.filter((editor) => editor.pid !== connectedPid)
		.sort((a, b) => b.timestamp - a.timestamp);
	for (const editor of others.slice(0, MAX_OTHER_ROWS)) {
		body.push({ text: liveRow(editor), onSelect: () => deps.connect(ctx, editor) });
	}

	if (connectedPid !== null) {
		body.push({ text: "✕ Disconnect", onSelect: () => deps.disconnect(ctx) });
	}
	if (body.length === 0) body.push("no editor running · start one, then /ide");

	const hint =
		connectedPid === null ? "click a row to connect · esc" : "click a row to switch · esc";
	return {
		title: state ? `IDE · ${clip(state.active_buffer.name, 40)}` : "IDE context",
		body,
		hint,
	};
}

/**
 * Register the click action. Called from `session_start`, which runs after every
 * extension has loaded (so Starline's API is published whatever the load order)
 * and again after `/reload`. Returns a no-op when Starline is absent.
 */
export function registerStarlinePill(deps: PillDeps): () => void {
	const api = pillApi();
	if (!api) return () => {};

	return api.register(PILL_KEY, async ({ ctx, pill }) => {
		let state: EditorState | null = null;
		let live: EditorState[] = [];

		// State files are external input: a failed read shows an empty bubble
		// instead of taking the click handler down.
		const load = async () => {
			const pid = deps.connectedPid();
			state = pid === null ? null : await deps.readState(pid).catch(() => null);
			live = await deps.scanLiveStates().catch(() => []);
		};

		await load();
		const handle = api.showBubble(
			ctx,
			() => bubbleContent(state, live, deps.connectedPid(), deps, ctx),
			pill,
		);
		if (!handle) return;

		// Cursor and selection move while the bubble is open; re-read at the same
		// cadence the connection poll uses, without stacking slow reads.
		let reading = false;
		const ticker = setInterval(() => {
			if (reading) return;
			reading = true;
			void load().then(
				() => {
					reading = false;
					handle.refresh();
				},
				() => {
					reading = false;
				},
			);
		}, LIVE_TICK_MS);
		handle.onClose(() => clearInterval(ticker));
	});
}

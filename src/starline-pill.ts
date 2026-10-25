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

export type PillDeps = {
	connectedPid(): number | null;
	readState(pid: number): Promise<EditorState | null>;
	scanLiveStates(): Promise<EditorState[]>;
	shortDir(path: string): string;
	isFreshSelection(selection: Selection): boolean;
	selectedLineCount(selection: Selection): number | null;
	/** Connect to `state`, the same path `/ide` takes. */
	connect(ctx: ExtensionContext, state: EditorState): void;
	disconnect(ctx: ExtensionContext): void;
};

/** `buffer.ts · line 12:3 · 4 lines selected`: the current editor in one row. */
function currentRow(state: EditorState, deps: PillDeps): string {
	const buffer = state.active_buffer;
	const parts = [
		`${appIcon(state.app)} ${appName(state.app)}`,
		deps.shortDir(state.cwd),
		buffer.name,
	];
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
	return `● ${parts.join(" · ")}`;
}

/** One live editor that is not the connected one; clicking it switches over. */
function liveRow(editor: EditorState, deps: PillDeps): string {
	const parts = [`${appIcon(editor.app)} ${appName(editor.app)}`, deps.shortDir(editor.cwd)];
	parts.push(editor.active_buffer.name);
	return `▸ ${parts.join(" · ")}`;
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
		body.push({ text: liveRow(editor, deps), onSelect: () => deps.connect(ctx, editor) });
	}

	if (connectedPid !== null) {
		body.push({ text: "✕ Disconnect", onSelect: () => deps.disconnect(ctx) });
	}
	if (body.length === 0) body.push("no editor running · start one, then /ide");

	const hint =
		connectedPid === null ? "click a row to connect · esc" : "click a row to switch · esc";
	return {
		title: state ? `IDE · ${state.active_buffer.name}` : "IDE context",
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

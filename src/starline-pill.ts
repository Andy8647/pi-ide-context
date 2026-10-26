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
/**
 * A ceiling, not a glance limit: a real setup is two to five editors, and the bubble
 * has no height budget of its own — Starline only clamps its width — so listing them
 * all costs a few rows. The cap only keeps a farm of editors from drawing a bubble
 * taller than the screen; past it the overflow row opens `/ide`.
 */
const MAX_OTHER_ROWS = 12;
/**
 * Starline sizes the bubble to its longest row and clamps the bubble at 64 columns,
 * drawing a 4-column frame around the body (`pillBubbleWidth` in pi-starline). So a
 * 60-column row still fits exactly and 61 wraps — and a wrapped row in a
 * one-fact-per-line list reads as a mistake.
 *
 * Padding columns to a shared width costs a few cells per row, so this leaves as
 * much room as the frame allows: filenames survive intact, and only the ones past
 * that are clipped from the left (`…-q-learning.md` still says which note it is).
 */
const MAX_ROW_WIDTH = 60;
/** Below this the filename stops identifying anything, so the directory goes instead. */
const MIN_FILE_WIDTH = 12;

const SEPARATOR = " \u00b7 ";

function textWidth(text: string): number {
	return [...text].length;
}

function clip(text: string, max: number): string {
	return textWidth(text) <= max ? text : `…${[...text].slice(-(max - 1)).join("")}`;
}

type Row = { parts: string[]; lead: string; onSelect?: () => void };

/**
 * Bubble rows with their columns padded to a shared width, so every `·` lines up.
 *
 * Two phases, because alignment and fitting pull in opposite directions. First each
 * row decides its shape — trailing extras (cursor, selection) go, and the directory
 * only survives when a readable filename still fits next to it, since a dropped
 * column shifts every cell after it. Then the surviving columns are padded to the
 * widest cell in the same shape, and the filename gets whatever room is left,
 * clipped from the left so the end of it stays readable.
 */
function renderBody(rows: Row[]): BubbleLine[] {
	const budgetFor = (lead: string) => MAX_ROW_WIDTH - textWidth(lead);

	// ---- shape ----
	const shaped = rows.map((row) => {
		const parts = [...row.parts];
		const budget = budgetFor(row.lead);
		let fileIndex = parts.length > 2 ? 2 : parts.length - 1;

		if (parts.length > 2) {
			// Everything but the filename, at the minimum filename width, has to fit.
			const needed = textWidth(parts[0] ?? "") + textWidth(parts[1] ?? "") + MIN_FILE_WIDTH + 2 * 3;
			if (needed > budget) {
				parts.splice(1, 1);
				fileIndex = 1;
			}
		}
		while (textWidth(parts.join(SEPARATOR)) > budget && parts.length - 1 > fileIndex) {
			parts.pop();
		}
		return { ...row, parts, fileIndex };
	});

	// ---- columns ----
	// Keyed by column count: rows that lost their directory align with each other,
	// never with the ones that kept it.
	const widthsByShape = new Map<number, number[]>();
	for (const row of shaped) {
		const widths = widthsByShape.get(row.fileIndex + 1) ?? [];
		for (let i = 0; i <= row.fileIndex; i++) {
			widths[i] = Math.max(widths[i] ?? 0, textWidth(row.parts[i] ?? ""));
		}
		widthsByShape.set(row.fileIndex + 1, widths);
	}

	return shaped.map((row) => {
		const budget = budgetFor(row.lead);
		const widths = widthsByShape.get(row.fileIndex + 1) ?? [];
		let extras = row.parts.slice(row.fileIndex + 1);

		/** The whole row with `file` in its column; `""` measures the fixed part. */
		const draw = (file: string) => {
			const columns = [...row.parts.slice(0, row.fileIndex), file];
			const padded = columns.map((cell, i) =>
				i === columns.length - 1
					? cell
					: cell + " ".repeat(Math.max(0, (widths[i] ?? 0) - textWidth(cell))),
			);
			return [...padded, ...extras].join(SEPARATOR);
		};

		const file = row.parts[row.fileIndex] ?? "";
		let text = draw(file);
		// Padding ate the room the extras had: they go first, they are the least fact.
		while (textWidth(text) > budget && extras.length > 0) {
			extras = extras.slice(0, -1);
			text = draw(file);
		}
		if (textWidth(text) > budget) {
			const room = budget - textWidth(draw(""));
			if (room >= MIN_FILE_WIDTH) text = draw(clip(file, room));
		}
		// Last resort: a very long editor name and a very long filename in one row.
		if (textWidth(text) > budget) text = clip(text, budget);

		const line = `${row.lead}${text}`;
		return row.onSelect ? { text: line, onSelect: row.onSelect } : line;
	});
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
	/** Open the full `/ide` picker: the bubble lists a handful, it is not the picker. */
	openPicker(ctx: ExtensionContext): void;
};

/** `WebStorm · buffer.ts · line 12:3 · 4 lines selected`: the current editor in one row. */
function currentParts(state: EditorState, deps: PillDeps): string[] {
	const buffer = state.active_buffer;
	const parts = [
		`${appIcon(state.app, state.product)} ${appName(state.app, state.product)}`,
		baseDir(state.cwd),
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
	return parts;
}

/** One live editor that is not the connected one; clicking it switches over. */
function liveParts(editor: EditorState): string[] {
	return [
		`${appIcon(editor.app, editor.product)} ${appName(editor.app, editor.product)}`,
		baseDir(editor.cwd),
		editor.active_buffer.name,
	];
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

	const rows: Row[] = [];

	if (state) rows.push({ parts: currentParts(state, deps), lead: "\u25cf " });

	const others = live
		.filter((editor) => editor.pid !== connectedPid)
		.sort((a, b) => b.timestamp - a.timestamp);
	for (const editor of others.slice(0, MAX_OTHER_ROWS)) {
		rows.push({
			parts: liveParts(editor),
			lead: "\u25b8 ",
			onSelect: () => deps.connect(ctx, editor),
		});
	}

	body.push(...renderBody(rows));

	// A bubble is a glance, so it lists a few editors — but silently hiding the rest
	// reads as "that is all there is". The overflow row opens the real picker.
	const hidden = others.length - MAX_OTHER_ROWS;
	if (hidden > 0) {
		body.push({
			text: `\u25b8 \u2026and ${hidden} more \u00b7 /ide`,
			onSelect: () => deps.openPicker(ctx),
		});
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

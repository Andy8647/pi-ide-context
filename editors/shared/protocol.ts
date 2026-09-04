/**
 * pi-ide-context — editor client shared module (protocol v0.2)
 *
 * Editor-agnostic state types + state file I/O, shared by the VS Code and
 * Obsidian clients. The single source of truth for the JSON schema both
 * clients write; the pi side only reads, so keeping this in one place is what
 * stops the two clients from drifting apart. See docs/protocol.md.
 *
 * Deliberately minimal: only the schema + file plumbing. No editor API
 * abstraction — each client maps its own editor onto these types.
 */

import { chmodSync, mkdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// ---- Protocol types (v0.2) ----

export interface Position {
	/** 1-based line; null when the host has no line concept */
	line: number | null;
	/** 1-based column; null when the host has no column concept */
	column: number | null;
}

export interface Selection {
	start: Position;
	end: Position;
	text: string;
	/** unix seconds the user last made this selection; null = unknown (treated stale) */
	selected_at: number | null;
}

export interface BufferState {
	file: string | null;
	name: string;
	language: string | null;
	cursor: Position | null;
	selection: Selection | null;
	modified: boolean;
	lines_total: number;
}

export interface EditorState {
	pid: number;
	cwd: string;
	/** unix seconds of last write (informational) */
	timestamp: number;
	/** "nvim" | "vscode" | "obsidian" */
	app: "nvim" | "vscode" | "obsidian";
	/** launch args without argv[0]; stable per-instance fingerprint */
	argv?: string[];
	active_buffer: BufferState;
}

// ---- State file ----

/** state_dir = $XDG_RUNTIME_DIR/pi-ide, else /tmp/pi-ide */
export function stateDir(): string {
	const base = process.env.XDG_RUNTIME_DIR ?? "/tmp";
	return join(base, "pi-ide");
}

function stateFile(pid: number): string {
	return join(stateDir(), `${pid}.json`);
}

/** Create the state dir 0700 (owner-only). chmod enforces it even if the dir pre-exists. */
function ensureStateDir(): void {
	mkdirSync(stateDir(), { recursive: true, mode: 0o700 });
	chmodSync(stateDir(), 0o700);
}

/**
 * Write the editor state, atomically (tmp file then rename). Best-effort: a
 * failed write must never crash the editor, so errors are logged and swallowed.
 */
export function writeState(state: EditorState): void {
	try {
		ensureStateDir();
		const target = stateFile(state.pid);
		const tmp = `${target}.tmp`;
		writeFileSync(tmp, JSON.stringify(state), { mode: 0o600 });
		renameSync(tmp, target);
	} catch (err) {
		console.error(`[pi-ide-context] failed to write state: ${(err as Error).message}`);
	}
}

/** Remove the state file on clean exit. Stale files are tolerated anyway (pi checks pid liveness). */
export function removeState(pid: number): void {
	try {
		unlinkSync(stateFile(pid));
	} catch {
		// already gone
	}
}

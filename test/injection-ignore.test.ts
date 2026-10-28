import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { after, test } from "node:test";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { EditorState, SelectionEntryData } from "../src/index.ts";

const root = realpathSync(mkdtempSync(join(tmpdir(), "ide-injection-")));
const previousRuntime = process.env.XDG_RUNTIME_DIR;
const previousAgent = process.env.PI_CODING_AGENT_DIR;
process.env.XDG_RUNTIME_DIR = join(root, "runtime");
process.env.PI_CODING_AGENT_DIR = join(root, "agent");
const stateDir = join(process.env.XDG_RUNTIME_DIR, "pi-ide");
const project = join(root, "project");
const globalFile = join(process.env.PI_CODING_AGENT_DIR, "ide-context.ignore");
for (const dir of [stateDir, join(project, ".pi"), process.env.PI_CODING_AGENT_DIR]) {
	mkdirSync(dir, { recursive: true });
}
const { default: extension } = await import("../src/index.ts");

after(() => {
	if (previousRuntime === undefined) delete process.env.XDG_RUNTIME_DIR;
	else process.env.XDG_RUNTIME_DIR = previousRuntime;
	if (previousAgent === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = previousAgent;
	rmSync(root, { recursive: true, force: true });
});

function state(file = "main.ts"): EditorState {
	return {
		pid: process.pid,
		cwd: project,
		timestamp: Date.now() / 1000,
		app: "nvim",
		active_buffer: {
			file: join(project, file),
			name: basename(file),
			language: "typescript",
			cursor: { line: 1, column: 1 },
			selection: {
				start: { line: 1, column: 1 },
				end: { line: 1, column: 3 },
				text: `selection from ${file}`,
				selected_at: Date.now() / 1000,
			},
			modified: false,
			lines_total: 10,
		},
	};
}

function writeState(value: EditorState) {
	writeFileSync(join(stateDir, `${process.pid}.json`), JSON.stringify(value));
}

async function setup(t: { after(fn: () => Promise<void>): void }) {
	rmSync(globalFile, { recursive: true, force: true });
	rmSync(join(project, ".pi", "ide-context.local.ignore"), { force: true });
	writeState(state());
	const handlers = new Map<string, (event: never, ctx: ExtensionContext) => unknown>();
	const entries: SelectionEntryData[] = [];
	const notices: string[] = [];
	let command: (args: string, ctx: ExtensionCommandContext) => Promise<void> = async () => {};
	let transform = (markdown: string) => markdown;
	extension({
		on: (name: string, handler: (event: never, ctx: ExtensionContext) => unknown) => {
			handlers.set(name, handler);
		},
		registerCommand: (_name: string, options: { handler: typeof command }) => {
			command = options.handler;
		},
		registerMarkdownTransformer: (handler: (markdown: string, context: unknown) => string) => {
			transform = (markdown) =>
				handler(markdown, { messageType: "user", isStreaming: false, availableWidth: 100 });
		},
		appendEntry: (_type: string, data: SelectionEntryData) => entries.push(data),
	} as unknown as ExtensionAPI);
	const ctx = {
		cwd: project,
		ui: { setStatus: () => {}, notify: (message: string) => notices.push(message) },
		sessionManager: { getEntries: () => [] },
	} as unknown as ExtensionCommandContext;
	const emit = async (name: string, event: unknown = {}) =>
		handlers.get(name)?.(event as never, ctx);
	t.after(async () => {
		await emit("session_shutdown");
	});
	await emit("session_start");
	await command("", ctx);
	return {
		entries,
		notices,
		inject: () => emit("before_agent_start"),
		send: async (prompt = "explain this") => {
			const event = { message: { role: "user", content: prompt } };
			await emit("message_start", event);
			await emit("message_end", event);
			await new Promise<void>((resolve) => setImmediate(resolve));
			return transform(prompt);
		},
	};
}

test("excluded prompts have no context, quote or selection entry; switching back restores injection", async (t) => {
	const f = await setup(t);
	writeFileSync(globalFile, ".env*\n");
	writeState(state(".env"));
	assert.equal(await f.inject(), undefined);
	assert.equal(await f.send(), "explain this");
	assert.deepEqual(f.entries, []);

	writeState(state());
	const result = await f.inject();
	assert.ok(JSON.stringify(result).includes("main.ts"));
	assert.ok((await f.send()).includes("↳ main.ts:1-1"));
	assert.equal(f.entries.length, 1);
	assert.equal(f.notices.filter((text) => text.startsWith("Connected to")).length, 1);
	assert.ok(!f.notices.some((text) => text.includes("disconnected")));

	writeState(state(".env"));
	assert.equal(await f.inject(), undefined);
	assert.equal(
		await f.send(),
		"explain this",
		"identical prompts must not reuse the previous quote",
	);
	assert.equal(f.entries.length, 1);
});

test("local negations allow globally excluded example files", async (t) => {
	const f = await setup(t);
	writeFileSync(globalFile, ".env*\n");
	writeFileSync(join(project, ".pi", "ide-context.local.ignore"), "!.env.example\n");
	writeState(state(".env.example"));
	assert.ok(await f.inject());
	assert.ok((await f.send()).includes("↳ .env.example"));
	assert.equal(f.entries[0]?.file, ".env.example");
});

test("selection metadata uses the injected snapshot even if the editor switches files", async (t) => {
	const f = await setup(t);
	writeFileSync(globalFile, ".env*\n");
	assert.ok(await f.inject());
	writeState(state(".env"));
	assert.ok((await f.send()).includes("↳ main.ts"));
	assert.equal(f.entries[0]?.text, "selection from main.ts");

	assert.equal(await f.inject(), undefined);
	writeState(state());
	assert.equal(await f.send(), "explain this");
	assert.equal(f.entries.length, 1);
});

test("stale selections and unnamed buffers do not create selection metadata", async (t) => {
	const f = await setup(t);
	const stale = state();
	if (stale.active_buffer.selection) stale.active_buffer.selection.selected_at = 0;
	writeState(stale);
	const result = await f.inject();
	assert.ok(result);
	assert.ok(!JSON.stringify(result).includes("selection from"));
	assert.equal(await f.send(), "explain this");
	assert.deepEqual(f.entries, []);

	const unnamed = state();
	unnamed.active_buffer.file = null;
	writeState(unnamed);
	assert.equal(await f.inject(), undefined);
	assert.equal(await f.send(), "explain this");
	assert.deepEqual(f.entries, []);
});

test("ignore read errors skip injection and persistence with a warning", async (t) => {
	const f = await setup(t);
	mkdirSync(globalFile);
	assert.equal(await f.inject(), undefined);
	assert.equal(await f.send(), "explain this");
	assert.deepEqual(f.entries, []);
	assert.ok(f.notices.some((text) => text.includes("automatic context skipped")));
});

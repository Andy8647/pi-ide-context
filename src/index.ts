/**
 * pi-ide-context — pi 扩展(协议 v0.2)
 * 连接 Neovim / VS Code / Obsidian,自动注入编辑器上下文到 LLM。
 *
 * 协议:editor 端写状态 JSON → <state_dir>/<pid>.json
 * 详见 docs/protocol.md
 *
 * v0.2 行为:
 * - 自动连接:同一 cwd 下唯一存活的 editor 自动连上,零配置
 * - 注入策略:每次 prompt 都带轻量上下文(file/cursor/buffer);
 *   selection 文本只在新鲜(≤60s)时注入
 * - widget 纯 ASCII:新鲜选区 "N lines selected in x.ts",否则 "in x.ts"
 * - /ide off 真正断开,本 session 内不再自动重连
 */

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";

// ---- 协议类型(v0.2) ----

interface Position {
	/** 1-based line;host 无行概念时为 null */
	line: number | null;
	/** 1-based byte column;host 无列概念时为 null */
	column: number | null;
}

interface Selection {
	start: Position;
	end: Position;
	text: string;
	/** unix 秒:用户最后一次做出该选择的时刻;null = 不可知(视为过期) */
	selected_at: number | null;
}

interface BufferState {
	file: string | null;
	name: string;
	language: string | null;
	cursor: Position | null;
	selection: Selection | null;
	modified: boolean;
	lines_total: number;
}

interface EditorState {
	pid: number;
	cwd: string;
	/** unix 秒:最后写入时刻(信息性) */
	timestamp: number;
	/** "nvim" | "vscode" | "obsidian" */
	app: string;
	/** 启动参数(argv 去掉 argv[0]),用于区分同 cwd 下多个实例;可选 */
	argv?: string[];
	active_buffer: BufferState;
}

// ---- 常量 ----

const STATE_DIR = `${process.env.XDG_RUNTIME_DIR ?? join("/tmp")}/pi-ide`;
/** selection 新鲜窗口:超过此时长(秒)的选区视为过期,不注入文本 */
const SELECTION_FRESH_SECONDS = 60;
/** widget 轮询/自动发现间隔 */
const POLL_MS = 1000;

// ---- 工具 ----

async function readState(pid: number): Promise<EditorState | null> {
	try {
		const raw = await readFile(join(STATE_DIR, `${pid}.json`), "utf-8");
		return JSON.parse(raw) as EditorState;
	} catch {
		return null;
	}
}

async function scanLiveStates(cwd: string): Promise<EditorState[]> {
	try {
		const entries = await readdir(STATE_DIR);
		const states: EditorState[] = [];
		for (const e of entries) {
			if (!e.endsWith(".json")) continue;
			const pid = Number(e.slice(0, -5));
			if (!Number.isInteger(pid) || !pidAlive(pid)) continue;
			const s = await readState(pid);
			if (s && s.cwd === cwd) states.push(s);
		}
		return states;
	} catch {
		return [];
	}
}

/** 进程存活检查:kill(pid, 0) 成功或 EPERM 都算活着 */
function pidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		return (err as NodeJS.ErrnoException).code === "EPERM";
	}
}

function isFreshSelection(sel: Selection, nowSec = Date.now() / 1000): boolean {
	return typeof sel.selected_at === "number" && nowSec - sel.selected_at <= SELECTION_FRESH_SECONDS;
}

/** 相对时间(用于 /ide 列表区分哪个实例刚动过) */
function relTime(timestampSec: number, nowSec = Date.now() / 1000): string {
	const s = Math.max(0, Math.floor(nowSec - timestampSec));
	if (s < 5) return "just now";
	if (s < 60) return `${s}s ago`;
	const m = Math.floor(s / 60);
	if (m < 60) return `${m}m ago`;
	return `${Math.floor(m / 60)}h ago`;
}

/** 启动参数展示(截断,无则回退 cwd) */
function launchLabel(s: EditorState): string {
	const argv = (s.argv ?? []).join(" ");
	if (argv.length > 0) return argv.length > 48 ? `${argv.slice(0, 45)}...` : argv;
	return s.cwd;
}

/** 显示宽度(中文/全角按 2 格,近似 wcwidth) */
function dispWidth(s: string): number {
	let w = 0;
	for (const ch of s) {
		const c = ch.codePointAt(0) ?? 0;
		w +=
			c >= 0x1100 &&
			(c <= 0x115f ||
				(c >= 0x2e80 && c <= 0xa4cf) ||
				(c >= 0xac00 && c <= 0xd7a3) ||
				(c >= 0xf900 && c <= 0xfaff) ||
				(c >= 0xfe30 && c <= 0xfe4f) ||
				(c >= 0xff00 && c <= 0xff60) ||
				(c >= 0xffe0 && c <= 0xffe6))
				? 2
				: 1;
	}
	return w;
}

/** 按显示宽度左侧补齐空格 */
function padEndW(s: string, width: number): string {
	const pad = width - dispWidth(s);
	return pad > 0 ? s + " ".repeat(pad) : s;
}

function selectedLineCount(sel: Selection): number | null {
	if (sel.start.line === null || sel.end.line === null) return null;
	return sel.end.line - sel.start.line + 1;
}

// ---- Widget 文本(纯 ASCII) ----

function widgetLine(state: EditorState): string | null {
	const buf = state.active_buffer;
	if (!buf.file) return null; // 无名 buffer 不占 widget
	const sel = buf.selection;
	if (sel && isFreshSelection(sel)) {
		const n = selectedLineCount(sel);
		const selText =
			n !== null
				? `${n} line${n === 1 ? "" : "s"} selected in ${buf.name}`
				: `selection in ${buf.name}`;
		return selText;
	}
	return `in ${buf.name}`;
}

// ---- 格式化 LLM 上下文 ----
// 轻量块(file/cursor/buffer)每次注入;selection 文本仅当新鲜时附上。

function formatContext(state: EditorState): string {
	const buf = state.active_buffer;
	const lines: string[] = [];
	lines.push("### IDE Context");
	lines.push(`- **File**: \`${buf.file ?? "[No Name]"}\``);
	if (buf.language) lines.push(`- **Language**: ${buf.language}`);
	if (buf.cursor?.line != null) {
		const col = buf.cursor.column != null ? `, column ${buf.cursor.column}` : "";
		lines.push(`- **Cursor**: line ${buf.cursor.line}${col}`);
	}
	lines.push(`- **Buffer**: ${buf.lines_total} lines${buf.modified ? " (modified)" : ""}`);

	const sel = buf.selection;
	if (sel && isFreshSelection(sel)) {
		const n = selectedLineCount(sel);
		const range = n !== null ? `lines ${sel.start.line}-${sel.end.line}` : "selection";
		const txt = sel.text.length > 2000 ? `${sel.text.slice(0, 2000)}\n... (truncated)` : sel.text;
		lines.push(`- **Selection**: ${range}`);
		lines.push("");
		lines.push(`\`\`\`${buf.language ?? ""}`);
		lines.push(txt);
		lines.push("```");
	}
	return lines.join("\n");
}

// ---- 连接状态 ----

let connectedPid: number | null = null;
/** /ide off 后为 true:本 session 内不再自动重连 */
let autoConnectSuppressed = false;
let pollTimer: ReturnType<typeof setInterval> | null = null;
/** session 期间持有的 ctx,供定时器调 ui */
let activeCtx: ExtensionContext | null = null;
/** 避免重复 notify / setWidget */
let lastWidgetKey: string | null = null;
let lastLifecycleNotify: string | null = null;

function setWidget(ctx: ExtensionContext, key: string | null) {
	if (key === lastWidgetKey) return;
	lastWidgetKey = key;
	ctx.ui.setWidget("pi-ide", key === null ? [] : [key], {
		placement: "belowEditor",
	});
}

function notifyOnce(
	ctx: ExtensionContext,
	id: string,
	msg: string,
	level: "info" | "warning" | "error" = "info",
) {
	if (lastLifecycleNotify === id) return;
	lastLifecycleNotify = id;
	ctx.ui.notify(msg, level);
}

function disconnect(ctx: ExtensionContext, reason: string) {
	if (connectedPid === null) return;
	connectedPid = null;
	setWidget(ctx, null);
	notifyOnce(ctx, `disconnect:${reason}`, reason, "info");
}

// ---- 轮询 ----

async function pollTick() {
	const ctx = activeCtx;
	if (!ctx) return;

	if (connectedPid !== null) {
		const s = await readState(connectedPid);
		if (s && pidAlive(connectedPid)) {
			setWidget(ctx, widgetLine(s));
			lastLifecycleNotify = null; // 编辑器恢复后允许再次提示断连
			return;
		}
		// 编辑器死了 / 文件没了:断开并清 widget
		disconnect(ctx, "IDE disconnected.");
		return;
	}

	if (autoConnectSuppressed) return;

	// 自动发现:同一 cwd 下恰好一个存活 editor → 自动连接(零配置)
	const live = await scanLiveStates(ctx.cwd);
	if (live.length !== 1) return; // 无 / 多个都交给 /ide 手动处理
	connectedPid = live[0].pid;
	lastWidgetKey = null;
	const buf = live[0].active_buffer;
	notifyOnce(
		ctx,
		"connected",
		`Connected to ${live[0].app} (PID ${connectedPid}) — ${buf.name}`,
		"info",
	);
}

function startPolling() {
	if (pollTimer !== null) return;
	pollTimer = setInterval(() => {
		void pollTick();
	}, POLL_MS);
}

function stopPolling() {
	if (pollTimer !== null) {
		clearInterval(pollTimer);
		pollTimer = null;
	}
}

// ---- /ide 命令 ----

async function cmdIde(args: string, ctx: ExtensionCommandContext): Promise<void> {
	// /ide off — 真正断开:清 widget,本 session 不再自动重连
	if (args === "off" || args === "disconnect") {
		if (connectedPid === null && !autoConnectSuppressed) {
			ctx.ui.notify("No IDE connected.", "info");
			return;
		}
		connectedPid = null;
		autoConnectSuppressed = true;
		setWidget(ctx, null);
		ctx.ui.notify("Disconnected from IDE. New sessions auto-connect.", "info");
		return;
	}

	// /ide — 列出存活 editor,选择连接(或显示当前状态)
	const live = (await scanLiveStates(ctx.cwd)).sort((a, b) => b.timestamp - a.timestamp);
	if (live.length === 0) {
		ctx.ui.notify(
			"No running editor found in this project.\nMake sure Neovim with pi-ide is running in this cwd.",
			"warning",
		);
		return;
	}

	const selectedPid = connectedPid;
	// 列式对齐(无边框,按显示宽度)
	const pidW = Math.max(...live.map((s) => String(s.pid).length));
	const launchW = Math.max(...live.map((s) => dispWidth(launchLabel(s))));
	const fileW = Math.max(...live.map((s) => dispWidth(s.active_buffer.name)));

	const choices = live.map((s) => {
		const buf = s.active_buffer;
		// app  pid(左对齐)  launch   file   activity
		const cols =
			`${s.app} ${padEndW(String(s.pid), pidW)}  ` +
			`${padEndW(launchLabel(s), launchW)}  ` +
			`${padEndW(buf.name, fileW)}  ${relTime(s.timestamp)}`;
		const isCurrent = s.pid === selectedPid;
		return isCurrent ? `✓ ${cols}` : `  ${cols}`;
	});

	const choice = await ctx.ui.select(`Select IDE to connect (${live.length} found):`, choices);
	if (choice === undefined) return; // 取消

	const idx = choices.indexOf(choice);
	if (idx < 0 || idx >= live.length) return;

	connectedPid = live[idx].pid;
	autoConnectSuppressed = false;
	lastWidgetKey = null;
	const buf = live[idx].active_buffer;
	ctx.ui.notify(`Connected to ${live[idx].app} (PID ${connectedPid}) — ${buf.name}`, "info");
	// 立即刷新 widget,不必等下一个 tick
	setWidget(ctx, widgetLine(live[idx]));
}

// ---- 扩展入口 ----

export default function (pi: ExtensionAPI) {
	pi.registerCommand("ide", {
		description:
			"Connect to running IDE (Neovim / VS Code / Obsidian) for editor context; /ide off to disconnect",
		handler: cmdIde,
	});

	pi.on("session_start", async (_event, ctx) => {
		activeCtx = ctx;
		startPolling();
		// 立即试一次自动连接,不必等第一个 tick
		await pollTick();
	});

	pi.on("session_shutdown", () => {
		stopPolling();
		pollTimer = null;
		activeCtx = null;
		connectedPid = null;
		autoConnectSuppressed = false;
		lastWidgetKey = null;
		lastLifecycleNotify = null;
	});

	// 每次 prompt 注入编辑器上下文(轻量必带,selection 全文仅新鲜时)
	// biome-ignore lint/correctness/noUnusedFunctionParameters: pi.on handler 签名需要 (event, ctx)
	pi.on("before_agent_start", async (_event, ctx) => {
		if (connectedPid === null) return;

		const state = await readState(connectedPid);
		if (!state || !pidAlive(connectedPid)) return; // 断开交给 poll 处理
		const buf = state.active_buffer;
		if (!buf.file) return; // 无名 buffer 不注入

		return {
			message: {
				customType: "pi-ide-context",
				content: formatContext(state),
				display: false,
			},
		};
	});
}

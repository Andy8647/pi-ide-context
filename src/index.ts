/**
 * pi-ide-context — pi 扩展(协议 v0.2)
 * 连接 Neovim / VS Code / Obsidian,自动注入编辑器上下文到 LLM。
 *
 * 协议:editor 端写状态 JSON → <state_dir>/<pid>.json
 * 详见 docs/protocol.md
 *
 * v0.4 行为:
 * - 纯手动连接:session 启动不连任何 editor;`/ide` 列出所有存活 editor
 *   (不按项目/cwd 过滤,编辑器在哪启动、在干什么完全由用户判断),
 *   选一个才连;/ide off 断开。editor 进程退出后只通知,不自动重连
 * - 注入策略:每次 prompt 都带轻量上下文(file/cursor/buffer);
 *   selection 文本只在新鲜(≤60s)时注入
 * - 状态行纯 ASCII:新鲜选区 "N lines selected in x.ts",否则 "in x.ts"
 *
 * 状态行走 ctx.ui.setStatus("pi-ide", …),不是 widget:widget 只能画在编辑器
 * 上方/下方,而 pi-starline 的 `extensionStatuses.placements["pi-ide"] = "editor"`
 * 会把它放到编辑器右下角的 metadata 行。没装 starline 时它出现在 pi 内置 footer
 * 的扩展状态行里。
 */

import { readdir, readFile } from "node:fs/promises";
import { basename, join } from "node:path";
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
	/** editor 进程的 working directory(不是它打开的文件所在目录) */
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
/** 连接状态轮询间隔 */
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

/** 所有存活的 editor 状态(pid 活着 + 状态文件可读),不做任何过滤 */
async function scanLiveStates(): Promise<EditorState[]> {
	try {
		const entries = await readdir(STATE_DIR);
		const states: EditorState[] = [];
		for (const e of entries) {
			if (!e.endsWith(".json")) continue;
			const pid = Number(e.slice(0, -5));
			if (!Number.isInteger(pid) || !pidAlive(pid)) continue;
			const s = await readState(pid);
			if (s) states.push(s);
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
export function relTime(timestampSec: number, nowSec = Date.now() / 1000): string {
	const s = Math.max(0, Math.floor(nowSec - timestampSec));
	if (s < 5) return "just now";
	if (s < 60) return `${s}s ago`;
	const m = Math.floor(s / 60);
	if (m < 60) return `${m}m ago`;
	return `${Math.floor(m / 60)}h ago`;
}

/**
 * 启动参数里的路径按 cwd 归一化,仅用于展示:`nvim .` → `nvim <目录名>`,
 * `./src` → `src`,cwd 内的绝对路径 → 相对路径。非路径参数(flag、文件名)原样保留。
 */
function resolveLaunchArg(arg: string, cwd: string): string {
	if (arg === "." || arg === "./") return basename(cwd);
	if (arg.startsWith("./")) return arg.slice(2);
	const prefix = cwd.endsWith("/") ? cwd : `${cwd}/`;
	if (arg === cwd) return basename(cwd);
	if (arg.startsWith(prefix)) return arg.slice(prefix.length);
	return arg;
}

/** 启动参数展示(截断,无则回退 shortDir(cwd)) */
function launchLabel(s: EditorState): string {
	const argv = (s.argv ?? []).map((arg) => resolveLaunchArg(arg, s.cwd)).join(" ");
	if (argv.length > 0) return argv.length > 48 ? `${argv.slice(0, 45)}...` : argv;
	return shortDir(s.cwd);
}

/** 目录展示:$HOME 缩成 ~,太长时保留尾部(iCloud vault 那种长路径也能认出是哪) */
export function shortDir(p: string, maxWidth = 40): string {
	const home = process.env.HOME ?? "";
	let s = home && (p === home || p.startsWith(`${home}/`)) ? `~${p.slice(home.length)}` : p;
	if (dispWidth(s) > maxWidth) {
		while (dispWidth(s) > maxWidth - 1 && s.length > 1) s = s.slice(1);
		s = `…${s}`;
	}
	return s;
}

/** 显示宽度(中文/全角按 2 格,近似 wcwidth)。导出为测试 pickerRows 对齐 */
export function dispWidth(s: string): number {
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

/**
 * /ide 列表行。所有行列对齐(app/目录/launch/file 都按列最大显示宽度
 * 右侧补齐);最后一列 relTime 宽度不一是允许的,它后面没有东西。
 * pid 不展示(占宽度又没信息量),只在连接通知里报。
 * 导出只为测试对齐(test/format.test.ts)。
 */
export function pickerRows(live: EditorState[], connectedPid: number | null): string[] {
	const appW = Math.max(...live.map((s) => dispWidth(s.app)));
	const dirW = Math.max(...live.map((s) => dispWidth(shortDir(s.cwd))));
	const launchW = Math.max(...live.map((s) => dispWidth(launchLabel(s))));
	const fileW = Math.max(...live.map((s) => dispWidth(s.active_buffer.name)));
	return live.map((s) => {
		const cols =
			`${padEndW(s.app, appW)}  ` +
			`${padEndW(shortDir(s.cwd), dirW)}  ` +
			`${padEndW(launchLabel(s), launchW)}  ` +
			`${padEndW(s.active_buffer.name, fileW)}  ${relTime(s.timestamp)}`;
		return s.pid === connectedPid ? `✓ ${cols}` : `  ${cols}`;
	});
}

function selectedLineCount(sel: Selection): number | null {
	if (sel.start.line === null || sel.end.line === null) return null;
	return sel.end.line - sel.start.line + 1;
}

// ---- 状态文本(纯 ASCII) ----

export function statusLine(state: EditorState): string | null {
	const buf = state.active_buffer;
	if (!buf.file) return null; // 无名 buffer 不占状态行
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

export function formatContext(state: EditorState, nowSec = Date.now() / 1000): string {
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
	if (sel && isFreshSelection(sel, nowSec)) {
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
let pollTimer: ReturnType<typeof setInterval> | null = null;
/** session 期间持有的 ctx,供定时器调 ui */
let activeCtx: ExtensionContext | null = null;
/** 避免重复 notify / setStatus */
let lastStatusKey: string | null = null;
let lastLifecycleNotify: string | null = null;

/**
 * 发布状态行。key 固定 "pi-ide":starline 按 key 决定放置位,pi 内置 footer 按
 * key 排序。传 null 清除。
 */
function setStatus(ctx: ExtensionContext, text: string | null) {
	if (text === lastStatusKey) return;
	lastStatusKey = text;
	ctx.ui.setStatus("pi-ide", text ?? undefined);
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
	setStatus(ctx, null);
	notifyOnce(ctx, `disconnect:${reason}`, reason, "info");
}

// ---- 轮询 ----
// 轮询只维护已建立的连接(刷新状态行、发现 editor 死了就断开)。
// 不做任何自动发现/自动连接:连不连、连哪个,都由 /ide 决定。

async function pollTick() {
	const ctx = activeCtx;
	if (!ctx || connectedPid === null) return;

	const s = await readState(connectedPid);
	if (s && pidAlive(connectedPid)) {
		setStatus(ctx, statusLine(s));
		lastLifecycleNotify = null; // 编辑器恢复后允许再次提示断连
		return;
	}
	// 编辑器死了 / 状态文件没了:断开并清状态,不自动重连
	disconnect(ctx, "IDE disconnected. Run /ide to reconnect.");
}

function startPolling() {
	if (pollTimer !== null) return;
	pollTimer = setInterval(() => {
		// 状态文件是外部输入。pollTick 里任何意外都不该把 pi 整个进程带走:
		// async 函数抛出的会变成 unhandled rejection,Node 默认当致命错误处理。
		// 读取侧已做防御,这里只是最后一层网(不再有第二次机会解释原因)。
		void pollTick().catch(() => {});
	}, POLL_MS);
}

function stopPolling() {
	if (pollTimer !== null) {
		clearInterval(pollTimer);
		pollTimer = null;
	}
}

// ---- /ide 命令 ----

/** picker 里的断开行(与 editor 行区分开) */
const DISCONNECT_CHOICE = "✕ Disconnect";

function disconnectIde(ctx: ExtensionContext): void {
	connectedPid = null;
	setStatus(ctx, null);
	ctx.ui.notify("Disconnected from IDE.", "info");
}

async function cmdIde(args: string, ctx: ExtensionCommandContext): Promise<void> {
	// /ide off — 断开当前连接
	if (args === "off" || args === "disconnect") {
		if (connectedPid === null) {
			ctx.ui.notify("No IDE connected.", "info");
			return;
		}
		disconnectIde(ctx);
		return;
	}

	// /ide — 列出所有存活 editor(不按项目过滤),选择连接(或断开当前连接)
	const live = (await scanLiveStates()).sort((a, b) => b.timestamp - a.timestamp);
	if (live.length === 0) {
		ctx.ui.notify(
			"No running editors found. Start Neovim / VS Code / Obsidian with the pi-ide client, then run /ide again.",
			"warning",
		);
		return;
	}

	const choices = pickerRows(live, connectedPid);
	// 已连接时在末尾提供断开行:命令行的 /ide off 不总是想得起来
	if (connectedPid !== null) choices.push(DISCONNECT_CHOICE);

	const choice = await ctx.ui.select(`Select IDE to connect (${live.length} found):`, choices);
	if (choice === undefined) return; // 取消

	if (choice === DISCONNECT_CHOICE) {
		disconnectIde(ctx);
		return;
	}

	const idx = choices.indexOf(choice);
	if (idx < 0 || idx >= live.length) return;

	connectedPid = live[idx].pid;
	lastStatusKey = null;
	const buf = live[idx].active_buffer;
	ctx.ui.notify(`Connected to ${live[idx].app} (PID ${connectedPid}) — ${buf.name}`, "info");
	// 立即刷新状态行,不必等下一个 tick
	setStatus(ctx, statusLine(live[idx]));
}

// ---- 扩展入口 ----

export default function (pi: ExtensionAPI) {
	pi.registerCommand("ide", {
		description:
			"Connect to a running IDE (Neovim / VS Code / Obsidian) for editor context; /ide off to disconnect",
		// 让 `/ide ` + Tab 能直接补出 off,而不是只能靠描述文字
		getArgumentCompletions: (prefix) => {
			const args = [{ value: "off", label: "off", description: "Disconnect from the IDE" }];
			return args.filter((a) => a.value.startsWith(prefix));
		},
		handler: cmdIde,
	});

	pi.on("session_start", async (_event, ctx) => {
		activeCtx = ctx;
		// 不自动连接:轮询只为维护用户手动建立的连接
		startPolling();
	});

	pi.on("session_shutdown", () => {
		stopPolling();
		pollTimer = null;
		activeCtx = null;
		connectedPid = null;
		lastStatusKey = null;
		lastLifecycleNotify = null;
	});

	// 每次 prompt 注入编辑器上下文(轻量必带,selection 全文仅新鲜时)
	// biome-ignore lint/correctness/noUnusedFunctionParameters: pi.on handler 签名需要 (event, ctx)
	pi.on("before_agent_start", async (_event, ctx) => {
		if (connectedPid === null) return;

		const state = await readState(connectedPid);
		if (!state || !pidAlive(connectedPid)) return; // 断开交给 poll 处理
		// 状态文件是外部输入,字段可能缺失:nvim 客户端的 nil 会让整个 key 消失,
		// 无名 buffer 的 payload 里可能根本没有 file(`file !== null` 挡不住 undefined)
		if (!state.active_buffer?.file) return; // 无名 buffer 不注入

		return {
			message: {
				customType: "pi-ide-context",
				content: formatContext(state),
				display: false,
			},
		};
	});
}

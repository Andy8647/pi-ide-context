/**
 * pi-ide-context — pi 扩展(协议 v0.2)
 * 连接 Neovim / VS Code / Obsidian,自动注入编辑器上下文到 LLM。
 *
 * 协议:editor 端写状态 JSON → <state_dir>/<pid>.json
 * 详见 docs/protocol.md
 *
 * v0.2 行为:
 * - 自动连接:同一项目(见 matchTier:cwd 相等,或 editor 明显在本项目里干活)
 *   下唯一存活的 editor 自动连上,零配置
 * - 注入策略:每次 prompt 都带轻量上下文(file/cursor/buffer);
 *   selection 文本只在新鲜(≤60s)时注入
 * - 状态行纯 ASCII:新鲜选区 "N lines selected in x.ts",否则 "in x.ts"
 * - /ide off 真正断开,本 session 内不再自动重连
 *
 * 状态行走 ctx.ui.setStatus("pi-ide", …),不是 widget:widget 只能画在编辑器
 * 上方/下方,而 pi-starline 的 `extensionStatuses.placements["pi-ide"] = "editor"`
 * 会把它放到编辑器右下角的 metadata 行。没装 starline 时它出现在 pi 内置 footer
 * 的扩展状态行里。
 */

import { statSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
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
/** 状态轮询/自动发现间隔 */
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

/** 所有存活的 editor 状态(pid 活着 + 状态文件可读),不做项目过滤 */
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

// ---- 项目匹配 ----
// editor 的 cwd 与 pi 的 cwd 不必逐字相等才算同一个项目:`cd ~/proj && nvim src/`
// 时 nvim 的 getcwd() 仍是 ~/proj,但用户显然是在 src 里干活。
// 本节的纯函数导出只为测试(test/match.test.ts);pi 只消费 default export。

/** tier 0 = 同一个目录;tier 1 = 同一个项目(证据较弱);null = 无关 */
export type MatchTier = 0 | 1;

/** 去掉结尾多余斜杠(`/` 自身除外),便于分段比较 */
function normalizeDir(p: string): string {
	return p.length > 1 && p.endsWith("/") ? p.replace(/\/+$/, "") : p;
}

/** child 是否严格位于 dir 之下(按路径分段:`/a/bc` 不算在 `/a/b` 里) */
export function isInside(child: string, dir: string): boolean {
	// 状态文件是外部输入,字段可能缺失/类型不对;宁可返回 false 也不抛
	if (typeof child !== "string" || typeof dir !== "string") return false;
	const rel = relative(normalizeDir(dir), normalizeDir(child));
	return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

/**
 * 把 argv 里指向目录的启动参数解析成绝对路径。
 * argv 原本只为展示/区分同 cwd 实例而存在,但 `nvim <dir>/` 明确表达了"在这个
 * 目录里干活",所以拿它当匹配证据;只认真实存在的目录,这样文件名、残留 flag、
 * 以及 vscode/obsidian 写的 workspace/vault 名字都会被 statSync 挡掉。
 */
function launchDirs(state: EditorState): string[] {
	const dirs: string[] = [];
	for (const arg of state.argv ?? []) {
		if (arg === "") continue;
		const p = isAbsolute(arg) ? arg : resolve(state.cwd, arg);
		try {
			if (statSync(p).isDirectory()) dirs.push(normalizeDir(p));
		} catch {
			// 路径不存在:argv 这项不是目录,忽略
		}
	}
	return dirs;
}

/** editor 是否服务于 pi 当前所在的项目,以及证据强度 */
export function matchTier(state: EditorState, piCwd: string): MatchTier | null {
	// 状态文件是外部输入,而 nvim 客户端的 nil 会让整个 key 消失:未命名 buffer
	// 写出的 JSON 里根本没有 `file`(`file !== null` 挡不住 undefined,曾经因此把
	// pi 整个进程带走)。这里每个字段都对"缺失/类型不对"宽容。
	if (typeof state?.cwd !== "string" || state.cwd === "") return null;
	const project = normalizeDir(piCwd);
	const cwd = normalizeDir(state.cwd);
	if (cwd === project) return 0;
	// editor 开在项目里的子目录(pi 在仓库根,nvim 开在 packages/x)
	if (isInside(cwd, project)) return 1;
	// 正在编辑本项目里的文件:从父目录 `nvim <项目>/` 启动主要靠这条
	const file = state.active_buffer?.file;
	if (typeof file === "string" && isAbsolute(file) && isInside(file, project)) return 1;
	// 启动参数直接指向本项目(还没打开任何文件时,例如 netrw 停在目录上)
	if (launchDirs(state).some((d) => d === project || isInside(d, project))) return 1;
	return null;
}

/**
 * 本项目下的候选 editor,只保留证据最强的那一层:有精确 cwd 匹配时,较弱的匹配
 * 不再出现,免得把 `nvim ~/Projects` 这种顺带的上下文混进来。
 */
export async function findCandidates(cwd: string): Promise<EditorState[]> {
	const scored: { state: EditorState; tier: MatchTier }[] = [];
	for (const state of await scanLiveStates()) {
		const tier = matchTier(state, cwd);
		if (tier !== null) scored.push({ state, tier });
	}
	if (scored.length === 0) return [];
	const best = Math.min(...scored.map((s) => s.tier));
	return scored.filter((s) => s.tier === best).map((s) => s.state);
}

/** 存活的 editor 里不属于本项目的那些,只用于"找不到"时的诊断提示 */
async function scanForeignStates(cwd: string): Promise<EditorState[]> {
	const foreign = (await scanLiveStates()).filter((s) => matchTier(s, cwd) === null);
	return foreign.sort((a, b) => b.timestamp - a.timestamp);
}

/**
 * 找不到本项目 editor 时的提示。直接报出"别处有哪些 editor":用户看到
 * `/Users/andy/Projects/UNSW` 就明白 nvim 是从父目录启的,不用猜。
 */
export function noEditorWarning(piCwd: string, foreign: EditorState[]): string {
	const hint =
		foreign.length === 0
			? "Make sure Neovim with pi-ide is running in this project."
			: `${foreign.length} editor${foreign.length === 1 ? "" : "s"} running elsewhere: ${foreign
					.map((s) => `${s.app} (PID ${s.pid}, ${s.cwd})`)
					.join(", ")}`;
	return `No running editor found in this project (${piCwd}).\n${hint}`;
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

/** 启动参数展示(截断,无则回退 cwd) */
function launchLabel(s: EditorState): string {
	const argv = (s.argv ?? []).map((arg) => resolveLaunchArg(arg, s.cwd)).join(" ");
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

// ---- 状态文本(纯 ASCII) ----

function statusLine(state: EditorState): string | null {
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

async function pollTick() {
	const ctx = activeCtx;
	if (!ctx) return;

	if (connectedPid !== null) {
		const s = await readState(connectedPid);
		if (s && pidAlive(connectedPid)) {
			setStatus(ctx, statusLine(s));
			lastLifecycleNotify = null; // 编辑器恢复后允许再次提示断连
			return;
		}
		// 编辑器死了 / 文件没了:断开并清状态
		disconnect(ctx, "IDE disconnected.");
		return;
	}

	if (autoConnectSuppressed) return;

	// 自动发现:本项目下恰好一个存活 editor → 自动连接(零配置)
	const live = await findCandidates(ctx.cwd);
	if (live.length !== 1) return; // 无 / 多个都交给 /ide 手动处理
	connectedPid = live[0].pid;
	lastStatusKey = null;
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
		// 状态文件是外部输入。pollTick 里任何意外都不该把 pi 整个进程带走:
		// async 函数抛出的会变成 unhandled rejection,Node 默认当致命错误处理。
		// matchTier 已做防御,这里只是最后一层网(不再有第二次机会解释原因)。
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

/** 断开并抑制本 session 的自动重连 */
function disconnectIde(ctx: ExtensionContext): void {
	connectedPid = null;
	autoConnectSuppressed = true;
	setStatus(ctx, null);
	ctx.ui.notify("Disconnected from IDE. New sessions auto-connect.", "info");
}

async function cmdIde(args: string, ctx: ExtensionCommandContext): Promise<void> {
	// /ide off — 真正断开:清状态,本 session 不再自动重连
	if (args === "off" || args === "disconnect") {
		if (connectedPid === null && !autoConnectSuppressed) {
			ctx.ui.notify("No IDE connected.", "info");
			return;
		}
		disconnectIde(ctx);
		return;
	}

	// /ide — 列出本项目下的存活 editor,选择连接(或断开当前连接)
	const live = (await findCandidates(ctx.cwd)).sort((a, b) => b.timestamp - a.timestamp);
	if (live.length === 0) {
		ctx.ui.notify(noEditorWarning(ctx.cwd, await scanForeignStates(ctx.cwd)), "warning");
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
	// 已连接时在末尾提供断开行:命令行的 /ide off 不总是想得起来
	const canDisconnect = connectedPid !== null;
	if (canDisconnect) choices.push(DISCONNECT_CHOICE);

	const choice = await ctx.ui.select(`Select IDE to connect (${live.length} found):`, choices);
	if (choice === undefined) return; // 取消

	if (choice === DISCONNECT_CHOICE) {
		disconnectIde(ctx);
		return;
	}

	const idx = choices.indexOf(choice);
	if (idx < 0 || idx >= live.length) return;

	connectedPid = live[idx].pid;
	autoConnectSuppressed = false;
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
			"Connect to running IDE (Neovim / VS Code / Obsidian) for editor context; /ide off to disconnect",
		// 让 `/ide ` + Tab 能直接补出 off,而不是只能靠描述文字
		getArgumentCompletions: (prefix) => {
			const args = [
				{ value: "off", label: "off", description: "Disconnect; new sessions auto-connect" },
			];
			return args.filter((a) => a.value.startsWith(prefix));
		},
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
		lastStatusKey = null;
		lastLifecycleNotify = null;
	});

	// 每次 prompt 注入编辑器上下文(轻量必带,selection 全文仅新鲜时)
	// biome-ignore lint/correctness/noUnusedFunctionParameters: pi.on handler 签名需要 (event, ctx)
	pi.on("before_agent_start", async (_event, ctx) => {
		if (connectedPid === null) return;

		const state = await readState(connectedPid);
		if (!state || !pidAlive(connectedPid)) return; // 断开交给 poll 处理
		// 字段缺失照旧容忍(见 matchTier):无名 buffer 的 payload 里可能根本没有 file
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

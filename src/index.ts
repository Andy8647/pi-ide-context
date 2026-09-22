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
 * - selection 展示:带着新鲜选区发出的 user message 下方追加一行灰色
 *   `↳ file:start-end · 选中内容`(custom entry,持久化但不进 LLM context)
 * - 状态行纯 ASCII:新鲜选区 "N lines selected in x.ts",否则 "in x.ts"
 *
 * 状态行走 ctx.ui.setStatus("pi-ide", …),不是 widget:widget 只能画在编辑器
 * 上方/下方,而 pi-starline 的 `extensionStatuses.placements["pi-ide"] = "editor"`
 * 会把它放到编辑器右下角的 metadata 行。没装 starline 时它出现在 pi 内置 footer
 * 的扩展状态行里。
 */

import { readdir, readFile } from "node:fs/promises";
import { basename, isAbsolute, join, resolve } from "node:path";
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
/** 聊天记录里 selection 展示的 custom entry 类型(不进 LLM context,仅展示) */
const SELECTION_ENTRY_TYPE = "pi-ide-selection";
/** 存进 entry 的 selection 文本上限:展示只占一行,没必要把整段选区写进 session 文件 */
const SELECTION_ENTRY_TEXT_MAX = 200;

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

// ---- user message 盒内的 selection 灰字行 ----
// 做法:custom entry 只存数据(持久化,不进 LLM context,也不注册 renderer 所以不直接
// 显示);真正的显示走 markdown transformer——pi 渲染 user message 前会调它,我们把
// `> ↳ file:start-end · 选中内容` 追加到消息末尾,渲染成盒子里的一行灰色 blockquote。
// 为什么不用 entry 直接显示:CustomEntryComponent 会在内容前硬加一个 Spacer(1),
// 灰字和 user message 盒子之间永远隔一行,视觉上像脱节的两条消息。

/** 存进 custom entry 的数据(session 文件里可见,字段只增不减) */
export interface SelectionEntryData {
	file: string;
	startLine: number | null;
	endLine: number | null;
	text: string;
}

/** user message 原文 → 那行灰字。message_start 时写入(扩展事件先于 UI 派发,
 * 所以 UserMessageComponent 构造时 map 已就绪);session_start 时从 entry 重建。 */
const selectionLineByPrompt = new Map<string, string>();

/** 按显示宽度截断(中文/全角按 2 格),放不下时末尾加 … */
export function truncateW(s: string, maxWidth: number): string {
	if (maxWidth < 1) return "";
	if (dispWidth(s) <= maxWidth) return s;
	if (maxWidth < 2) return "…";
	let out = "";
	let w = 0;
	for (const ch of s) {
		const cw = dispWidth(ch);
		if (w + cw > maxWidth - 1) return `${out}…`;
		out += ch;
		w += cw;
	}
	return out;
}

/** 灰字行的纯文本:↳ file:start-end · 选中内容(折行/多余空白压成一个空格) */
export function selectionEntryLine(d: SelectionEntryData): string {
	const range = d.startLine !== null && d.endLine !== null ? `:${d.startLine}-${d.endLine}` : "";
	const oneLine = d.text.replace(/\s+/g, " ").trim();
	return `↳ ${d.file}${range} · ${oneLine}`;
}

/** 把灰字行作为 blockquote 追加到 user message markdown 末尾。
 * 注意不做 markdown escape:pi 的 UserMessageComponent 开了 preserveBackslashEscapes,
 * `\*` 会被原样显示成 `\*`(实测)。选区里的 inline 语法(`**`、反引号)就让它渲染,
 * 反正都在灰色斜体的 quote 样式里;唯一要防的是消息本身有未闭合 code fence,
 * 那会把追加的 quote 吞进代码块——这种情况宁可不显示。 */
export function appendSelectionQuote(markdown: string, line: string): string {
	let fences = 0;
	for (const l of markdown.split("\n")) if (/^\s*(```|~~~)/.test(l)) fences++;
	if (fences % 2 === 1) return markdown;
	return `${markdown}\n\n> ${line}`;
}

/** 和 UI 侧 getUserMessageText 相同的文本提取(text block 直接拼接),保证 map key 一致 */
function userTextOf(message: { content: unknown }): string {
	const c = message.content;
	if (typeof c === "string") return c;
	if (!Array.isArray(c)) return "";
	return c
		.filter((b): b is { type: "text"; text: string } => b?.type === "text")
		.map((b) => b.text)
		.join("");
}

/** session_start 时从持久化的 entry 重建 map:每条 pi-ide-selection 归属它前面最近的 user message */
function rebuildSelectionLineMap(ctx: ExtensionContext): void {
	selectionLineByPrompt.clear();
	try {
		let lastUserText: string | null = null;
		for (const e of ctx.sessionManager.getEntries()) {
			if (e.type === "message") {
				const m = (e as { message?: { role?: string; content?: unknown } }).message;
				if (m?.role === "user") lastUserText = userTextOf(m as { content: unknown });
			} else if (e.type === "custom") {
				const c = e as { customType?: string; data?: SelectionEntryData };
				if (c.customType === SELECTION_ENTRY_TYPE && c.data && lastUserText) {
					selectionLineByPrompt.set(lastUserText, selectionEntryLine(c.data));
					lastUserText = null;
				}
			}
		}
	} catch {
		// sessionManager 早期状态不可用时放弃重建;实时消息的 map 写入不受影响
	}
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

/**
 * 注入前把 file 补成绝对路径。Obsidian 的 active_buffer.file 是 vault 相对路径
 * (协议 v0.2),原样注入时模型只能拿 pi 的 cwd 去拼,必然拼错——vault 在
 * iCloud~md~obsidian、pi 的 cwd 在别处时,连 read 都找不到文件,write 更会在项目
 * 目录里建出一棵影子目录树。cwd 对 Obsidian 就是 vault 根,拿它 resolve 即可。
 * nvim/vscode 已经是绝对路径,原样通过;cwd 也不是绝对路径(非
 * FileSystemAdapter 的 vault)时无从补全,只能原样返回。
 */
function absoluteFile(file: string, cwd: string | undefined): string {
	if (isAbsolute(file) || !cwd || !isAbsolute(cwd)) return file;
	return resolve(cwd, file);
}

export function formatContext(state: EditorState, nowSec = Date.now() / 1000): string {
	const buf = state.active_buffer;
	const lines: string[] = [];
	lines.push("### IDE Context");
	const file = typeof buf.file === "string" ? absoluteFile(buf.file, state.cwd) : null;
	lines.push(`- **File**: \`${file ?? "[No Name]"}\``);
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
		// 从持久化的 entry 重建 map,让 resume/reload 后的历史消息也能显示灰字。
		// 注意 reload 路径会先把 chat 渲染一遍再发 session_start,那一遍已经按空 map
		// 缓存了;历史灰字要等下一次 chat 重建(窗口 resize 等)才出现,可接受。
		rebuildSelectionLineMap(ctx);
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
		selectionLineByPrompt.clear();
	});

	// user message 渲染前把灰字行挂进盒子。transformer 每次 render 都会跑(Markdown
	// 组件按 text+width 缓存),所以这里必须纯函数:同一条消息多次渲染结果一致。
	pi.registerMarkdownTransformer((markdown, context) => {
		if (context.messageType !== "user" || context.isStreaming) return markdown;
		const line = selectionLineByPrompt.get(markdown);
		if (!line) return markdown;
		// blockquote 渲染时占掉 2 格("│ ");宽度太离谱时回退 80
		const width = context.availableWidth > 4 ? context.availableWidth - 2 : 80;
		return appendSelectionQuote(markdown, truncateW(line, width));
	});

	// message_start(role=user)时写 map。扩展事件先于 UI 派发(_handleAgentEvent:
	// _emitExtensionEvent → _emit(UI)),所以 UserMessageComponent 构造并首次跑
	// transformer 时,map 里已经有这条消息的灰字行了。
	pi.on("message_start", async (event, _ctx) => {
		if (event.message.role !== "user") return;
		if (connectedPid === null) return;

		const state = await readState(connectedPid);
		if (!state || !pidAlive(connectedPid)) return;
		const buf = state.active_buffer;
		if (!buf?.file) return;
		const sel = buf.selection;
		// 和注入用同一个新鲜度判据:注入给模型看过的选区,才在消息上留痕
		if (!sel || !isFreshSelection(sel) || !sel.text.trim()) return;

		const text = userTextOf(event.message);
		if (!text) return;
		selectionLineByPrompt.set(
			text,
			selectionEntryLine({
				file: buf.name,
				startLine: sel.start.line,
				endLine: sel.end.line,
				text:
					sel.text.length > SELECTION_ENTRY_TEXT_MAX
						? sel.text.slice(0, SELECTION_ENTRY_TEXT_MAX)
						: sel.text,
			}),
		);
	});

	// entry 只负责持久化(resume 时 rebuildSelectionLineMap 的数据源),不负责显示。
	// 为什么 message_end + setImmediate:_handleAgentEvent 里扩展事件先于 UI 和 session
	// 持久化派发;user message 在 message_end 之后落盘,同步 appendEntry 会让 entry 在
	// session 树里排到 user message *前面*,rebuild 时归属就错了。setImmediate 推到
	// 整个事件派发完之后,树里顺序 = user message → entry。
	pi.on("message_end", async (event, _ctx) => {
		if (event.message.role !== "user") return;
		if (connectedPid === null) return;

		const state = await readState(connectedPid);
		if (!state || !pidAlive(connectedPid)) return;
		const buf = state.active_buffer;
		if (!buf?.file) return;
		const sel = buf.selection;
		if (!sel || !isFreshSelection(sel) || !sel.text.trim()) return;

		const data: SelectionEntryData = {
			file: buf.name,
			startLine: sel.start.line,
			endLine: sel.end.line,
			text:
				sel.text.length > SELECTION_ENTRY_TEXT_MAX
					? sel.text.slice(0, SELECTION_ENTRY_TEXT_MAX)
					: sel.text,
		};
		setImmediate(() => pi.appendEntry(SELECTION_ENTRY_TYPE, data));
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

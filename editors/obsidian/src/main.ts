/**
 * pi-ide-context — Obsidian 客户端(协议 v0.2)
 * 写 <state_dir>/<pid>.json,pi 扩展读取并注入 LLM 上下文。
 * 协议定义见 repo 根 docs/protocol.md;共享类型/文件 I/O 见 editors/shared/protocol.ts。
 *
 * v0.2 语义:Obsidian 无 file:line:col,file 是 vault 相对路径(如 Notes/foo.md),
 * cursor/selection 用 CM6 的行/字符偏移(列 1-based,字符而非字节)。
 * selection.selected_at = 用户最后一次做出非空选择的时刻,由 pi 端按 60s 新鲜度决定注入。
 */

import { EditorView } from "@codemirror/view";
import {
	type App,
	type Editor,
	type EditorPosition,
	FileSystemAdapter,
	MarkdownView,
	Plugin,
} from "obsidian";
import type { BufferState, EditorState, Position, Selection } from "../../shared/protocol";
import { removeState, writeState } from "../../shared/protocol";

const DEBOUNCE_MS = 200;
const APP = "obsidian";

/** vault 根绝对路径;非文件系统适配器时退回 vault 名 */
function vaultBasePath(app: App): string {
	const adapter = app.vault.adapter;
	if (adapter instanceof FileSystemAdapter) return adapter.getBasePath();
	return app.vault.getName();
}

/** 规范化两个位置为 (start, end):行优先,同行比字符列 */
function ordered(a: EditorPosition, b: EditorPosition): [EditorPosition, EditorPosition] {
	if (a.line < b.line || (a.line === b.line && a.ch <= b.ch)) return [a, b];
	return [b, a];
}

/** CM6 0-based 行/字符 → 协议 1-based */
function toPosition(p: EditorPosition): Position {
	return { line: p.line + 1, column: p.ch + 1 };
}

function buildSelection(editor: Editor, selectedAt: number | null): Selection | null {
	const text = editor.getSelection();
	if (text === "") return null;
	const [s, e] = ordered(editor.getCursor("from"), editor.getCursor("to"));
	return {
		start: toPosition(s),
		end: toPosition(e),
		text,
		selected_at: selectedAt,
	};
}

function buildBufferState(view: MarkdownView | null, selectedAt: number | null): BufferState {
	if (!view?.file) {
		return {
			file: null,
			name: "[No File]",
			language: null,
			cursor: null,
			selection: null,
			modified: false,
			lines_total: 0,
		};
	}

	const file = view.file;
	const editor = view.editor;

	return {
		file: file.path, // vault 相对路径,如 "Notes/foo.md"
		name: file.name,
		language: "markdown",
		cursor: toPosition(editor.getCursor()),
		selection: buildSelection(editor, selectedAt),
		modified: false, // Obsidian 自动保存,无未保存概念
		lines_total: editor.lineCount(),
	};
}

export default class PiIdeContextPlugin extends Plugin {
	private debounceTimer: number | null = null;
	/** 用户最后一次做出非空选择的时刻(unix 秒);null = 未知(视为过期) */
	private lastSelectionAt: number | null = null;
	/** onunload 后置 true,防止关闭过程再触发事件把状态文件写回来 */
	private unloaded = false;

	async onload(): Promise<void> {
		this.writeActiveState();

		// 内容编辑(editor-change 只在内容变化时触发,不覆盖选区)→ 去抖写入
		this.registerEvent(this.app.workspace.on("editor-change", () => this.debouncedWrite()));

		// 切换笔记 / 窗口 → 立即写入;新笔记的选区年龄未知 → 视为过期
		this.registerEvent(
			this.app.workspace.on("active-leaf-change", () => {
				this.lastSelectionAt = null;
				this.writeActiveState();
			}),
		);

		// CM6 选区变化(Obsidian 无选区事件,editor-change 不触发):非空选区打点 selected_at
		this.registerEditorExtension(
			EditorView.updateListener.of((update) => {
				if (update.selectionSet && !update.state.selection.main.empty) {
					this.lastSelectionAt = Math.floor(Date.now() / 1000);
				}
				if (update.selectionSet) this.debouncedWrite();
			}),
		);

		// 退出清理:onunload 在禁用/重载插件时触发;OS 级 quit 不保证触发 onunload,
		// 补一个 Workspace "quit" 事件做 best-effort 清理(文档明确不保证执行)。
		// 即便清理不到,pi 端也会用 kill(pid,0) 忽略残留的死进程文件。
		this.registerEvent(
			this.app.workspace.on("quit", () => {
				this.unloaded = true;
				removeState(process.pid);
			}),
		);
	}

	onunload(): void {
		this.unloaded = true;
		if (this.debounceTimer !== null) window.clearTimeout(this.debounceTimer);
		removeState(process.pid);
	}

	private debouncedWrite(): void {
		if (this.debounceTimer !== null) window.clearTimeout(this.debounceTimer);
		this.debounceTimer = window.setTimeout(() => {
			this.debounceTimer = null;
			this.writeActiveState();
		}, DEBOUNCE_MS);
	}

	private writeActiveState(): void {
		if (this.unloaded) return;
		const state: EditorState = {
			pid: process.pid,
			cwd: vaultBasePath(this.app),
			timestamp: Math.floor(Date.now() / 1000),
			app: APP,
			argv: [this.app.vault.getName()],
			active_buffer: buildBufferState(
				this.app.workspace.getActiveViewOfType(MarkdownView),
				this.lastSelectionAt,
			),
		};
		writeState(state);
	}
}

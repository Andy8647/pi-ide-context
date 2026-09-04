/**
 * pi-ide-context — VS Code 客户端(协议 v0.2)
 * 写 <state_dir>/<pid>.json,pi 扩展读取并注入 LLM 上下文。
 * 协议定义见 repo 根 docs/protocol.md;共享类型/文件 I/O 见 editors/shared/protocol.ts。
 *
 * v0.2 语义:列号 1-based;selection.selected_at = 用户最后一次做出非空选择的时刻
 * (VS Code 无 visual-mode 概念,取"选区变为非空"的瞬间),由 pi 端按 60s 新鲜度决定注入。
 */

import { basename, dirname } from "node:path";
import * as vscode from "vscode";
import type { BufferState, EditorState, Position, Selection } from "../../shared/protocol";
import { removeState, writeState } from "../../shared/protocol";

const DEBOUNCE_MS = 200;
const APP = "vscode";

let debounceTimer: ReturnType<typeof setTimeout> | null = null;
/** 用户最后一次做出非空选择的时刻(unix 秒);null = 未知(如会话恢复的选区,视为过期) */
let lastSelectionAt: number | null = null;

function nowSec(): number {
	return Math.floor(Date.now() / 1000);
}

/** cwd:主 workspace 根 → 活动文件目录 → process.cwd() */
function currentCwd(): string {
	const folders = vscode.workspace.workspaceFolders;
	if (folders && folders.length > 0) return folders[0].uri.fsPath;
	const editor = vscode.window.activeTextEditor;
	if (editor && editor.document.uri.scheme === "file") {
		return dirname(editor.document.uri.fsPath);
	}
	return process.cwd();
}

/** argv:VS Code 无启动参数可拿,用 workspace 名作稳定指纹;同 cwd 双开时 pid 仍可区分 */
function launchArgv(): string[] {
	const name = vscode.workspace.name;
	if (name) return [name];
	return [basename(currentCwd())];
}

/** 0-based → 1-based */
function toPosition(line0: number, column0: number): Position {
	return { line: line0 + 1, column: column0 + 1 };
}

function buildSelection(sel: vscode.Selection, text: string): Selection {
	// vscode 的 Selection.start/end 已是规范化(start ≤ end),0-based
	return {
		start: toPosition(sel.start.line, sel.start.character),
		end: toPosition(sel.end.line, sel.end.character),
		text,
		selected_at: lastSelectionAt,
	};
}

function buildBufferState(editor: vscode.TextEditor | undefined): BufferState {
	if (!editor) {
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

	const doc = editor.document;
	const sel = editor.selection;
	const selection = sel.isEmpty ? null : buildSelection(sel, doc.getText(sel));

	return {
		file: doc.uri.scheme === "file" ? doc.uri.fsPath : null,
		name: doc.fileName ? basename(doc.fileName) : "[No File]",
		language: doc.languageId || null,
		cursor: toPosition(sel.active.line, sel.active.character),
		selection,
		modified: doc.isDirty,
		lines_total: doc.lineCount,
	};
}

function writeActiveState(): void {
	const state: EditorState = {
		pid: process.pid,
		cwd: currentCwd(),
		timestamp: nowSec(),
		app: APP,
		argv: launchArgv(),
		active_buffer: buildBufferState(vscode.window.activeTextEditor),
	};
	writeState(state);
}

function debouncedWrite(): void {
	if (debounceTimer !== null) clearTimeout(debounceTimer);
	debounceTimer = setTimeout(() => {
		debounceTimer = null;
		writeActiveState();
	}, DEBOUNCE_MS);
}

export function activate(context: vscode.ExtensionContext): void {
	writeActiveState();

	context.subscriptions.push(
		// 选区变化(也含光标移动):非空选区打点 selected_at
		vscode.window.onDidChangeTextEditorSelection((e) => {
			if (!e.textEditor.selection.isEmpty) {
				lastSelectionAt = nowSec();
			}
			debouncedWrite();
		}),
		// 切换活动编辑器:新编辑器的选区年龄未知(可能来自会话恢复)→ 视为过期
		vscode.window.onDidChangeActiveTextEditor(() => {
			lastSelectionAt = null;
			writeActiveState();
		}),
		// 内容变化(行数 / modified 变化)
		vscode.workspace.onDidChangeTextDocument(() => {
			debouncedWrite();
		}),
		// 保存 → 立即写入(modified 翻回 false)
		vscode.workspace.onDidSaveTextDocument(() => {
			writeActiveState();
		}),
	);
}

export function deactivate(): void {
	if (debounceTimer !== null) clearTimeout(debounceTimer);
	removeState(process.pid);
}

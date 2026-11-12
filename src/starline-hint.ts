/**
 * 选区那一句话,两个通道共用:
 *
 * - starline 在时,它挂在编辑器顶栏右端(`editor-hint-api`),贴着编辑器说。
 * - starline 不在时,它整句就进状态行:pi 原生 footer 那一行有整个终端宽度,
 *   只写 `17L` 就太干,文件名是这句话一半的信息。
 *
 * 状态行因此在 starline 在时只留计数(句子已经在那里了),不在时才写全句。
 */

import { appIcon, languageIcon } from "./icons.ts";
import type { EditorState } from "./index.ts";

const HINT_API_SYMBOL = Symbol.for("pi-starline.editor-hint-api.v1");

/** starline 那边的类型在它自己仓库里;这里只声明用到的部分 */
type StarlineHintApi = {
	version: number;
	setHint(key: string, text: string | null | undefined): void;
};

/** 和状态行同一个 key,一个扩展在两处用同一份身份 */
export const HINT_KEY = "pi-ide";

/** starline 的 hint API;没装时为 undefined,调用方据此决定状态行写多长 */
export function editorHintApi(): StarlineHintApi | undefined {
	return (globalThis as Record<symbol, unknown>)[HINT_API_SYMBOL] as StarlineHintApi | undefined;
}

/** 上一次发出去的内容:同样的话不必每秒让 starline 重绘一次 */
let published: string | null = null;

/**
 * `  \ue8ca 5 lines selected in index.ts`。
 *
 * 前面两个字形和 pill 用的是同一套:先说在哪个编辑器、什么文件,再说选了多少。
 * 用 buffer 名而不是绝对路径:顶栏一行最多几十格,路径会把文件名挤出屏幕。
 * 行数不可知(某些客户端只报列)时退成 `selection in x.ts`,总比不说强。
 */
export function selectionHintText(state: EditorState, lines: number | null): string | null {
	const buf = state.active_buffer;
	if (!buf?.name) return null;
	if (lines !== null && lines <= 0) return null;
	const marks = `${appIcon(state.app, state.product)} ${languageIcon(buf.language ?? undefined, buf.file ?? undefined)}`;
	const what =
		lines === null
			? `selection in ${buf.name}`
			: `${lines} line${lines === 1 ? "" : "s"} selected in ${buf.name}`;
	return `${marks} ${what}`;
}

/** 发出去;null 表示"没有别的话要说" */
export function publishSelectionHint(text: string | null): void {
	const api = editorHintApi();
	if (!api || text === published) return;
	published = text;
	api.setHint(HINT_KEY, text);
}

/** 断开/session 结束时清掉,不让上一段连接留下的话停在编辑器顶上 */
export function clearSelectionHint(): void {
	published = null;
	editorHintApi()?.setHint(HINT_KEY, null);
}

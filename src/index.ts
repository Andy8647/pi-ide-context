/**
 * pi-ide-context — pi 扩展
 * 通过 /ide 连接 Neovim / VS Code，自动注入编辑器上下文到 LLM。
 *
 * 协议：editor 端写状态 JSON → /tmp/pi-ide/<pid>.json
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

// ---- 类型 ----

interface Cursor {
  line: number;
  column: number;
}

interface Selection {
  start: Cursor;
  end: Cursor;
  text: string;
}

interface BufferState {
  file: string | null;
  name: string;
  language: string | null;
  cursor: Cursor;
  selection: Selection | null;
  modified: boolean;
  lines_total: number;
}

interface EditorState {
  pid: number;
  cwd: string;
  timestamp: number;
  active_buffer: BufferState;
}

// ---- 常量 ----

const STATE_DIR =
  (process.env.XDG_RUNTIME_DIR ?? join("/tmp")) + "/pi-ide";

// ---- 工具 ----

async function scanStates(): Promise<string[]> {
  try {
    const entries = await readdir(STATE_DIR);
    return entries.filter((e) => e.endsWith(".json"));
  } catch {
    return [];
  }
}

async function readState(filename: string): Promise<EditorState | null> {
  try {
    const raw = await readFile(join(STATE_DIR, filename), "utf-8");
    return JSON.parse(raw) as EditorState;
  } catch {
    return null;
  }
}

function isStale(state: EditorState, maxAgeMs = 30_000): boolean {
  return Date.now() - state.timestamp * 1000 > maxAgeMs;
}

async function loadAllStates(): Promise<EditorState[]> {
  const files = await scanStates();
  const states: EditorState[] = [];
  for (const f of files) {
    const s = await readState(f);
    if (s) states.push(s);
  }
  return states;
}

async function findStateByPid(pid: number): Promise<EditorState | null> {
  return readState(pid + ".json");
}

// ---- Widget 文本 ----

function widgetLine(state: EditorState, connected: boolean): string {
  const buf = state.active_buffer;
  const dot = buf.modified ? " ●" : "";
  if (buf.selection) {
    const n = buf.selection.end.line - buf.selection.start.line + 1;
    return `✂ ${n}L in ${buf.name}${dot}`;
  }
  return `${connected ? "▸" : "·"} ${buf.name}${dot}`;
}

// ---- 格式化 LLM 上下文 ----

function formatContext(state: EditorState): string {
  const buf = state.active_buffer;
  const lines: string[] = [];
  lines.push("### IDE Context");
  lines.push(`- **File**: \`${buf.file ?? "[No Name]"}\``);
  if (buf.language) lines.push(`- **Language**: ${buf.language}`);
  lines.push(`- **Cursor**: line ${buf.cursor.line}, column ${buf.cursor.column}`);
  lines.push(`- **Buffer**: ${buf.lines_total} lines${buf.modified ? " (modified)" : ""}`);
  if (buf.selection) {
    const sl = buf.selection.start;
    const el = buf.selection.end;
    const txt = buf.selection.text.length > 2000
      ? buf.selection.text.slice(0, 2000) + "\n... (truncated)"
      : buf.selection.text;
    lines.push(`- **Selection**: lines ${sl.line}-${el.line}`);
    lines.push("");
    lines.push("```" + (buf.language ?? ""));
    lines.push(txt);
    lines.push("```");
  }
  return lines.join("\n");
}

// ---- 连接状态 ----

let connectedPid: number | null = null;
let lastInjectedTimestamp = 0;
let pollTimer: ReturnType<typeof setInterval> | null = null;

// ---- /ide 命令 ----

async function cmdIde(args: string, ctx: ExtensionCommandContext): Promise<void> {
  const selectedPid = connectedPid;

  // /ide off  — 断开连接
  if (args === "off" || args === "disconnect") {
    if (selectedPid === null) {
      ctx.ui.notify("No IDE connected.", "info");
      return;
    }
    connectedPid = null;
    ctx.ui.setWidget("pi-ide", [], { placement: "belowEditor" });
    ctx.ui.notify("Disconnected from IDE.", "info");
    return;
  }

  // /ide  — 列出可用编辑器或显示当前状态
  const all = await loadAllStates();
  const fresh = all.filter((s) => !isStale(s));

  if (fresh.length === 0) {
    ctx.ui.notify(
      "No running editor found.\nMake sure Neovim with pi-ide is running in this project.",
      "warning",
    );
    return;
  }

  // 构建选项列表
  const choices = fresh.map((s) => {
    const buf = s.active_buffer;
    const label = `nvim (PID ${s.pid})  ${buf.name}  —  ${s.cwd}`;
    const isCurrent = s.pid === selectedPid;
    return isCurrent ? `✓ ${label}` : `  ${label}`;
  });

  const choice = await ctx.ui.select(
    `Select IDE to connect (${fresh.length} found):`,
    choices,
  );

  if (choice === undefined) return; // 用户取消

  const idx = choices.indexOf(choice);
  if (idx < 0 || idx >= fresh.length) return;

  connectedPid = fresh[idx].pid;
  const buf = fresh[idx].active_buffer;
  ctx.ui.notify(`Connected to nvim (PID ${connectedPid}) — ${buf.name}`, "info");
}

// ---- 扩展入口 ----

export default function (pi: ExtensionAPI) {
  // /ide 命令
  pi.registerCommand("ide", {
    description: "Connect to running IDE (Neovim / VS Code) for editor context",
    handler: cmdIde,
  });

  // 启动 widget 轮询
  pi.on("session_start", async (_event, ctx) => {
    if (connectedPid !== null) {
      const s = await findStateByPid(connectedPid);
      if (s && !isStale(s)) {
        ctx.ui.setWidget("pi-ide", [widgetLine(s, true)], { placement: "belowEditor" });
      }
    }

    pollTimer = setInterval(async () => {
      if (connectedPid === null) {
        // 未连接时也尝试扫一下，展示 · filename 提示可连接
        const all = await loadAllStates();
        const best = all.find((s) => s.cwd === ctx.cwd && !isStale(s));
        ctx.ui.setWidget("pi-ide", best ? [widgetLine(best, false)] : [], {
          placement: "belowEditor",
        });
        return;
      }
      const s = await findStateByPid(connectedPid);
      if (s && !isStale(s)) {
        ctx.ui.setWidget("pi-ide", [widgetLine(s, true)], { placement: "belowEditor" });
      }
    }, 1000);
  });

  // 清理
  pi.on("session_shutdown", () => {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  });

  // 注入 LLM 上下文
  pi.on("before_agent_start", async (event, ctx) => {
    if (connectedPid === null) return;

    const state = await findStateByPid(connectedPid);
    if (!state || isStale(state)) return;

    if (state.timestamp <= lastInjectedTimestamp) return;
    lastInjectedTimestamp = state.timestamp;

    return {
      message: {
        customType: "pi-ide-context",
        content: formatContext(state),
        display: false,
      },
    };
  });
}

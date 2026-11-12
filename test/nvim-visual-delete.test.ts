/**
 * nvim 端的回归测试:真的起一个 headless nvim 喂键。
 *
 * issue #11:`GVkd` 删掉最后两行时,退出 visual 的 ModeChanged 在删除之后才跑,
 * `'<`/`'>` 还指着已删掉的行。之前 `capture_selection` 对着空 list 取 `#last`,
 * 报 `attempt to get length of local 'last' (a nil value)`,顺手跳过了写状态,
 * 状态文件停在删除前的旧选区。
 *
 * 没有 nvim 的机器上整组跳过(CI 的 ubuntu runner 默认没有)。
 */

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

const REPO = join(import.meta.dirname, "..");

function nvimAvailable(): boolean {
	try {
		execFileSync("nvim", ["--version"], { stdio: "ignore" });
		return true;
	} catch {
		return false;
	}
}

const available = nvimAvailable();

const SCRIPT = `
vim.opt.runtimepath:append(${JSON.stringify(REPO)})
vim.o.swapfile = false
local mod = require("pi-ide")
mod.setup()
local buf = vim.api.nvim_get_current_buf()
vim.api.nvim_buf_set_lines(buf, 0, -1, false, { "aaa", "bbb", "ccc" })
vim.api.nvim_win_set_cursor(0, { 1, 0 })
for _, key in ipairs({ "G", "V", "k", "d" }) do
  vim.api.nvim_feedkeys(key, "x", false)
end
mod.flush()
-- VimLeavePre 会把状态文件删掉,所以在这里读出来交给测例
local dir = (os.getenv("XDG_RUNTIME_DIR") or "/tmp") .. "/pi-ide"
local f = io.open(dir .. "/" .. vim.fn.getpid() .. ".json", "r")
print("STATE " .. (f and f:read("*a") or "MISSING"))
if f then f:close() end
`;

describe("nvim: deleting a visual line selection", { skip: !available }, () => {
	it("writes a state file instead of failing in ModeChanged", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-ide-nvim-"));
		try {
			const script = join(dir, "run.lua");
			writeFileSync(script, SCRIPT);
			const run = spawnSync("nvim", ["--headless", "-u", "NONE", "-l", script], {
				encoding: "utf-8",
				// 状态目录隔离,别去碰真实的 /tmp/pi-ide
				env: { ...process.env, XDG_RUNTIME_DIR: dir },
			});
			assert.equal(run.status, 0, run.stderr);
			// headless nvim 的 `print` 走 stderr,两个流一起看
			const printed = `${run.stdout}${run.stderr}`;
			assert.doesNotMatch(printed, /attempt to get length/);

			const raw = /STATE (.+)/.exec(printed)?.[1];
			assert.ok(raw && raw !== "MISSING", `state file was not written: ${printed}`);
			const state = JSON.parse(raw);
			// 删完之后本来就没有选区,状态文件也不该还挂着一个
			assert.equal(state.active_buffer.selection, null);
			assert.equal(state.active_buffer.lines_total, 1);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

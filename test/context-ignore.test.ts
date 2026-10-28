import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { isContextExcluded } from "../src/context-ignore.ts";

function setup(t: { after(fn: () => void): void }) {
	const root = mkdtempSync(join(tmpdir(), "ide-ignore-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const agent = join(root, "agent");
	const project = join(root, "project");
	const editor = join(root, "other");
	for (const dir of [agent, join(project, ".pi"), editor]) mkdirSync(dir, { recursive: true });
	return {
		agent,
		project,
		editor,
		global: (rules: string) => writeFileSync(join(agent, "ide-context.ignore"), rules),
		local: (rules: string) =>
			writeFileSync(join(project, ".pi", "ide-context.local.ignore"), rules),
		check: (file: string, cwd = project) => isContextExcluded(file, cwd, project, agent),
	};
}

test("missing ignore files preserve injection and are not created", (t) => {
	const f = setup(t);
	assert.equal(f.check(join(f.project, ".env")), false);
	assert.deepEqual(readdirSync(f.agent), []);
	assert.deepEqual(readdirSync(join(f.project, ".pi")), []);
});

test("global rules support comments, nested files, directories and globstars", (t) => {
	const f = setup(t);
	f.global("# private files\n.env*\n*.pem\ngenerated/\n**/fixtures/*.json\n");
	for (const file of [
		".env",
		"apps/web/.env.local",
		"keys/api.pem",
		"generated/a.ts",
		"src/fixtures/a.json",
	]) {
		assert.equal(f.check(join(f.project, file)), true, file);
	}
	assert.equal(f.check(join(f.project, "src/main.ts")), false);
});

test("local rules append exclusions and can negate global rules", (t) => {
	const f = setup(t);
	f.global(".env*\n*.pem\n");
	f.local("!.env.example\nlarge/\n");
	assert.equal(f.check(join(f.project, ".env.example")), false);
	assert.equal(f.check(join(f.project, ".env.production")), true);
	assert.equal(f.check(join(f.project, "api.pem")), true);
	assert.equal(f.check(join(f.project, "large/data.json")), true);
	f.local("");
	assert.equal(f.check(join(f.project, ".env.example")), true);
});

test("gitignore negations must also unignore an excluded parent directory", (t) => {
	const f = setup(t);
	f.global("private/\n");
	f.local("!private/example.txt\n");
	assert.equal(f.check(join(f.project, "private/example.txt")), true);
	f.local("!private/\nprivate/*\n!private/example.txt\n");
	assert.equal(f.check(join(f.project, "private/example.txt")), false);
	assert.equal(f.check(join(f.project, "private/secret.txt")), true);
});

test("anchored paths are relative to Pi cwd, not the ignore file or editor cwd", (t) => {
	const f = setup(t);
	f.global("/secret.txt\n");
	assert.equal(f.check(join(f.project, "secret.txt"), f.editor), true);
	assert.equal(f.check(join(f.project, "src/secret.txt")), false);
	f.local("/src/private.ts\n");
	assert.equal(f.check(join(f.project, "src/private.ts")), true);
});

test("outside-project files use only global rules relative to the editor cwd", (t) => {
	const f = setup(t);
	f.global("/private/*\n*.pem\n");
	f.local("!*\n");
	assert.equal(f.check(join(f.editor, "private/token.txt"), f.editor), true);
	assert.equal(f.check(join(f.editor, "api.pem"), f.editor), true);
	f.local("*.ts\n");
	assert.equal(f.check(join(f.editor, "main.ts"), f.editor), false);
	// A sibling whose name shares the project's prefix is not inside it.
	assert.equal(f.check(`${f.project}-other/api.pem`, f.editor), true);
	assert.equal(f.check(`${f.project}-other/main.ts`, f.editor), false);
});

test("relative Obsidian paths resolve against the vault, not Pi cwd", (t) => {
	const f = setup(t);
	f.global("private/\n");
	assert.equal(f.check("private/note.md", f.editor), true);
	assert.equal(f.check("Notes/note.md", f.editor), false);
	// A virtual vault without an absolute cwd can still use global patterns.
	assert.equal(f.check("private/note.md", "Vault"), true);
});

test("edits, creation and deletion take effect on the next check", (t) => {
	const f = setup(t);
	const file = join(f.project, "main.ts");
	assert.equal(f.check(file), false);
	f.global("*.ts\n");
	assert.equal(f.check(file), true);
	f.local("!main.ts\n");
	assert.equal(f.check(file), false);
	rmSync(join(f.project, ".pi", "ide-context.local.ignore"));
	assert.equal(f.check(file), true);
	rmSync(join(f.agent, "ide-context.ignore"));
	assert.equal(f.check(file), false);
});

test("Git's own ignore files do not affect IDE context", (t) => {
	const f = setup(t);
	writeFileSync(join(f.project, ".gitignore"), "*.ts\n");
	assert.equal(f.check(join(f.project, "main.ts")), false);
});

test("unreadable configuration does not silently allow injection", (t) => {
	const f = setup(t);
	mkdirSync(join(f.agent, "ide-context.ignore"));
	assert.throws(() => f.check(join(f.project, "main.ts")));
});

import { readFileSync } from "node:fs";
import { isAbsolute, join, parse, relative, resolve } from "node:path";
import ignore from "ignore";

function readRules(path: string): string {
	try {
		return readFileSync(path, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
		throw error;
	}
}

function relativeFile(root: string, file: string): string | null {
	const path = relative(root, file);
	return ignore.isPathValid(path) ? path : null;
}

/**
 * Global rules first, project rules second, using standard gitignore semantics.
 * Files outside Pi's cwd use only global rules, relative to the editor's cwd
 * (or the filesystem root if the file is outside that directory too).
 * Read on each check so edits and deletions take effect without reconnecting.
 * Non-ENOENT read errors propagate: callers must skip injection, not fail open.
 */
export function isContextExcluded(
	file: string,
	editorCwd: string,
	projectCwd: string,
	agentDir: string,
): boolean {
	const globalRules = readRules(join(agentDir, "ide-context.ignore"));
	const absolute = isAbsolute(file)
		? file
		: isAbsolute(editorCwd)
			? resolve(editorCwd, file)
			: null;
	const projectPath = absolute ? relativeFile(projectCwd, absolute) : null;
	if (projectPath) {
		return ignore()
			.add(globalRules)
			.add(readRules(join(projectCwd, ".pi", "ide-context.local.ignore")))
			.ignores(projectPath);
	}
	const globalPath = absolute
		? ((isAbsolute(editorCwd) ? relativeFile(editorCwd, absolute) : null) ??
			relative(parse(absolute).root, absolute))
		: file;
	return ignore.isPathValid(globalPath) && ignore().add(globalRules).ignores(globalPath);
}

import esbuild from "esbuild";

const prod = process.argv[2] === "production";

await esbuild.build({
	entryPoints: ["src/main.ts"],
	bundle: true,
	// Obsidian provides these at runtime (don't bundle them)
	external: [
		"obsidian",
		"electron",
		"@codemirror/state",
		"@codemirror/view",
		"@lezer/common",
		"@lezer/highlight",
		"@lezer/lr",
		"node:fs",
		"node:path",
	],
	format: "cjs",
	target: "es2018",
	logLevel: "info",
	sourcemap: prod ? false : "inline",
	treeShaking: true,
	outfile: "main.js",
});

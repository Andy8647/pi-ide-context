import esbuild from "esbuild";

const prod = process.argv[2] === "production";

await esbuild.build({
	entryPoints: ["src/extension.ts"],
	bundle: true,
	external: ["vscode"],
	platform: "node",
	format: "cjs",
	target: "node20",
	logLevel: "info",
	sourcemap: prod ? false : "inline",
	outfile: "dist/extension.js",
});

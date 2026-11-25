import { rm } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";

const output = resolve(import.meta.dir, "dist");
await rm(output, { recursive: true, force: true });
const external = ["react", "zod", "@signet/core/*"];
const browser = await Bun.build({
	entrypoints: [
		"./src/index.ts",
		"./src/errors.ts",
		"./src/transport.ts",
		"./src/react.tsx",
		"./src/ai-sdk.ts",
		"./src/openai.ts",
	].map((path) => resolve(import.meta.dir, path)),
	outdir: output,
	target: "browser",
	splitting: true,
	external,
});
if (!browser.success) throw new AggregateError(browser.logs, "SDK browser build failed");
const shared = new Set(["index.js", "errors.js", "transport.js"].map((name) => resolve(import.meta.dir, "src", name)));
const node = await Bun.build({
	entrypoints: [resolve(import.meta.dir, "src/node.ts")],
	outdir: output,
	target: "node",
	splitting: true,
	external,
	plugins: [
		{
			name: "shared-browser-transport",
			setup(build) {
				build.onResolve({ filter: /(?:index|errors|transport)\.js$/ }, (args) => {
					const path = resolve(dirname(args.importer), args.path);
					if (shared.has(path)) return { path: `./${basename(path)}`, external: true };
					return undefined;
				});
			},
		},
	],
});
if (!node.success) throw new AggregateError(node.logs, "SDK Node build failed");

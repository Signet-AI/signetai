#!/usr/bin/env bun

import { existsSync, statSync } from "node:fs";
import { dirname, join } from "node:path";

const root = join(import.meta.dir, "..");
const outfile = join(root, "dist", "signetai", "dist", "mcp-stdio.js");
const entry = join(root, "platform", "daemon", "src", "mcp-stdio.ts");
const EXTERNAL = ["better-sqlite3", "@1password/sdk", "onnxruntime-node", "@huggingface/transformers"];
const ALIAS: Record<string, string> = {
	sharp: join(root, "platform", "daemon", "src", "shims", "sharp.ts"),
};

const result = await Bun.build({
	entrypoints: [entry],
	outdir: dirname(outfile),
	target: "node",
	format: "esm",
	external: EXTERNAL,
	alias: ALIAS,
	naming: "mcp-stdio.js",
});

if (!result.success) {
	for (const log of result.logs) {
		console.error(log);
	}
	process.exit(1);
}

if (!existsSync(outfile)) {
	console.error(`build-signet-mcp: expected ${outfile} was not produced`);
	process.exit(1);
}

const mb = (statSync(outfile).size / 1024 / 1024).toFixed(1);
console.log(`Built signet-mcp stdio bundle: ${outfile} (${mb} MB)`);

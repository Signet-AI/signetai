#!/usr/bin/env bun
/**
 * Build the published signet-mcp stdio adapter.
 *
 * Stage the tiny JavaScript adapter for the native Rust MCP stdio binary.
 * Node/Bun only resolves and execs the staged binary; all protocol and
 * daemon work remains in Rust.
 *
 * The bundle is rebuilt on every release. The package bin points directly
 * at this staged adapter, so consumers receive the native resolver rather
 * than a JavaScript daemon implementation.
 *
 * Bun is only used to stage the adapter during the build. The published
 * adapter itself is plain JavaScript and has no Bun-specific imports.
 */

import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

const root = join(import.meta.dir, "..");
const outfile = join(root, "dist", "signetai", "dist", "mcp-stdio.js");
const entry = join(root, "platform", "daemon", "src", "mcp-stdio.ts");
const result = await Bun.build({
	entrypoints: [entry],
	outdir: dirname(outfile),
	target: "node",
	format: "esm",
	external: ["better-sqlite3", "@1password/sdk", "onnxruntime-node", "@huggingface/transformers"],
	naming: "mcp-stdio.js",
});
if (!result.success) {
	for (const log of result.logs) console.error(log);
	process.exit(1);
}
if (!existsSync(outfile)) {
	console.error(`build-signet-mcp: expected ${outfile} was not produced`);
	process.exit(1);
}
console.log(`Built signet-mcp stdio bundle: ${outfile}`);

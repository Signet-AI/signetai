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

import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

const root = join(import.meta.dir, "..");
const outfile = join(root, "dist", "signetai", "bin", "signet-mcp.js");
const entry = join(root, "scripts", "signet-mcp-launcher.js");

mkdirSync(dirname(outfile), { recursive: true });
await Bun.write(outfile, await Bun.file(entry).text());
chmodSync(outfile, 0o755);
if (!existsSync(outfile)) {
	console.error(`build-signet-mcp: expected ${outfile} was not produced`);
	process.exit(1);
}
console.log(`Staged native signet-mcp launcher: ${outfile}`);

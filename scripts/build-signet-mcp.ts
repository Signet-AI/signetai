#!/usr/bin/env bun
/**
 * Build the published signet-mcp stdio server bundle.
 *
 * Stage the tiny Node adapter for the native Rust MCP stdio binary.
 * Node/Bun only resolves and execs the staged binary; all protocol and
 * daemon work remains in Rust.
 *
 * The bundle is rebuilt on every release. The bin entry in
 * `dist/signetai/package.json` symlinks directly at this file, restoring
 * the 0.138.11 stdio-server contract that PR #816 inadvertently replaced
 * with the management CLI.
 *
 * The bundle's `target` is `node` because that is its consumer — the
 * test harness at `scripts/signet-mcp-stdio-smoke.test.ts` spawns it
 * under `node`, and downstream harnesses do the same. Using `target:
 * "bun"` would add a `// @bun` pragma and resolve `"bun"`-conditioned
 * imports at build time, both of which are wrong for a Node consumer.
 *
 * Bun is only used to *build* the bundle (Bun.build supports module
 * aliases that the `bun build` CLI does not expose — we need the
 * `sharp` alias to keep the bundle self-contained if
 * `@huggingface/transformers` is ever pulled in transitively). The
 * `prebuild` script in the meta-package runs under Bun, so this is
 * fine; do not invoke this under Node.
 */

import { existsSync } from "node:fs";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

const root = join(import.meta.dir, "..");
const outfile = join(root, "dist", "signetai", "bin", "signet-mcp.js");
const entry = join(root, "scripts", "signet-mcp-launcher.js");

mkdirSync(dirname(outfile), { recursive: true });
await Bun.write(outfile, await Bun.file(entry).text());
if (!existsSync(outfile)) {
	console.error(`build-signet-mcp: expected ${outfile} was not produced`);
	process.exit(1);
}
console.log(`Staged native signet-mcp launcher: ${outfile}`);

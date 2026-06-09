#!/usr/bin/env bun
/**
 * Build the published signet-mcp stdio server bundle.
 *
 * The published `signetai` npm package wraps a precompiled native binary for
 * the `signet` CLI, but MCP harnesses spawn `signet-mcp` as a stdio JSON-RPC
 * server. The native binary's `signet mcp` subcommand is a management
 * surface (list/tools/call/analytics), not a stdio transport — so we ship
 * a self-contained Node-runnable bundle of the daemon's MCP stdio entry
 * point alongside the wrapper.
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

import { existsSync, statSync } from "node:fs";
import { dirname, join } from "node:path";

const root = join(import.meta.dir, "..");
const outfile = join(root, "dist", "signetai", "dist", "mcp-stdio.js");
const entry = join(root, "platform", "daemon", "src", "mcp-stdio.ts");

// Mirrors the workspace daemon build. mcp-stdio does not pull any of
// these in directly today, but keeping the externals (and the sharp
// alias) consistent with platform/daemon/build.ts avoids surprise
// build failures if the tool surface ever starts using native deps or
// pulls @huggingface/transformers transitively. The `bun build` CLI
// does not expose aliases, so we use Bun.build directly.
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

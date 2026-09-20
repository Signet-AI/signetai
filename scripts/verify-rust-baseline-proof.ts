#!/usr/bin/env bun
/** Run the narrow Rust backend proof lanes against the frozen baseline checkout. */
import { existsSync } from "node:fs";
import { resolve } from "node:path";

const repo = resolve(import.meta.dir, "..");
const baseline = process.env.SIGNET_BASELINE ?? "/mnt/work/hermes-scratch/pr-1867-main";
const binary = process.env.SIGNET_RUST_DAEMON_BIN;
if (!binary || !existsSync(binary)) {
	console.error("FAIL CLOSED: SIGNET_RUST_DAEMON_BIN must name an existing Rust daemon binary");
	process.exit(2);
}
if (!existsSync(baseline)) throw new Error(`baseline checkout missing: ${baseline}`);

const daemonTest = `${baseline}/platform/daemon/src/workspace-startup.test.ts`;
const preload = `${repo}/scripts/rust-baseline-proof-daemon.preload.ts`;
console.error(JSON.stringify({ backend: "rust-daemon", binary, pid: process.pid, baseline, test: daemonTest }));
const daemon = Bun.spawnSync(["bun", "test", "--preload", preload, daemonTest], {
	cwd: baseline,
	env: { ...process.env, SIGNET_RUST_DAEMON_BIN: binary },
	stdout: "inherit",
	stderr: "inherit",
});
if (daemon.exitCode !== 0) process.exit(daemon.exitCode ?? 1);

// The frozen Database test cannot be forwarded faithfully: its contract requires
// addMemory provenance columns (sourceId/sourceType/sourcePath/runtimePath,
// idempotencyKey, manualOverride) and reads memory_kind through bun:sqlite.
// Rust Operation::Remember accepts only content/metadata and the Rust owner does
// not expose the legacy addMemory shape. Refuse rather than fake or call TS core.
console.error("BLOCKED: database.test.ts has no faithful Rust adapter boundary");
console.error(
	"BLOCKER: Rust Operation::Remember lacks the tested provenance fields and the test directly observes memory_kind via bun:sqlite",
);
process.exit(3);

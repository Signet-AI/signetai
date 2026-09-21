#!/usr/bin/env bun
/** Run the narrow supplementary Rust proofs against the immutable baseline checkout. */
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

const repo = resolve(import.meta.dir, "..");
const baseline = process.env.SIGNET_BASELINE ?? "/mnt/work/hermes-scratch/pr-1867-main";
const daemonBinary = process.env.SIGNET_RUST_DAEMON_BIN;
const coreDriver = process.env.SIGNET_RUST_CORE_DRIVER_BIN;
const expectedBaseline = "11e4720c07107caf7fdd57a685eca24e8a82e654";

function fail(status: number, message: string): never {
	console.error(`FAIL CLOSED [${status}]: ${message}`);
	process.exit(status);
}

function requireArtifact(name: string, value: string | undefined, status: number): string {
	if (!value) fail(status, `${name} must be explicitly set to an existing Rust proof artifact`);
	const path = resolve(value);
	if (!existsSync(path) || !statSync(path).isFile()) fail(status, `${name} is missing or stale: ${path}`);
	return path;
}

if (!existsSync(baseline)) fail(7, `baseline checkout missing: ${baseline}`);
const baselineHead = Bun.spawnSync(["git", "-C", baseline, "rev-parse", "HEAD"], { stdout: "pipe", stderr: "pipe" });
const head = new TextDecoder().decode(baselineHead.stdout).trim();
if (baselineHead.exitCode !== 0 || head !== expectedBaseline) {
	fail(7, `baseline HEAD must be ${expectedBaseline}; got ${head || "unavailable"}`);
}

const daemon = requireArtifact("SIGNET_RUST_DAEMON_BIN", daemonBinary, 2);
const core = requireArtifact("SIGNET_RUST_CORE_DRIVER_BIN", coreDriver, 3);
const daemonTest = `${baseline}/platform/daemon/src/workspace-startup.test.ts`;
const coreTest = `${baseline}/platform/core/src/database.test.ts`;
const daemonPreload = `${repo}/scripts/rust-baseline-proof-daemon.preload.ts`;
const corePreload = `${repo}/scripts/rust-baseline-proof-core.preload.ts`;

function runProof(label: string, command: string[], cwd: string, env: Record<string, string>, status: number): void {
	console.error(
		JSON.stringify({
			label,
			backend: "fresh-rust",
			artifact: env.SIGNET_RUST_DAEMON_BIN ?? env.SIGNET_RUST_CORE_DRIVER_BIN,
			pid: process.pid,
			baseline,
			test: command.at(-1),
			account: "supplementary-baseline-proof",
		}),
	);
	const evidenceDir = label === "core-database" ? mkdtempSync(`${tmpdir()}/signet-rust-core-evidence-`) : undefined;
	let failure: string | undefined;
	try {
		const childEnv = evidenceDir ? { ...env, SIGNET_RUST_CORE_EVIDENCE_FILE: `${evidenceDir}/evidence.log` } : env;
		const result = Bun.spawnSync(command, {
			cwd,
			env: { ...process.env, ...childEnv },
			stdout: "inherit",
			stderr: "pipe",
		});
		const stderr = new TextDecoder().decode(result.stderr);
		if (stderr) process.stderr.write(`[${label} child stderr]\n${stderr}`);
		console.error(JSON.stringify({ label, exitCode: result.exitCode }));
		if (result.exitCode !== 0) failure = `${label} proof failed with exit ${result.exitCode ?? "unknown"}`;
	} finally {
		if (evidenceDir) rmSync(evidenceDir, { recursive: true, force: true });
	}
	if (failure) fail(status, failure);
}

runProof(
	"daemon-workspace-startup",
	["bun", "test", "--preload", daemonPreload, daemonTest],
	baseline,
	{ SIGNET_RUST_DAEMON_BIN: daemon },
	5,
);
runProof(
	"core-database",
	["bun", "test", "--preload", corePreload, coreTest],
	baseline,
	{ SIGNET_RUST_CORE_DRIVER_BIN: core },
	6,
);
console.error(
	JSON.stringify({ status: "PASS", scope: "supplementary proofs only", fullSharedCorpus: false, baseline, head }),
);

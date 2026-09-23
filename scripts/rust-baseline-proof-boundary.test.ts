import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { replaceDaemonLaunch } from "./rust-baseline-proof-daemon-launch";
import { formatFreshRustCoreEvidence, isFreshRustCoreEvidenceLine } from "./rust-baseline-proof-evidence";

describe("Rust shared-corpus native boundary evidence", () => {
	test("replaces absolute, project-relative, and bare daemon script forms", () => {
		const binary = "/scratch/signet-daemon";
		expect(
			replaceDaemonLaunch(
				["/usr/bin/bun", "--smol", "/checkout/platform/daemon/src/daemon.ts", "--port", "39817"],
				binary,
			),
		).toEqual([binary, "--port", "39817"]);
		expect(replaceDaemonLaunch(["/usr/bin/bun", "platform/daemon/src/daemon.ts"], binary)).toEqual([binary]);
		expect(replaceDaemonLaunch("daemon.ts", binary)).toEqual([binary]);
	});

	test("does not replace unrelated child processes", () => {
		expect(
			replaceDaemonLaunch(["/usr/bin/bun", "/checkout/platform/core/src/worker.ts"], "/scratch/signet-daemon"),
		).toBe(null);
	});

	test("accepts only an exact structured core record after a successful native transport response", () => {
		const driver = "/scratch/signet-core-test-driver";
		const line = formatFreshRustCoreEvidence(driver, "database.addMemory");
		expect(JSON.parse(line)).toMatchObject({
			backend: "fresh-rust",
			artifact: "signet-core-test-driver",
			process: "transport",
			driver,
			operation: "database.addMemory",
			status: "ok",
		});
		expect(isFreshRustCoreEvidenceLine(line, driver)).toBe(true);
		expect(isFreshRustCoreEvidenceLine(`${line}suffix`, driver)).toBe(false);
		expect(isFreshRustCoreEvidenceLine(line.replace(driver, `${driver}/attacker`), driver)).toBe(false);
		expect(isFreshRustCoreEvidenceLine(line.replace('"status":"ok"', '"status":"not-ok"'), driver)).toBe(false);
	});

	test("does not emit evidence when spawnSync cannot create the configured native child", () => {
		const directory = `/mnt/work/hermes-scratch/daemon-spawn-sync-test-${process.pid}`;
		const evidence = `${directory}.evidence`;
		rmSync(directory, { recursive: true, force: true });
		rmSync(evidence, { force: true });
		mkdirSync(directory, { recursive: true });
		try {
			const result = spawnSync(
				process.execPath,
				[
					"--preload",
					resolve(import.meta.dir, "rust-baseline-proof-daemon.preload.ts"),
					"-e",
					'Bun.spawnSync(["daemon.ts"])',
				],
				{
					cwd: process.cwd(),
					env: {
						...process.env,
						SIGNET_RUST_DAEMON_BIN: directory,
						SIGNET_RUST_DAEMON_EVIDENCE_FILE: evidence,
						SIGNET_RUST_EVIDENCE_NONCE: "test-nonce",
					},
					encoding: "utf8",
				},
			);
			expect(result.status).not.toBe(0);
			expect(existsSync(evidence)).toBe(false);
		} finally {
			rmSync(directory, { recursive: true, force: true });
			rmSync(evidence, { force: true });
		}
	});
});

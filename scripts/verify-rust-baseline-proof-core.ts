import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

// biome-ignore lint/suspicious/noUndeclaredEnvVars: explicit native proof artifact
const driver = process.env.SIGNET_RUST_CORE_DRIVER_BIN;
if (!driver) throw new Error("SIGNET_RUST_CORE_DRIVER_BIN is required");
const path = resolve(driver);
if (!existsSync(path) || !statSync(path).isFile()) throw new Error(`stale or missing driver: ${path}`);
const test = "/mnt/work/hermes-scratch/pr-1867-main/platform/core/src/database.test.ts";
console.error(`backend=fresh-rust artifact=${path} process=verifier pid=${process.pid} account=baseline-proof`);
const evidenceDir = mkdtempSync(join(tmpdir(), "signet-rust-core-evidence-"));
let exitCode: number | null;
try {
	const result = Bun.spawnSync(["bun", "test", "--preload", "./scripts/rust-baseline-proof-core.preload.ts", test], {
		env: {
			...process.env,
			SIGNET_RUST_CORE_DRIVER_BIN: path,
			SIGNET_RUST_CORE_EVIDENCE_FILE: join(evidenceDir, "evidence.log"),
		},
		stdout: "inherit",
		stderr: "inherit",
	});
	exitCode = result.exitCode;
} finally {
	rmSync(evidenceDir, { recursive: true, force: true });
}
process.exit(exitCode ?? 1);

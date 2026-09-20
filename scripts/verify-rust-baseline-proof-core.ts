import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";

// biome-ignore lint/suspicious/noUndeclaredEnvVars: explicit native proof artifact
const driver = process.env.SIGNET_RUST_CORE_DRIVER_BIN;
if (!driver) throw new Error("SIGNET_RUST_CORE_DRIVER_BIN is required");
const path = resolve(driver);
if (!existsSync(path) || !statSync(path).isFile()) throw new Error(`stale or missing driver: ${path}`);
const test = "/mnt/work/hermes-scratch/pr-1867-main/platform/core/src/database.test.ts";
console.error(`backend=fresh-rust artifact=${path} process=verifier pid=${process.pid} account=baseline-proof`);
const result = Bun.spawnSync(["bun", "test", "--preload", "./scripts/rust-baseline-proof-core.preload.ts", test], {
	env: { ...process.env, SIGNET_RUST_CORE_DRIVER_BIN: path },
	stdout: "inherit",
	stderr: "inherit",
});
process.exit(result.exitCode);

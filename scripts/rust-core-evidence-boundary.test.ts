import { test, expect } from "bun:test";
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const preload = resolve(import.meta.dir, "rust-baseline-proof-core.preload.ts");
const fixture = resolve(import.meta.dir, "rust-core-evidence-boundary.fixture.ts");

test("preload emits core evidence only after a driver request", () => {
	const result = Bun.spawnSync(["bun", "test", "--preload", preload, fixture], {
		cwd: root,
		env: { ...process.env, SIGNET_RUST_CORE_DRIVER_BIN: "/bin/true" },
		stdout: "pipe",
		stderr: "pipe",
	});
	const stderr = new TextDecoder().decode(result.stderr);
	expect(result.exitCode).toBe(0);
	expect(stderr).not.toContain("backend=fresh-rust artifact=signet-core-test-driver");
});

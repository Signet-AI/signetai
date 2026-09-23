import { test, expect } from "bun:test";
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const preload = resolve(import.meta.dir, "rust-baseline-proof-core.preload.ts");
const fixture = resolve(import.meta.dir, "rust-core-evidence-boundary.fixture.ts");

test("preload emits core evidence only after a driver request", async () => {
	const evidenceFile = `/tmp/signet-rust-core-evidence-${process.pid}`;
	const loadOnly = Bun.spawnSync(["bun", "test", "--preload", preload, `./${fixture.slice(root.length + 1)}`], {
		cwd: root,
		env: { ...process.env, SIGNET_RUST_CORE_DRIVER_BIN: "/bin/true", SIGNET_RUST_CORE_EVIDENCE_FILE: evidenceFile },
		stdout: "pipe",
		stderr: "pipe",
	});
	expect(loadOnly.exitCode).toBe(0);
	expect(new TextDecoder().decode(loadOnly.stderr)).not.toContain(
		"backend=fresh-rust artifact=signet-core-test-driver",
	);
	expect(await Bun.file(evidenceFile).exists()).toBe(false);

	const invoked = Bun.spawnSync(["bun", "test", "--preload", preload, `./${fixture.slice(root.length + 1)}`], {
		cwd: root,
		env: {
			...process.env,
			SIGNET_RUST_CORE_DRIVER_BIN: "/bin/cat",
			SIGNET_RUST_CORE_EVIDENCE_FILE: evidenceFile,
			SIGNET_RUST_CORE_EVIDENCE_PROBE: "1",
		},
		stdout: "pipe",
		stderr: "pipe",
	});
	expect(invoked.exitCode).toBe(0);
	expect(await Bun.file(evidenceFile).text()).toContain(
		"backend=fresh-rust artifact=signet-core-test-driver process=transport",
	);
	Bun.spawnSync(["rm", "-f", evidenceFile]);
});

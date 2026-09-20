import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const repoRoot = join(import.meta.dir, "../..");
// biome-ignore lint/suspicious/noUndeclaredEnvVars: contract selects the compiled daemon binary
const bin = process.env.SIGNET_RUST_DAEMON_BIN ?? join(repoRoot, "platform/rust-daemon/target/debug/signet-daemon");

async function waitForFile(path: string): Promise<void> {
	for (let attempt = 0; attempt < 200; attempt++) {
		if (existsSync(path)) return;
		await Bun.sleep(25);
	}
	throw new Error(`timed out waiting for ${path}`);
}

test("keeps the kernel-owned database lock path across graceful owner release", async () => {
	const workspace = mkdtempSync(join(tmpdir(), "signet-owner-lock-"));
	mkdirSync(join(workspace, "memory"), { recursive: true });
	mkdirSync(join(workspace, ".daemon"), { recursive: true });
	const marker = join(workspace, ".daemon", "db-owner.json");
	const lock = join(workspace, ".daemon", "db-owner.lock");
	const child = Bun.spawn([bin, "--db-owner"], {
		env: {
			...process.env,
			SIGNET_PATH: workspace,
		},
		stdin: "pipe",
		stdout: "pipe",
		stderr: "pipe",
	});
	try {
		await waitForFile(marker);
		const owner = JSON.parse(readFileSync(marker, "utf8")) as { generation: string; pid: number };
		expect(owner).toMatchObject({ pid: child.pid });
		expect(existsSync(lock)).toBe(true);
		child.stdin.write(`${JSON.stringify({ id: null, generation: owner.generation, op: "shutdown" })}\n`);
		await child.exited;
		expect(existsSync(lock)).toBe(true);
	} finally {
		if (child.exitCode === null) child.kill("SIGKILL");
		rmSync(workspace, { recursive: true, force: true });
	}
});

import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const repoRoot = join(import.meta.dir, "../..");
// biome-ignore lint/suspicious/noUndeclaredEnvVars: contract selects the compiled daemon binary
const bin = process.env.SIGNET_RUST_DAEMON_BIN ?? join(repoRoot, "platform/rust-daemon/target/debug/signet-daemon");

test("Windows owner lock includes a canonical parent-directory mutex", () => {
	const source = readFileSync(join(repoRoot, "platform/rust-daemon/src/main.rs"), "utf8");
	expect(source).toContain("canonical parent-directory mutex");
	expect(source).toContain("SignetDbOwnerParent-");
	expect(source).toContain("_parent_mutex: HANDLE");
});

async function waitForFile(path: string): Promise<void> {
	for (let attempt = 0; attempt < 200; attempt++) {
		if (existsSync(path)) return;
		await Bun.sleep(25);
	}
	throw new Error(`timed out waiting for ${path}`);
}

async function waitForOwnerPid(marker: string, pid: number): Promise<void> {
	for (let attempt = 0; attempt < 200; attempt++) {
		if (existsSync(marker)) {
			try {
				const owner = JSON.parse(readFileSync(marker, "utf8")) as { pid?: number };
				if (owner.pid === pid) return;
			} catch {
				// The owner writes the marker atomically during startup.
			}
		}
		await Bun.sleep(25);
	}
	throw new Error(`timed out waiting for owner pid ${pid}`);
}

test("rejects lock-path replacement while the canonical parent owner is live", async () => {
	if (process.platform !== "linux") return;
	const workspace = mkdtempSync(join(tmpdir(), "signet-owner-lock-replace-"));
	mkdirSync(join(workspace, "memory"), { recursive: true });
	mkdirSync(join(workspace, ".daemon"), { recursive: true });
	const marker = join(workspace, ".daemon", "db-owner.json");
	const lock = join(workspace, ".daemon", "db-owner.lock");
	const moved = join(workspace, ".daemon", "db-owner.lock.moved");
	const child = Bun.spawn([bin, "--db-owner"], {
		env: { ...process.env, SIGNET_PATH: workspace },
		stdin: "pipe",
		stdout: "pipe",
		stderr: "pipe",
	});
	try {
		await waitForFile(marker);
		renameSync(lock, moved);
		const competing = Bun.spawn([bin, "--db-owner"], {
			env: { ...process.env, SIGNET_PATH: workspace },
			stdout: "pipe",
			stderr: "pipe",
		});
		await competing.exited;
		expect(competing.exitCode).not.toBe(0);
		child.kill("SIGTERM");
		await child.exited;
		const replacement = Bun.spawn([bin, "--db-owner"], {
			env: { ...process.env, SIGNET_PATH: workspace },
			stdin: "pipe",
			stdout: "pipe",
			stderr: "pipe",
		});
		try {
			await waitForOwnerPid(marker, replacement.pid);
			expect(existsSync(lock)).toBe(true);
			const owner = JSON.parse(readFileSync(marker, "utf8")) as { generation: string };
			replacement.stdin.write(`${JSON.stringify({ id: null, generation: owner.generation, op: "shutdown" })}\n`);
			await replacement.exited;
			expect(replacement.exitCode).toBe(0);
			expect(existsSync(lock)).toBe(true);
		} finally {
			if (replacement.exitCode === null) replacement.kill("SIGKILL");
		}
	} finally {
		if (child.exitCode === null) child.kill("SIGKILL");
		rmSync(workspace, { recursive: true, force: true });
	}
});

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

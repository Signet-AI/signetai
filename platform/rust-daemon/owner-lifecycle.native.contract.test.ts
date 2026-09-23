import { afterEach, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const repoRoot = join(import.meta.dir, "../..");
// biome-ignore lint/suspicious/noUndeclaredEnvVars: contract selects a compiled daemon binary
const bin = process.env.SIGNET_RUST_DAEMON_BIN ?? join(repoRoot, "platform/rust-daemon/target/debug/signet-daemon");
const children: Bun.Subprocess[] = [];
const dirs: string[] = [];

async function waitFor<T>(fn: () => T | Promise<T>, label: string): Promise<T> {
	for (let i = 0; i < 240; i++) {
		try {
			const value = await fn();
			if (value) return value;
		} catch {}
		await Bun.sleep(25);
	}
	throw new Error(`timeout waiting for ${label}`);
}

function handles(pid: number, suffix: string) {
	return readdirSync(`/proc/${pid}/fd`).flatMap((fd) => {
		try {
			const target = readlinkSync(`/proc/${pid}/fd/${fd}`);
			return target.endsWith(suffix) ? [target] : [];
		} catch {
			return [];
		}
	});
}

async function start(dir = mkdtempSync(join(tmpdir(), "signet-owner-lifecycle-"))) {
	if (!dirs.includes(dir)) dirs.push(dir);
	const port = 40000 + Math.floor(Math.random() * 20000);
	const child = Bun.spawn([bin], {
		env: {
			...process.env,
			SIGNET_PATH: dir,
			SIGNET_BIND: "127.0.0.1",
			SIGNET_PORT: String(port),
			SIGNET_MODE: "local",
			SIGNET_API_KEY: "owner-contract-secret",
		},
		stdout: "pipe",
		stderr: "pipe",
	});
	children.push(child);
	const origin = `http://127.0.0.1:${port}`;
	await waitFor(async () => (await fetch(`${origin}/health/ready`)).ok, "HTTP readiness");
	const markerPath = join(dir, ".daemon", "db-owner.json");
	const marker = await waitFor(
		() => (existsSync(markerPath) ? JSON.parse(readFileSync(markerPath, "utf8")) : null),
		"owner marker",
	);
	return { child, dir, origin, markerPath, marker: marker as { pid: number; generation: string } };
}

afterEach(async () => {
	for (const child of children.splice(0)) {
		if (child.exitCode === null) {
			child.kill("SIGTERM");
			await Promise.race([child.exited, Bun.sleep(1500)]);
		}
	}
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

it("proves the fresh external owner process boundary and recovery lifecycle", async () => {
	const first = await start();
	const db = join(first.dir, "memory", "memories.db");
	expect(first.marker.pid).toBeGreaterThan(1);
	expect(handles(first.child.pid, "/memories.db")).toHaveLength(0);
	expect(handles(first.child.pid, "/memories.db-wal")).toHaveLength(0);
	expect(handles(first.child.pid, "/memories.db-shm")).toHaveLength(0);
	expect(
		handles(first.marker.pid, "/memories.db").length +
			handles(first.marker.pid, "/memories.db-wal").length +
			handles(first.marker.pid, "/memories.db-shm").length,
	).toBeGreaterThan(0);
	const competing = Bun.spawn([bin, "--db-owner"], {
		env: { ...process.env, SIGNET_PATH: first.dir },
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});
	expect(await competing.exited).not.toBe(0);
	process.kill(first.marker.pid, "SIGKILL");
	expect((await fetch(`${first.origin}/health/live`)).ok).toBe(true);
	const recovered = await waitFor(async () => {
		try {
			const r = await fetch(`${first.origin}/health/ready`);
			return r.ok ? JSON.parse(readFileSync(first.markerPath, "utf8")) : null;
		} catch {
			return null;
		}
	}, "owner replacement");
	expect(recovered.pid).not.toBe(first.marker.pid);
	expect(recovered.generation).not.toBe(first.marker.generation);
	const write = await fetch(`${first.origin}/api/memory/remember`, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			"x-signet-api-key": "owner-contract-secret",
			"x-signet-agent-id": "owner-contract-agent",
			"x-workspace-id": "owner-contract-workspace",
		},
		body: JSON.stringify({ content: "owner lifecycle proof", type: "fact" }),
	});
	const writeBody = await write.text();
	if (!write.ok) throw new Error(`post-recovery write failed: ${write.status} ${writeBody}`);
	expect(write.ok).toBe(true);
	expect(
		(
			await (
				await fetch(`${first.origin}/api/memory/search?q=owner%20lifecycle%20proof`, {
					headers: {
						"x-signet-api-key": "owner-contract-secret",
						"x-signet-agent-id": "owner-contract-agent",
						"x-workspace-id": "owner-contract-workspace",
					},
				})
			).text()
		).length,
	).toBeGreaterThan(0);
	first.child.kill("SIGTERM");
	await first.child.exited;
	expect(existsSync(first.markerPath)).toBe(false);
	expect(existsSync(db)).toBe(true);
});

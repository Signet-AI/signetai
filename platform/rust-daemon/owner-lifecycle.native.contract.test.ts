import { afterEach, expect, it } from "bun:test";
import {
	chmodSync,
	existsSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	readlinkSync,
	rmSync,
	writeFileSync,
} from "node:fs";
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

it(
	"fails stalled owner startup within the deadline and reaps the child process",
	async () => {
		const dir = mkdtempSync(join(tmpdir(), "signet-owner-startup-timeout-"));
		dirs.push(dir);
		const pidPath = join(dir, "stalled-owner.pid");
		const stubPath = join(dir, "stalled-owner.sh");
		writeFileSync(stubPath, '#!/bin/sh\necho "$$" > "$SIGNET_PATH/stalled-owner.pid"\nexec sleep 60\n');
		chmodSync(stubPath, 0o755);
		const child = Bun.spawn([bin], {
			env: {
				...process.env,
				SIGNET_PATH: dir,
				SIGNET_BIND: "127.0.0.1",
				SIGNET_PORT: "0",
				SIGNET_MODE: "local",
				SIGNET_API_KEY: "owner-contract-secret",
				SIGNET_DAEMON_BIN: stubPath,
			},
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
		});
		children.push(child);
		try {
			const exitCode = await Promise.race([child.exited, Bun.sleep(20_000).then(() => null)]);
			expect(exitCode).not.toBeNull();
			if (exitCode === null) return;
			expect(exitCode).not.toBe(0);
			expect(await new Response(child.stderr).text()).toContain("database owner startup");
			const ownerPid = Number(readFileSync(pidPath, "utf8"));
			expect(ownerPid).toBeGreaterThan(1);
			expect(() => process.kill(ownerPid, 0)).toThrow();
		} finally {
			if (child.exitCode === null) {
				child.kill("SIGKILL");
				await child.exited;
			}
			if (existsSync(pidPath)) {
				const ownerPid = Number(readFileSync(pidPath, "utf8"));
				try {
					process.kill(ownerPid, "SIGKILL");
				} catch {}
			}
		}
	},
	{ timeout: 25_000 },
);

it(
	"bounds a stalled owner response without replaying the write and keeps HTTP live",
	async () => {
		const dir = mkdtempSync(join(tmpdir(), "signet-owner-response-timeout-"));
		dirs.push(dir);
		const ownerPidsPath = join(dir, "owner-pids.log");
		const firstOwnerPidPath = join(dir, "first-owner.pid");
		const requestsPath = join(dir, "owner-requests.log");
		const stubPath = join(dir, "stalled-response-owner.cjs");
		writeFileSync(
			stubPath,
			[
				`#!${process.execPath}`,
				'const { appendFileSync, existsSync, writeFileSync } = require("node:fs");',
				'const generation = "stalled-response-generation";',
				'const firstPidPath = process.env.SIGNET_PATH + "/first-owner.pid";',
				'const pidsPath = process.env.SIGNET_PATH + "/owner-pids.log";',
				'const requestsPath = process.env.SIGNET_PATH + "/owner-requests.log";',
				"if (!existsSync(firstPidPath)) writeFileSync(firstPidPath, String(process.pid));",
				'appendFileSync(pidsPath, String(process.pid) + "\\n");',
				'process.stdout.write(JSON.stringify({ ready: true, generation }) + "\\n");',
				'const input = require("node:readline").createInterface({ input: process.stdin });',
				"(async () => {",
				"  for await (const line of input) {",
				"    const request = JSON.parse(line);",
				'    if (request.op === "shutdown") process.exit(0);',
				"    const operation = request.operation;",
				'    const kind = typeof operation === "string" ? operation : Object.keys(operation ?? {})[0];',
				'    if (kind === "Health") {',
				'      process.stdout.write(JSON.stringify({ id: request.id, generation, ok: true, result: { ready: true } }) + "\\n");',
				"      continue;",
				"    }",
				'    if (kind !== "Remember") {',
				'      process.stdout.write(JSON.stringify({ id: request.id, generation, ok: true, result: {} }) + "\\n");',
				"      continue;",
				"    }",
				'    appendFileSync(requestsPath, kind + "\\n");',
				"    await new Promise(() => {});",
				"  }",
				"})();",
			].join("\n"),
		);
		chmodSync(stubPath, 0o755);
		const portProbe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
		const port = portProbe.port;
		portProbe.stop(true);
		const child = Bun.spawn([bin], {
			env: {
				...process.env,
				SIGNET_PATH: dir,
				SIGNET_BIND: "127.0.0.1",
				SIGNET_PORT: String(port),
				SIGNET_MODE: "local",
				SIGNET_API_KEY: "owner-contract-secret",
				SIGNET_DAEMON_BIN: stubPath,
				SIGNET_DB_OWNER_RESPONSE_TIMEOUT_MS: "500",
			},
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
		});
		children.push(child);
		const origin = `http://127.0.0.1:${port}`;
		try {
			await waitFor(async () => (await fetch(`${origin}/health/live`)).ok, "HTTP liveness");
			const response = await Promise.race([
				fetch(`${origin}/api/memory/remember`, {
					method: "POST",
					headers: {
						"content-type": "application/json",
						"x-signet-api-key": "owner-contract-secret",
						"x-signet-agent-id": "owner-timeout-agent",
					},
					body: JSON.stringify({ content: "owner response timeout proof" }),
				}).then(async (result) => ({ status: result.status, body: await result.json() })),
				Bun.sleep(20_000).then(() => null),
			]);
			expect(response).not.toBeNull();
			if (response === null) return;
			expect(response.status).toBe(503);
			expect(response.body).toMatchObject({ code: "database_outcome_unknown" });
			expect(response.body.error).toContain("may have committed");
			expect(readFileSync(requestsPath, "utf8").trim().split("\n")).toEqual(["Remember"]);
			const firstOwnerPid = Number(readFileSync(firstOwnerPidPath, "utf8"));
			expect(firstOwnerPid).toBeGreaterThan(1);
			expect(() => process.kill(firstOwnerPid, 0)).toThrow();
			expect((await fetch(`${origin}/health/live`)).ok).toBe(true);
		} finally {
			if (child.exitCode === null) {
				child.kill("SIGTERM");
				await Promise.race([child.exited, Bun.sleep(1500)]);
				if (child.exitCode === null) {
					child.kill("SIGKILL");
					await child.exited;
				}
			}
			if (existsSync(ownerPidsPath)) {
				for (const rawPid of readFileSync(ownerPidsPath, "utf8").trim().split("\n")) {
					try {
						process.kill(Number(rawPid), "SIGKILL");
					} catch {}
				}
			}
		}
	},
	{ timeout: 25_000 },
);

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

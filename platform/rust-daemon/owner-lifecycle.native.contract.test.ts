import { Database as SqliteDatabase } from "bun:sqlite";
import { afterEach, expect, it } from "bun:test";
import {
	chmodSync,
	copyFileSync,
	existsSync,
	mkdirSync,
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
	const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
	const port = probe.port;
	probe.stop(true);
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
	try {
		await waitFor(async () => (await fetch(`${origin}/health/ready`)).ok, "HTTP readiness");
	} catch (error) {
		if (child.exitCode === null) {
			child.kill("SIGTERM");
			await Promise.race([child.exited, Bun.sleep(1500)]);
			if (child.exitCode === null) {
				child.kill("SIGKILL");
				await child.exited;
			}
		}
		const stderr = await new Response(child.stderr).text();
		throw new Error(`HTTP readiness failed: ${String(error)}\n${stderr}`);
	}
	const markerPath = join(dir, ".daemon", "db-owner.json");
	const marker = await waitFor(
		() => (existsSync(markerPath) ? JSON.parse(readFileSync(markerPath, "utf8")) : null),
		"owner marker",
	);
	return {
		child,
		dir,
		origin,
		markerPath,
		marker: marker as { pid: number; generation: string; database: string },
	};
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
		const ownerGenerationsPath = join(dir, "owner-generations.log");
		const firstOwnerPidPath = join(dir, "first-owner.pid");
		const descendantPidPath = join(dir, "descendant-owner.pid");
		const requestsPath = join(dir, "owner-requests.log");
		const stubPath = join(dir, "stalled-response-owner.cjs");
		writeFileSync(
			stubPath,
			[
				`#!${process.execPath}`,
				'const { appendFileSync, existsSync, readFileSync, writeFileSync } = require("node:fs");',
				'const { spawn } = require("node:child_process");',
				'const generation = require("node:crypto").randomUUID();',
				'const firstPidPath = process.env.SIGNET_PATH + "/first-owner.pid";',
				'const pidsPath = process.env.SIGNET_PATH + "/owner-pids.log";',
				'const generationsPath = process.env.SIGNET_PATH + "/owner-generations.log";',
				'const descendantPidPath = process.env.SIGNET_PATH + "/descendant-owner.pid";',
				'const requestsPath = process.env.SIGNET_PATH + "/owner-requests.log";',
				"if (!existsSync(firstPidPath)) writeFileSync(firstPidPath, String(process.pid));",
				'const descendant = spawn(process.execPath, ["-e", "setInterval(() => {}, 60000)"], { stdio: "inherit" });',
				"writeFileSync(descendantPidPath, String(descendant.pid));",
				'appendFileSync(pidsPath, String(process.pid) + "\\n");',
				'appendFileSync(generationsPath, generation + "\\n");',
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
				'    appendFileSync(requestsPath, kind + ":" + generation + "\\n");',
				'    if (process.pid !== Number(readFileSync(firstPidPath, "utf8"))) {',
				'      process.stdout.write(JSON.stringify({ id: request.id, generation, ok: "invalid", result: {} }) + "\\n");',
				"      continue;",
				"    }",
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
				Bun.sleep(4_000).then(() => null),
			]);
			expect(response).not.toBeNull();
			if (response === null) return;
			expect(response.status).toBe(503);
			expect(response.body).toMatchObject({ code: "database_outcome_unknown" });
			expect(response.body.error).toContain("may have committed");
			expect(readFileSync(requestsPath, "utf8").trim().split("\n")).toHaveLength(1);
			const firstOwnerPid = Number(readFileSync(firstOwnerPidPath, "utf8"));
			expect(firstOwnerPid).toBeGreaterThan(1);
			expect(() => process.kill(firstOwnerPid, 0)).toThrow();
			const descendantPid = Number(readFileSync(descendantPidPath, "utf8"));
			expect(descendantPid).toBeGreaterThan(1);
			expect(() => process.kill(descendantPid, 0)).toThrow();
			expect((await fetch(`${origin}/health/live`)).ok).toBe(true);
			const recovered = await fetch(`${origin}/api/sources`, {
				headers: {
					"x-signet-api-key": "owner-contract-secret",
					"x-signet-agent-id": "owner-timeout-agent",
				},
			});
			expect(recovered.status).toBe(200);
			const ownerGenerations = readFileSync(ownerGenerationsPath, "utf8").trim().split("\n");
			expect(ownerGenerations).toHaveLength(2);
			expect(new Set(ownerGenerations).size).toBe(2);
			expect(readFileSync(requestsPath, "utf8").trim().split("\n")).toHaveLength(1);
			const malformedAcknowledgement = await fetch(`${origin}/api/memory/remember`, {
				method: "POST",
				headers: {
					"content-type": "application/json",
					"x-signet-api-key": "owner-contract-secret",
					"x-signet-agent-id": "owner-timeout-agent",
				},
				body: JSON.stringify({ content: "malformed owner acknowledgement proof" }),
			});
			expect(malformedAcknowledgement.status).toBe(503);
			expect(await malformedAcknowledgement.json()).toMatchObject({ code: "database_outcome_unknown" });
			const afterMalformedAcknowledgement = await fetch(`${origin}/api/sources`, {
				headers: {
					"x-signet-api-key": "owner-contract-secret",
					"x-signet-agent-id": "owner-timeout-agent",
				},
			});
			expect(afterMalformedAcknowledgement.status).toBe(200);
			const finalGenerations = readFileSync(ownerGenerationsPath, "utf8").trim().split("\n");
			expect(finalGenerations).toHaveLength(3);
			expect(new Set(finalGenerations).size).toBe(3);
			expect(readFileSync(requestsPath, "utf8").trim().split("\n")).toHaveLength(2);
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
			if (existsSync(descendantPidPath)) {
				try {
					process.kill(Number(readFileSync(descendantPidPath, "utf8")), "SIGKILL");
				} catch {}
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

it("upgrades pinned TypeScript v153 through the production owner process and survives restart", async () => {
	const dir = mkdtempSync(join(tmpdir(), "signet-owner-ts-v153-"));
	dirs.push(dir);
	const database = join(dir, "memory", "memories.db");
	mkdirSync(join(dir, "memory"), { recursive: true });
	copyFileSync(join(repoRoot, "platform/rust-core/tests/fixtures/ts_applied_153.sqlite"), database);

	const first = await start(dir);
	expect(first.marker.database).toBe(database);
	expect(handles(first.child.pid, "/memories.db")).toHaveLength(0);
	expect(handles(first.marker.pid, "/memories.db").length).toBeGreaterThan(0);
	const firstResponse = await fetch(`${first.origin}/api/sources`, {
		headers: {
			"x-signet-api-key": "owner-contract-secret",
			"x-signet-agent-id": "default",
		},
	});
	expect(firstResponse.status).toBe(200);
	first.child.kill("SIGTERM");
	expect(await first.child.exited).toBe(0);
	expect(existsSync(first.markerPath)).toBe(false);
	expect(existsSync(database)).toBe(true);

	const second = await start(dir);
	const secondResponse = await fetch(`${second.origin}/api/sources`, {
		headers: {
			"x-signet-api-key": "owner-contract-secret",
			"x-signet-agent-id": "default",
		},
	});
	expect(secondResponse.status).toBe(200);
	second.child.kill("SIGTERM");
	expect(await second.child.exited).toBe(0);
	expect(existsSync(second.markerPath)).toBe(false);
	expect(existsSync(database)).toBe(true);
});

// Pinned TypeScript baseline 11e4720c07107caf7fdd57a685eca24e8a82e654 produced schema v1-v80; only row 79 was deleted, with its audit retained (source SHA-256: 9d75b98ef0fe790b73a1ea07c6a149041a76024c8a89c0aac131f2f42b87c6a9).
it("repairs a missing TypeScript v79 history row through the real owner and survives restart", async () => {
	const dir = mkdtempSync(join(tmpdir(), "signet-owner-ts-v79-repair-"));
	dirs.push(dir);
	const database = join(dir, "memory", "memories.db");
	mkdirSync(join(dir, "memory"), { recursive: true });
	copyFileSync(join(repoRoot, "platform/rust-core/tests/fixtures/ts_v80_missing_79.sqlite"), database);

	const seed = new SqliteDatabase(database);
	seed
		.prepare(
			"INSERT INTO documents(id,source_type,metadata_json,agent_id,project,created_at,updated_at) VALUES('v79-sentinel','test',NULL,'fixture-agent','/sentinel','2026-09-26','2026-09-26')",
		)
		.run();
	seed.close();

	const first = await start(dir);
	expect(first.marker.database).toBe(database);
	expect(handles(first.child.pid, "/memories.db")).toHaveLength(0);
	expect(handles(first.marker.pid, "/memories.db").length).toBeGreaterThan(0);
	const firstResponse = await fetch(`${first.origin}/api/sources`, {
		headers: {
			"x-signet-api-key": "owner-contract-secret",
			"x-signet-agent-id": "default",
		},
	});
	expect(firstResponse.status).toBe(200);
	first.child.kill("SIGTERM");
	expect(await first.child.exited).toBe(0);
	expect(existsSync(first.markerPath)).toBe(false);
	expect(existsSync(database)).toBe(true);
	const verifyFirst = new SqliteDatabase(database, { readonly: true });
	expect(verifyFirst.query("SELECT checksum FROM schema_migrations WHERE version=79").get()).toEqual({
		checksum: "5939169c",
	});
	expect(verifyFirst.query("SELECT count(*) AS n FROM schema_migrations_audit WHERE version=79").get()).toEqual({
		n: 2,
	});
	expect(
		verifyFirst
			.query(
				"SELECT count(*) AS n FROM sqlite_master WHERE type='index' AND name IN ('idx_transcript_capture_jobs_status','idx_transcript_capture_jobs_agent_session')",
			)
			.get(),
	).toEqual({ n: 2 });
	expect(verifyFirst.query("SELECT agent_id,project FROM documents WHERE id='v79-sentinel'").get()).toEqual({
		agent_id: "fixture-agent",
		project: "/sentinel",
	});
	verifyFirst.close();

	const second = await start(dir);
	const secondResponse = await fetch(`${second.origin}/api/sources`, {
		headers: {
			"x-signet-api-key": "owner-contract-secret",
			"x-signet-agent-id": "default",
		},
	});
	expect(secondResponse.status).toBe(200);
	second.child.kill("SIGTERM");
	expect(await second.child.exited).toBe(0);
	expect(existsSync(second.markerPath)).toBe(false);
	expect(existsSync(database)).toBe(true);
	const verifySecond = new SqliteDatabase(database, { readonly: true });
	expect(verifySecond.query("SELECT checksum FROM schema_migrations WHERE version=79").get()).toEqual({
		checksum: "5939169c",
	});
	expect(verifySecond.query("SELECT count(*) AS n FROM schema_migrations_audit WHERE version=79").get()).toEqual({
		n: 2,
	});
	expect(
		verifySecond
			.query(
				"SELECT count(*) AS n FROM sqlite_master WHERE type='index' AND name IN ('idx_transcript_capture_jobs_status','idx_transcript_capture_jobs_agent_session')",
			)
			.get(),
	).toEqual({ n: 2 });
	expect(verifySecond.query("SELECT agent_id,project FROM documents WHERE id='v79-sentinel'").get()).toEqual({
		agent_id: "fixture-agent",
		project: "/sentinel",
	});
	verifySecond.close();
});

it("admits an authentic TypeScript v157 database through the production owner process", async () => {
	const dir = mkdtempSync(join(tmpdir(), "signet-owner-ts-schema-"));
	dirs.push(dir);
	const database = join(dir, "memory", "memories.db");
	mkdirSync(join(dir, "memory"), { recursive: true });
	copyFileSync(join(repoRoot, "platform/rust-core/tests/fixtures/ts_applied_157.sqlite"), database);
	const running = await start(dir);

	expect(running.marker.database).toBe(database);
	expect(running.marker.pid).not.toBe(running.child.pid);
	expect(handles(running.child.pid, "/memories.db")).toHaveLength(0);
	expect(handles(running.child.pid, "/memories.db-wal")).toHaveLength(0);
	expect(handles(running.child.pid, "/memories.db-shm")).toHaveLength(0);
	expect(handles(running.marker.pid, "/memories.db").length).toBeGreaterThan(0);

	const response = await fetch(`${running.origin}/api/sources`, {
		headers: {
			"x-signet-api-key": "owner-contract-secret",
			"x-signet-agent-id": "fixture-agent",
		},
	});
	expect(response.status).toBe(200);

	running.child.kill("SIGTERM");
	expect(await running.child.exited).toBe(0);
	expect(existsSync(running.markerPath)).toBe(false);
	expect(existsSync(database)).toBe(true);
});

import { createHmac, randomBytes } from "node:crypto";
import { Database } from "bun:sqlite";
import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// biome-ignore lint/suspicious/noUndeclaredEnvVars: test-only binary override
const bin = process.env.SIGNET_RUST_DAEMON_BIN ?? join(import.meta.dir, "target/release/signet-daemon");
type Session = { origin: string; workspace: string; child: ReturnType<typeof Bun.spawn> };
const sessions: Session[] = [];
async function reservePort(): Promise<number> {
	const server = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
	const port = server.port;
	server.stop(true);
	return port;
}
async function start(workspacePath?: string) {
	const workspace = workspacePath ?? mkdtempSync(join(tmpdir(), "signet-transcript-"));
	const port = await reservePort();
	const child = Bun.spawn([bin], {
		env: {
			...process.env,
			SIGNET_PATH: workspace,
			SIGNET_DAEMON_BIN: bin,
			SIGNET_PORT: String(port),
			SIGNET_BIND: "127.0.0.1",
			SIGNET_AGENT_ID: "",
			SIGNET_AUTH_MODE: "local",
			SIGNET_API_KEY: "",
			SIGNET_TOKEN: "",
		},
		stdout: "ignore",
		stderr: "pipe",
	});
	const origin = `http://127.0.0.1:${port}`;
	for (let i = 0; i < 100; i++) {
		try {
			if ((await fetch(`${origin}/health/ready`)).ok) {
				const session = { origin, workspace, child };
				sessions.push(session);
				return session;
			}
		} catch {}
		await Bun.sleep(20);
	}
	child.kill("SIGKILL");
	await child.exited.catch(() => -1);
	rmSync(workspace, { recursive: true, force: true });
	throw new Error("daemon not ready");
}
async function stop(s: Session) {
	s.child.kill("SIGTERM");
	const exited = await Promise.race([s.child.exited.then(() => true), Bun.sleep(1_000).then(() => false)]);
	if (!exited) s.child.kill("SIGKILL");
	await s.child.exited.catch(() => -1);
}

function signedToken(secret: Uint8Array, claims: Readonly<Record<string, unknown>>): string {
	const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
	const signature = createHmac("sha256", secret).update(payload).digest("base64url");
	return `${payload}.${signature}`;
}

afterEach(async () => {
	for (const s of sessions.splice(0)) {
		await stop(s);
		rmSync(s.workspace, { recursive: true, force: true });
	}
});
describe("fresh rust transcript contracts", () => {
	it("accepts bounded scoped imports and reads stored transcripts after restart", async () => {
		const s = await start();
		const h = { "content-type": "application/json", "x-signet-agent": "a" };
		const job = await fetch(`${s.origin}/api/sources/imports`, {
			method: "POST",
			headers: h,
			body: JSON.stringify({ files: [{ name: "a.jsonl" }] }),
		});
		expect(job.status).toBe(201);
		const id = (await job.json()).id;
		expect((await fetch(`${s.origin}/api/sources/imports/${id}`, { headers: h })).status).toBe(200);
		expect((await fetch(`${s.origin}/api/sources/imports/${id}`, { headers: { "x-signet-agent": "b" } })).status).toBe(
			404,
		);
		const put = await fetch(`${s.origin}/api/transcripts`, {
			method: "POST",
			headers: { ...h, "idempotency-key": "t1" },
			body: JSON.stringify({ sessionKey: "s1", harness: "bun", content: "hello", idempotency_key: "t1" }),
		});
		expect(put.status).toBe(200);
		await stop(s);
		const stoppedIndex = sessions.indexOf(s);
		if (stoppedIndex >= 0) sessions.splice(stoppedIndex, 1);
		const restarted = await start(s.workspace);
		expect((await fetch(`${restarted.origin}/api/transcripts`, { headers: h })).status).toBe(200);
		const transcript = await fetch(`${restarted.origin}/api/sessions/s1/transcript`, { headers: h });
		expect(transcript.status).toBe(200);
		expect(await transcript.json()).toEqual({ sessionKey: "s1", agentId: "a", content: "hello" });
	});
	it("rejects invalid and oversized import payloads", async () => {
		const s = await start();
		const r = await fetch(`${s.origin}/api/sources/imports`, {
			method: "POST",
			headers: { "content-type": "application/json", "x-signet-agent": "a" },
			body: JSON.stringify({ files: [] }),
		});
		expect(r.status).toBe(400);
		await stop(s);
		sessions.splice(sessions.indexOf(s), 1);
		rmSync(s.workspace, { recursive: true, force: true });
	});
});

it("serves stored session transcript through owner-scoped HTTP lookup", async () => {
	const s = await start();
	const headers = { "content-type": "application/json", "x-signet-agent-id": "agent-a" };
	const write = await fetch(`${s.origin}/api/transcripts`, {
		method: "POST",
		headers: { ...headers, "idempotency-key": "read-test" },
		body: JSON.stringify({
			sessionKey: "123e4567-e89b-12d3-a456-426614174000",
			harness: "bun",
			content: "stored transcript",
			idempotency_key: "read-test",
		}),
	});
	expect(write.status).toBe(200);
	const read = await fetch(`${s.origin}/api/sessions/123e4567-e89b-12d3-a456-426614174000/transcript`, { headers });
	expect(read.status).toBe(200);
	expect(await read.json()).toEqual({
		sessionKey: "123e4567-e89b-12d3-a456-426614174000",
		agentId: "agent-a",
		content: "stored transcript",
	});
	const denied = await fetch(`${s.origin}/api/sessions/123e4567-e89b-12d3-a456-426614174000/transcript`, {
		headers: { ...headers, "x-signet-agent-id": "agent-b" },
	});
	expect(denied.status).toBe(404);
	expect(await denied.json()).toEqual({ error: "Transcript not found" });
	const missing = await fetch(`${s.origin}/api/sessions/missing/transcript`, { headers });
	expect(missing.status).toBe(404);
	expect(await missing.json()).toEqual({ error: "Transcript not found" });
});

it("preserves exact UUID-like transcript key before colon alias", async () => {
	const s = await start();
	const headers = { "content-type": "application/json", "x-signet-agent-id": "agent-a" };
	const canonical = "123e4567-e89b-12d3-a456-426614174000";
	const alias = "123e4567-e89b:12d3:a456-426614174000";
	const cases: ReadonlyArray<readonly [string, string, string]> = [
		[canonical, "canonical transcript", "canonical-key"],
		[alias, "colon transcript", "alias-key"],
	];
	for (const [sessionKey, content, idempotencyKey] of cases) {
		const write = await fetch(`${s.origin}/api/transcripts`, {
			method: "POST",
			headers: { ...headers, "idempotency-key": idempotencyKey },
			body: JSON.stringify({ sessionKey, harness: "bun", content, idempotency_key: idempotencyKey }),
		});
		expect(write.status).toBe(200);
	}
	for (const path of [alias, `session:${alias}`]) {
		const read = await fetch(`${s.origin}/api/sessions/${path}/transcript`, { headers });
		expect(read.status).toBe(200);
		expect(await read.json()).toEqual({ sessionKey: alias, agentId: "agent-a", content: "colon transcript" });
	}
	const metadata = await fetch(`${s.origin}/api/sessions/session:${alias}`, { headers });
	expect(metadata.status).toBe(200);
	expect((await metadata.json()).sessionKey).toBe(alias);
});

it("infers agent scope from an agent-prefixed session key", async () => {
	const s = await start();
	const key = "agent:agent-a:session-1";
	const headers = {
		"content-type": "application/json",
		"x-signet-agent-id": "agent-a",
		"idempotency-key": "agent-key",
	};
	const write = await fetch(`${s.origin}/api/transcripts`, {
		method: "POST",
		headers,
		body: JSON.stringify({ sessionKey: key, harness: "bun", content: "agent-scoped", idempotency_key: "agent-key" }),
	});
	expect(write.status).toBe(200);
	const read = await fetch(`${s.origin}/api/sessions/${key}/transcript`);
	expect(read.status).toBe(200);
	expect(await read.json()).toEqual({ sessionKey: key, agentId: "agent-a", content: "agent-scoped" });
});

it("uses the default agent when a session key has no agent prefix or override", async () => {
	const s = await start();
	const key = "default-session";
	const write = await fetch(`${s.origin}/api/transcripts`, {
		method: "POST",
		headers: { "content-type": "application/json", "x-signet-agent-id": "default", "idempotency-key": "default-key" },
		body: JSON.stringify({
			sessionKey: key,
			harness: "bun",
			content: "default-scoped",
			idempotency_key: "default-key",
		}),
	});
	expect(write.status).toBe(200);
	const read = await fetch(`${s.origin}/api/sessions/${key}/transcript`);
	expect(read.status).toBe(200);
	expect(await read.json()).toEqual({ sessionKey: key, agentId: "default", content: "default-scoped" });
});

it("enforces authenticated agent scope for session reads", async () => {
	const workspace = mkdtempSync(join(tmpdir(), "signet-session-scope-"));
	mkdirSync(join(workspace, ".daemon"), { recursive: true });
	const secret = randomBytes(32);
	writeFileSync(join(workspace, ".daemon", "auth-secret"), secret);
	writeFileSync(join(workspace, "agent.yaml"), "auth:\n  mode: team\n");
	const now = Math.floor(Date.now() / 1_000);
	const adminToken = signedToken(secret, {
		sub: "test-admin",
		role: "admin",
		scope: {},
		permissions: [],
		iat: now,
		exp: now + 3_600,
	});
	const agentToken = signedToken(secret, {
		sub: "agent-a",
		role: "agent",
		scope: { agent: "agent-a" },
		permissions: [],
		iat: now,
		exp: now + 3_600,
	});
	const s = await start(workspace);
	const write = async (agentId: string, sessionKey: string, content: string, idempotencyKey: string) =>
		fetch(`${s.origin}/api/transcripts`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				authorization: `Bearer ${adminToken}`,
				"x-signet-agent-id": agentId,
				"idempotency-key": idempotencyKey,
			},
			body: JSON.stringify({ sessionKey, harness: "bun", content, idempotency_key: idempotencyKey }),
		});
	const keyA = "agent:agent-a:session-a";
	const keyB = "agent:agent-b:session-b";
	expect((await write("agent-a", keyA, "private A", "seed-a")).status).toBe(200);
	expect((await write("agent-b", keyB, "private B", "seed-b")).status).toBe(200);
	const allowed = await fetch(`${s.origin}/api/sessions/${keyA}/transcript`, {
		headers: { authorization: `Bearer ${agentToken}` },
	});
	expect(allowed.status).toBe(200);
	expect((await allowed.json()).content).toBe("private A");
	const denied = await fetch(`${s.origin}/api/sessions/${keyB}/transcript`, {
		headers: { authorization: `Bearer ${agentToken}` },
	});
	expect(denied.status).toBe(403);
	expect(await denied.json()).toEqual({ error: "scope restricted to agent 'agent-a'" });
});

it("treats empty stored transcript content as not found after restart", async () => {
	const s = await start();
	const key = "empty-after-restart";
	const headers = { "content-type": "application/json", "x-signet-agent-id": "agent-a" };
	const write = await fetch(`${s.origin}/api/transcripts`, {
		method: "POST",
		headers: { ...headers, "idempotency-key": "empty-seed" },
		body: JSON.stringify({
			sessionKey: key,
			harness: "bun",
			content: "initial content",
			idempotency_key: "empty-seed",
		}),
	});
	expect(write.status).toBe(200);
	await stop(s);
	const stoppedIndex = sessions.indexOf(s);
	if (stoppedIndex >= 0) sessions.splice(stoppedIndex, 1);
	let restarted: Session | undefined;
	try {
		// The HTTP owner is stopped; seed a legacy empty row before restarting it.
		const db = new Database(join(s.workspace, "memory", "memories.db"));
		try {
			const update = db
				.prepare("UPDATE session_transcripts SET content = '' WHERE agent_id = ? AND session_key = ?")
				.run("agent-a", key);
			expect(update.changes).toBe(1);
		} finally {
			db.close();
		}
		restarted = await start(s.workspace);
		const response = await fetch(`${restarted.origin}/api/sessions/${key}/transcript`, { headers });
		expect(response.status).toBe(404);
		expect(await response.json()).toEqual({ error: "Transcript not found" });
	} finally {
		if (!restarted) rmSync(s.workspace, { recursive: true, force: true });
	}
});

it("retrieves stored session metadata over HTTP, scoped by agent", async () => {
	const s = await start();
	const headers = { "content-type": "application/json", "x-signet-agent-id": "agent-a" };
	const key = "stored-session-meta";
	const write = await fetch(`${s.origin}/api/transcripts`, {
		method: "POST",
		headers: { ...headers, "idempotency-key": "meta-test" },
		body: JSON.stringify({
			sessionKey: key,
			harness: "codex",
			project: "project-a",
			content: "metadata transcript",
			idempotency_key: "meta-test",
		}),
	});
	expect(write.status).toBe(200);
	const response = await fetch(`${s.origin}/api/sessions/${key}`, { headers });
	expect(response.status).toBe(200);
	const body = await response.json();
	expect(body).toEqual({
		key: `session:${key}`,
		sessionKey: key,
		agentId: "agent-a",
		harness: "codex",
		project: "project-a",
		runtimePath: "transcript",
		provider: "session_transcripts",
		startedAt: expect.any(String),
		lastSeenAt: expect.any(String),
		status: "stored",
	});
	const denied = await fetch(`${s.origin}/api/sessions/${key}`, {
		headers: { ...headers, "x-signet-agent-id": "agent-b" },
	});
	expect(denied.status).toBe(404);
	expect(await denied.json()).toEqual({ error: "Session not found" });
});

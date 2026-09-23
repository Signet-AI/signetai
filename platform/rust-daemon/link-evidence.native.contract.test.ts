import { afterEach, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const binary = process.env.SIGNET_RUST_DAEMON_BIN ?? join(import.meta.dir, "target/release/signet-daemon");
type Daemon = { child: ReturnType<typeof Bun.spawn>; base: string; dir: string };
const daemons: Daemon[] = [];

async function reservePort(): Promise<number> {
	const server = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
	const port = server.port;
	server.stop(true);
	return port;
}

async function start(dir = mkdtempSync(join(tmpdir(), `link-evidence-${crypto.randomUUID()}-`))): Promise<Daemon> {
	if (!existsSync(binary)) throw new Error(`missing daemon: ${binary}`);
	const port = await reservePort();
	const child = Bun.spawn([binary], {
		env: {
			...process.env,
			SIGNET_PATH: dir,
			SIGNET_BIND: "127.0.0.1",
			SIGNET_PORT: String(port),
			SIGNET_AUTH_MODE: "hybrid",
			SIGNET_API_KEY: "[REDACTED]",
		},
		stdout: "pipe",
		stderr: "pipe",
	});
	for (let i = 0; i < 300; i++) {
		try {
			if ((await fetch(`http://127.0.0.1:${port}/health/ready`)).ok) {
				const daemon = { child, base: `http://127.0.0.1:${port}`, dir };
				daemons.push(daemon);
				return daemon;
			}
		} catch {}
		await Bun.sleep(20);
	}
	child.kill("SIGKILL");
	throw new Error("daemon did not become ready");
}

async function stop(daemon: Daemon) {
	daemon.child.kill("SIGTERM");
	const exited = await Promise.race([daemon.child.exited.then(() => true), Bun.sleep(1_000).then(() => false)]);
	if (!exited) daemon.child.kill("SIGKILL");
	await daemon.child.exited.catch(() => -1);
}

async function request(daemon: Daemon, path: string, agent = "agent-a", authenticated = true) {
	const headers: Record<string, string> = { "x-signet-agent-id": agent };
	if (authenticated) headers["x-signet-api-key"] = "[REDACTED]";
	const response = await fetch(daemon.base + path, { headers });
	const text = await response.text();
	return { response, body: text ? JSON.parse(text) : null };
}

function seed(dir: string) {
	const db = new Database(join(dir, "memory", "memories.db"));
	db.exec(`
    INSERT INTO entities (id, agent_id, workspace_id, name, canonical_name, entity_type, status, created_at, updated_at)
    VALUES ('entity-a', 'agent-a', 'ws-a', 'Source', 'source', 'project', 'active', '2026-09-23T00:00:00.000Z', '2026-09-23T00:00:00.000Z');
    INSERT INTO entities (id, agent_id, workspace_id, name, canonical_name, entity_type, status, created_at, updated_at)
    VALUES ('entity-b', 'agent-a', 'ws-a', 'Target', 'target', 'project', 'active', '2026-09-23T00:00:00.000Z', '2026-09-23T00:00:00.000Z');
    INSERT INTO session_transcripts
      (session_key, agent_id, harness, project, content, content_hash, idempotency_key, created_at, updated_at)
    VALUES
      ('session-a', 'agent-a', 'contract', NULL, 'The transcript contains source-backed link evidence.', 'hash-a', 'idem-a',
       '2026-09-23T00:00:00.000Z', '2026-09-23T00:00:00.000Z');
    INSERT INTO entity_dependencies
      (id, source_entity_id, target_entity_id, agent_id, dependency_type, strength, confidence, status,
       source_kind, source_id, created_at, updated_at)
    VALUES
      ('link-a', 'entity-a', 'entity-b', 'agent-a', 'supports', 0.8, 0.9, 'active',
       'transcript', 'session-a', '2026-09-23T00:00:01.000Z', '2026-09-23T00:00:01.000Z');
  `);
	db.close();
}

afterEach(async () => {
	for (const daemon of daemons.splice(0)) {
		await stop(daemon);
		rmSync(daemon.dir, { recursive: true, force: true });
	}
});

it("returns scoped link evidence and preserves auth and missing-link errors", async () => {
	let daemon = await start();
	await stop(daemon);
	daemons.splice(daemons.indexOf(daemon), 1);
	seed(daemon.dir);
	daemon = await start(daemon.dir);

	const success = await request(daemon, "/api/ontology/links/link-a/evidence");
	expect(success.response.status).toBe(200);
	expect(success.body.dependency.id).toBe("link-a");
	expect(success.body.dependency.agentId).toBe("agent-a");
	expect(success.body.count).toBe(1);
	expect(success.body.items[0].kind).toBe("session_transcript");
	expect(success.body.items[0].found).toBe(true);
	expect(success.body.items[0].sourceId).toBe("session-a");
	expect(success.body.items[0].excerpt).toContain("source-backed link evidence");

	expect((await request(daemon, "/api/ontology/links/link-a/evidence", "agent-b")).response.status).toBe(404);
	expect((await request(daemon, "/api/ontology/links/missing/evidence")).response.status).toBe(404);
	expect((await request(daemon, "/api/ontology/links/link-a/evidence", "agent-a", false)).response.status).toBe(401);
});

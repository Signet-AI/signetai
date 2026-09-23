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

async function start(dir = mkdtempSync(join(tmpdir(), `claims-evidence-${crypto.randomUUID()}-`))): Promise<Daemon> {
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

async function request(daemon: Daemon, path: string, agent = "agent-a") {
	const response = await fetch(daemon.base + path, {
		headers: {
			"x-signet-agent-id": agent,
			"x-signet-api-key": "[REDACTED]",
		},
	});
	const text = await response.text();
	return { response, body: text ? JSON.parse(text) : null };
}

function seed(dir: string) {
	const db = new Database(join(dir, "memory", "memories.db"));
	db.exec(`
    INSERT INTO entities (id, agent_id, workspace_id, name, canonical_name, entity_type, status, created_at, updated_at)
    VALUES ('entity-a', 'agent-a', 'ws-a', 'Signet', 'signet', 'project', 'active', '2026-09-23T00:00:00.000Z', '2026-09-23T00:00:00.000Z');
    INSERT INTO entity_aspects (id, entity_id, agent_id, workspace_id, name, canonical_name, weight, status, created_at, updated_at)
    VALUES ('aspect-a', 'entity-a', 'agent-a', 'ws-a', 'Architecture', 'architecture', 0.5, 'active', '2026-09-23T00:00:00.000Z', '2026-09-23T00:00:00.000Z');
    INSERT INTO memory_artifacts (agent_id, source_path, source_sha256, source_kind, session_id, session_token, captured_at, content, updated_at, source_node_id, is_deleted)
    VALUES ('agent-a', '/workspace/source.md', 'sha-a', 'artifact', 'session-a', '[REDACTED]', '2026-09-23T00:00:00.000Z', 'Source-backed evidence content.', '2026-09-23T00:00:00.000Z', 'artifact-node', 0);
    INSERT INTO entity_attributes (id, aspect_id, agent_id, workspace_id, kind, content, normalized_content, group_key, claim_key, confidence, importance, status, source_kind, source_id, created_at, updated_at)
    VALUES ('attr-new', 'aspect-a', 'agent-a', 'ws-a', 'attribute', 'new value', 'new value', 'ontology', 'loop', 0.9, 0.8, 'active', 'artifact', 'artifact-node', '2026-09-23T00:00:02.000Z', '2026-09-23T00:00:02.000Z');
    INSERT INTO entity_attributes (id, aspect_id, agent_id, workspace_id, kind, content, normalized_content, group_key, claim_key, confidence, importance, status, source_kind, source_id, created_at, updated_at)
    VALUES ('attr-old', 'aspect-a', 'agent-a', 'ws-a', 'attribute', 'old value', 'old value', 'ontology', 'loop', 0.1, 0.1, 'superseded', 'artifact', 'artifact-node', '2026-09-22T00:00:02.000Z', '2026-09-22T00:00:02.000Z');
  `);
	db.close();
}

afterEach(async () => {
	for (const daemon of daemons.splice(0)) {
		await stop(daemon);
		rmSync(daemon.dir, { recursive: true, force: true });
	}
});

it("returns active and historical evidence with paging and agent isolation", async () => {
	let daemon = await start();
	await stop(daemon);
	daemons.splice(daemons.indexOf(daemon), 1);
	seed(daemon.dir);
	daemon = await start(daemon.dir);

	const active = await request(
		daemon,
		"/api/ontology/claims/evidence?entity=signet&aspect=architecture&group=Ontology&claim=loop",
	);
	expect(active.response.status).toBe(200);
	expect(active.body.count).toBe(1);
	expect(active.body.items[0].attribute.id).toBe("attr-new");
	expect(active.body.items[0].evidenceCount).toBe(1);

	const newest = await request(
		daemon,
		"/api/ontology/claims/evidence?entity=signet&aspect=architecture&group=Ontology&claim=loop&status=all&limit=1&offset=0",
	);
	const oldest = await request(
		daemon,
		"/api/ontology/claims/evidence?entity=signet&aspect=architecture&group=Ontology&claim=loop&status=all&limit=1&offset=1",
	);
	expect(newest.response.status).toBe(200);
	expect(oldest.response.status).toBe(200);
	expect(newest.body.items[0].attribute.id).toBe("attr-new");
	expect(oldest.body.items[0].attribute.id).toBe("attr-old");
	expect(
		(
			await request(
				daemon,
				"/api/ontology/claims/evidence?entity=signet&aspect=architecture&group=Ontology&claim=loop",
				"agent-b",
			)
		).response.status,
	).toBe(404);
	expect(
		(
			await request(
				daemon,
				"/api/ontology/claims/evidence?entity=missing&aspect=architecture&group=Ontology&claim=loop",
			)
		).response.status,
	).toBe(404);
});

it("preserves auth and query validation", async () => {
	const daemon = await start();
	expect(
		(
			await request(
				daemon,
				"/api/ontology/claims/evidence?entity=signet&aspect=architecture&group=Ontology&claim=loop&kind=invalid",
			)
		).response.status,
	).toBe(400);
	expect(
		(
			await request(
				daemon,
				"/api/ontology/claims/evidence?entity=signet&aspect=architecture&group=Ontology&claim=loop&status=invalid",
			)
		).response.status,
	).toBe(400);
	expect(
		(
			await fetch(
				daemon.base + "/api/ontology/claims/evidence?entity=signet&aspect=architecture&group=Ontology&claim=loop",
			)
		).status,
	).toBe(401);
});

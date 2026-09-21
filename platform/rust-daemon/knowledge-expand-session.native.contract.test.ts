/* biome-ignore-all lint/suspicious/noExplicitAny: native HTTP contract payloads */
import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = process.cwd();
const binary = process.env.SIGNET_RUST_DAEMON_BIN ?? join(root, "platform/rust-daemon/target/debug/signet-daemon");
const apiKey = "session-expand-admin";
const agent = "session-expand-agent";
const workspace = "session-expand-workspace";
const children: Bun.Subprocess[] = [];
const dirs: string[] = [];

async function start(dir: string) {
	const reservation = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {}, open() {}, close() {} } });
	const port = reservation.port;
	reservation.stop();
	const out = join(dir, "stdout.log");
	const err = join(dir, "stderr.log");
	const child = Bun.spawn([binary], {
		cwd: root,
		env: {
			...process.env,
			SIGNET_PATH: dir,
			SIGNET_BIND: "127.0.0.1",
			SIGNET_MODE: "local",
			SIGNET_PORT: String(port),
			SIGNET_AGENT_ID: agent,
			SIGNET_API_KEY: apiKey,
			SIGNET_TOKEN: "",
		},
		stdout: Bun.file(out),
		stderr: Bun.file(err),
	});
	children.push(child);
	const origin = `http://127.0.0.1:${port}`;
	for (let i = 0; i < 240; i++) {
		try {
			if ((await fetch(`${origin}/health/ready`)).ok) return { child, origin, dir };
		} catch {}
		await Bun.sleep(25);
	}
	throw new Error(
		`daemon readiness timeout\nstdout=${await Bun.file(out).text()}\nstderr=${await Bun.file(err).text()}`,
	);
}
async function stop(child: Bun.Subprocess) {
	if (child.exitCode !== null) return;
	child.kill("SIGTERM");
	await Promise.race([child.exited, Bun.sleep(1000)]);
	if (child.exitCode === null) child.kill("SIGKILL");
	await child.exited;
}
function headers(auth = true, agentId = agent, workspaceId?: string): HeadersInit {
	return {
		"content-type": "application/json",
		...(auth ? { authorization: `Bearer ${apiKey}` } : {}),
		"x-signet-agent": agentId,
		...(workspaceId === undefined ? {} : { "x-workspace-id": workspaceId }),
	};
}
async function json(response: Response) {
	return (await response.json()) as Record<string, any>;
}
async function request(
	origin: string,
	body: Record<string, unknown>,
	options: {
		auth?: boolean;
		agent?: string;
		workspace?: string;
		project?: string;
		session?: string;
		time?: string;
		max?: number;
	} = {},
) {
	const response = await fetch(`${origin}/api/knowledge/expand/session`, {
		method: "POST",
		headers: {
			...headers(options.auth !== false, options.agent, options.workspace ?? workspace),
			...(options.project ? { "x-signet-project-id": options.project } : {}),
		},
		body: JSON.stringify({
			...body,
			...(options.session ? { sessionId: options.session } : {}),
			...(options.time ? { timeRange: options.time } : {}),
			...(options.max === undefined ? {} : { maxResults: options.max }),
		}),
	});
	return { response, body: await json(response) };
}
function seed(dbPath: string, entityId: string) {
	const db = new Database(dbPath);
	const now = new Date().toISOString();
	db.exec(
		"CREATE TABLE IF NOT EXISTS memory_content_safety (agent_id TEXT NOT NULL, source_kind TEXT NOT NULL, source_id TEXT NOT NULL, status TEXT NOT NULL, context_eligible INTEGER NOT NULL, reasons_json TEXT, policy_version TEXT, scanned_at TEXT NOT NULL, PRIMARY KEY(agent_id,source_kind,source_id))",
	);
	const summary = db.prepare(
		"INSERT INTO session_summaries (id,project,depth,kind,content,token_count,earliest_at,latest_at,session_key,harness,agent_id,source_type,source_ref,meta_json,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
	);
	const link = db.prepare("INSERT INTO session_summary_memories (summary_id,memory_id) VALUES (?,?)");
	const mention = db.prepare("INSERT INTO memory_entity_mentions (memory_id,entity_id) VALUES (?,?)");
	const safety = db.prepare(
		"INSERT INTO memory_content_safety (agent_id,source_kind,source_id,status,context_eligible,reasons_json,policy_version,scanned_at) VALUES (?,? ,?,?,?, ?,?,?)",
	);
	const rows = [
		[
			"sum-safe-new",
			"project-a",
			"Session Subject safe newest reporting",
			"sess-a",
			"2026-01-03T00:00:00Z",
			"mem-safe-new",
			"clean",
			1,
		],
		[
			"sum-safe-old",
			"project-a",
			"Session Subject safe older defensive",
			"sess-a",
			"2026-01-02T00:00:00Z",
			"mem-safe-old",
			"clean",
			1,
		],
		[
			"sum-unsafe",
			"project-a",
			"Session Subject unsafe summary",
			"sess-a",
			"2026-01-04T00:00:00Z",
			"mem-unsafe",
			"blocked",
			0,
		],
		[
			"sum-tainted",
			"project-a",
			"Session Subject clean text but persisted tainted ledger",
			"sess-a",
			"2026-01-05T00:00:00Z",
			"mem-tainted",
			"tainted",
			1,
		],
		["sum-other-project", "project-b", "other project", "sess-b", "2026-01-06T00:00:00Z", "mem-other", "clean", 1],
	] as const;
	for (const [id, project, content, session, at, memory, status, eligible] of rows) {
		summary.run(id, project, 0, "session", content, 4, at, at, session, "bun", agent, "summary", id, null, now);
		link.run(id, memory);
		mention.run(memory, entityId);
		safety.run(agent, "memory", memory, status, eligible, "{}", "contract", now);
	}
	db.close();
}
afterEach(async () => {
	for (const child of children.splice(0)) await stop(child);
	for (const dir of dirs.splice(0)) {
		try {
			readFileSync(join(dir, "stdout.log"));
			readFileSync(join(dir, "stderr.log"));
		} catch {}
		rmSync(dir, { recursive: true, force: true });
	}
});

test("real daemon session expansion enforces HTTP auth, selection, bounds, safety, and scope", async () => {
	const dir = mkdtempSync(join(tmpdir(), "signet-expand-session-"));
	dirs.push(dir);
	let daemon = await start(dir);
	const create = await fetch(`${daemon.origin}/api/knowledge/entities?workspace_id=${workspace}`, {
		method: "POST",
		headers: headers(true),
		body: JSON.stringify({ name: "Session Subject", type: "person", metadata: {} }),
	});
	expect(create.status).toBe(201);
	const entity = await json(create);
	expect(entity.id).toBeTruthy();
	await stop(daemon.child);
	seed(join(dir, "memory", "memories.db"), entity.id);
	const fixture = new Database(join(dir, "memory", "memories.db"));
	expect((fixture.query("SELECT count(*) AS n FROM memory_entity_mentions").get() as { n: number }).n).toBeGreaterThan(
		0,
	);
	fixture.close();
	daemon = await start(dir);
	const noCredential = await request(daemon.origin, { entityName: "Session Subject" }, { auth: false });
	expect(noCredential.response.status).toBe(401);
	const expanded = await request(daemon.origin, { entityName: "Session Subject" }, { max: 50 });
	expect(expanded.response.status).toBe(200);
	expect(expanded.body.entityName).toBe("Session Subject");
	expect(expanded.body.total).toBe(2);
	expect(expanded.body.summaries.map((s: any) => s.id)).toEqual(["sum-safe-new", "sum-safe-old"]);
	expect((await request(daemon.origin, {}, {})).response.status).toBe(400);
	expect((await request(daemon.origin, { entityName: "Unknown" })).body).toEqual({
		entityName: "Unknown",
		summaries: [],
		total: 0,
	});
	expect(
		(await request(daemon.origin, { entityName: "Session Subject" }, { max: 1 })).body.summaries.map((s: any) => s.id),
	).toEqual(["sum-safe-new"]);
	expect(
		(await request(daemon.origin, { entityName: "Session Subject" }, { project: "project-b" })).body.summaries.map(
			(s: any) => s.id,
		),
	).toEqual([]);
	expect(
		(
			await request(
				daemon.origin,
				{ entityName: "Session Subject" },
				{ session: "sess-a", time: "2026-01-02T00:00:00Z" },
			)
		).body.total,
	).toBe(2);
	expect(
		(await request(daemon.origin, { entityName: "Session Subject" }, { agent: "wrong-agent" })).response.status,
	).toBe(403);
	expect(
		(await request(daemon.origin, { entityName: "Session Subject" }, { workspace: "wrong-workspace" })).body.summaries,
	).toEqual([]);
	const conflict = await fetch(`${daemon.origin}/api/knowledge/expand/session?workspace_id=${workspace}`, {
		method: "POST",
		headers: { ...headers(true), "x-signet-workspace-id": "wrong-workspace" },
		body: JSON.stringify({ entityName: "Session Subject" }),
	});
	expect(conflict.status).toBe(400);
});

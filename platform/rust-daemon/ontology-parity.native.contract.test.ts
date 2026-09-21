import { afterEach, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const binary = process.env.SIGNET_RUST_DAEMON_BIN ?? join(import.meta.dir, "target/release/signet-daemon");
type D = { child: ReturnType<typeof Bun.spawn>; base: string; dir: string; stdout: string[]; stderr: string[] };
const ds: D[] = [];

async function reservePort(): Promise<number> {
	const server = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
	const port = server.port;
	server.stop(true);
	return port;
}
async function start(dir = mkdtempSync(join(tmpdir(), `ontology-contract-${crypto.randomUUID()}-`))): Promise<D> {
	if (!existsSync(binary)) throw new Error(`missing daemon: ${binary}`);
	const port = await reservePort();
	const stdout: string[] = [],
		stderr: string[] = [];
	const child = Bun.spawn([binary], {
		env: {
			...process.env,
			SIGNET_PATH: dir,
			SIGNET_BIND: "127.0.0.1",
			SIGNET_PORT: String(port),
			SIGNET_AUTH_MODE: "hybrid",
			SIGNET_API_KEY: "contract-key",
		},
		stdout: "pipe",
		stderr: "pipe",
	});
	const capture = async (stream: ReadableStream<Uint8Array>, out: string[]) => {
		for await (const chunk of stream) out.push(new TextDecoder().decode(chunk));
	};
	void capture(child.stdout, stdout);
	void capture(child.stderr, stderr);
	const d = { child, base: `http://127.0.0.1:${port}`, dir, stdout, stderr };
	for (let i = 0; i < 300; i++) {
		try {
			if ((await fetch(`${d.base}/health/ready`)).ok) {
				ds.push(d);
				return d;
			}
		} catch {}
		await Bun.sleep(20);
	}
	await stop(d);
	throw new Error(`daemon did not start\nstdout:\n${stdout.join("")}\nstderr:\n${stderr.join("")}`);
}
async function stop(d: D) {
	d.child.kill("SIGTERM");
	const exited = await Promise.race([d.child.exited.then(() => true), Bun.sleep(1_000).then(() => false)]);
	if (!exited) d.child.kill("SIGKILL");
	await d.child.exited.catch(() => -1);
}
async function req(d: D, path: string, init: RequestInit = {}, agent = "agent-a") {
	const r = await fetch(d.base + path, {
		...init,
		headers: {
			"x-signet-agent-id": agent,
			"x-signet-api-key": "contract-key",
			"content-type": "application/json",
			...init.headers,
		},
	});
	const text = await r.text();
	let body: unknown = null;
	if (text) {
		try {
			body = JSON.parse(text);
		} catch {
			body = text;
		}
	}
	return { r, body };
}
function seed(dir: string) {
	const db = new Database(join(dir, "memory", "memories.db"));
	const rows = [
		[
			"p-new",
			"agent-a",
			{
				workspace_id: "ws-a",
				entity: " Signet ",
				aspect: " Architecture ",
				group_key: "Ontology",
				claim_key: "Loop",
				value: "Newest source text",
			},
			0.91,
			"why newest",
			[{ source: "s1" }],
			"2026-09-21T00:00:06.000Z",
		],
		[
			"p-old",
			"agent-a",
			{
				workspace_id: "ws-a",
				entity: "signet",
				aspect: "architecture",
				group_key: "ontology",
				claim_key: "loop",
				value: "Older source text",
			},
			0,
			"",
			[],
			"2026-09-21T00:00:05.000Z",
		],
		[
			"p-same",
			"agent-a",
			{
				workspace_id: "ws-a",
				entity: "signet",
				aspect: "architecture",
				group_key: "ontology",
				claim_key: "same",
				value: "same value",
			},
			0.5,
			"same",
			[],
			"2026-09-21T00:00:04.000Z",
		],
		[
			"p-same-2",
			"agent-a",
			{
				workspace_id: "ws-a",
				entity: "signet",
				aspect: "architecture",
				group_key: "ontology",
				claim_key: "same",
				value: "SAME VALUE",
			},
			0.5,
			"same",
			[],
			"2026-09-21T00:00:03.500Z",
		],
		[
			"p-malformed",
			"agent-a",
			{ workspace_id: "ws-a", entity: "signet", aspect: "architecture", claim_key: "loop" },
			0,
			"",
			[],
			"2026-09-21T00:00:03.000Z",
		],
		[
			"p-other-agent",
			"agent-b",
			{
				workspace_id: "ws-a",
				entity: "signet",
				aspect: "architecture",
				group_key: "ontology",
				claim_key: "loop",
				value: "Other agent",
			},
			0,
			"",
			[],
			"2026-09-21T00:00:02.000Z",
		],
		[
			"p-other-workspace",
			"agent-a",
			{
				workspace_id: "ws-b",
				entity: "signet",
				aspect: "architecture",
				group_key: "ontology",
				claim_key: "loop",
				value: "Other workspace",
			},
			0,
			"",
			[],
			"2026-09-21T00:00:01.000Z",
		],
	] as const;
	db.exec(
		"CREATE TABLE IF NOT EXISTS ontology_proposals (id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, operation TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', payload TEXT NOT NULL, confidence REAL NOT NULL DEFAULT 0, rationale TEXT NOT NULL DEFAULT '', evidence TEXT NOT NULL DEFAULT '[]', risk TEXT, source_kind TEXT, source_id TEXT, source_path TEXT, source_root TEXT, created_by TEXT NOT NULL DEFAULT 'contract', applied_by TEXT, rejected_by TEXT, result TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, applied_at TEXT, rejected_at TEXT)",
	);
	const stmt = db.prepare(
		"INSERT INTO ontology_proposals (id,agent_id,operation,status,payload,confidence,rationale,evidence,created_by,created_at,updated_at) VALUES (?,?,?,'pending',?,?,?,?,?,?,?)",
	);
	for (const [id, agent, payload, confidence, rationale, evidence, ts] of rows)
		stmt.run(
			id,
			agent,
			"add_claim_value",
			JSON.stringify(payload),
			confidence,
			rationale,
			JSON.stringify(evidence),
			"contract",
			ts,
			ts,
		);
	db.close();
}
afterEach(async () => {
	for (const d of ds.splice(0)) {
		await stop(d);
		rmSync(d.dir, { recursive: true, force: true });
	}
});

it("matches the TypeScript conflict envelope, grouping, limits, isolation, and auth contract", async () => {
	let d = await start();
	await stop(d);
	ds.splice(ds.indexOf(d), 1);
	seed(d.dir);
	d = await start(d.dir);
	const expected = {
		items: [
			{
				entity: " Signet ",
				aspect: " Architecture ",
				groupKey: "Ontology",
				claimKey: "Loop",
				values: [
					{
						proposalId: "p-new",
						value: "Newest source text",
						confidence: 0.91,
						rationale: "why newest",
						evidenceCount: 1,
					},
					{ proposalId: "p-old", value: "Older source text", confidence: 0, rationale: "", evidenceCount: 0 },
				],
				proposalIds: ["p-new", "p-old"],
				count: 2,
			},
		],
		count: 1,
	};
	expect((await req(d, "/api/ontology/proposals/conflicts?workspace_id=ws-a")).body).toEqual(expected);
	expect((await req(d, "/api/ontology/proposals/conflicts")).body).toEqual({ items: [], count: 0 });
	expect(
		(
			await req(d, "/api/ontology/proposals/conflicts", {
				headers: { "x-signet-workspace-id": "ws-a" },
			})
		).body,
	).toEqual(expected);
	expect((await req(d, "/api/ontology/proposals/conflicts?workspace_id=ws-a&limit=2")).body).toEqual(expected);
	expect((await req(d, "/api/ontology/proposals/conflicts?workspace_id=ws-b")).body).toEqual({ items: [], count: 0 });
	expect((await req(d, "/api/ontology/proposals/conflicts?workspace_id=ws-a", {}, "agent-b")).body).toEqual({
		items: [],
		count: 0,
	});
	expect((await fetch(`${d.base}/api/ontology/proposals/conflicts?workspace_id=ws-a`)).status).toBe(401);
	expect(
		(
			await req(d, "/api/ontology/proposals/conflicts?workspace_id=ws-b", {
				headers: { "x-signet-workspace-id": "ws-a" },
			})
		).r.status,
	).toBe(400);
	expect((await req(d, "/api/ontology/proposals/conflicts?workspace_id=ws-a&limit=0")).r.status).toBe(400);
	expect((await req(d, "/api/ontology/proposals/conflicts?workspace_id=ws-a&limit=nope")).r.status).toBe(400);
	expect((await req(d, "/api/ontology/proposals/conflicts?workspace_id=ws-a&limit=1001")).r.status).toBe(400);
	expect((await req(d, "/api/ontology/proposals/apply?workspace_id=ws-a")).r.status).toBe(404);
});

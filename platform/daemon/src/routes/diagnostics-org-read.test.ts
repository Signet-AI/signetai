import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { z } from "zod";
import type { Principal } from "../auth/principal";

const previousPath = process.env.SIGNET_PATH;
const dir = mkdtempSync(join(tmpdir(), "signet-org-diagnostics-"));
let query: typeof import("../db-owner-runtime").dbOwnerQuery;
let close: typeof import("../db-accessor").closeDbAccessor;
let app: Hono;

beforeAll(async () => {
	process.env.SIGNET_PATH = dir;
	mkdirSync(join(dir, "data"), { recursive: true });
	writeFileSync(join(dir, "agent.yaml"), "configVersion: 1\nembedding:\n  provider: none\nauth:\n  mode: local\n");
	const db = await import("../db-accessor");
	db.initDbAccessor(join(dir, "data", "signet.db"), { agentsDir: dir });
	close = db.closeDbAccessor;
	({ dbOwnerQuery: query } = await import("../db-owner-runtime"));
	const { bindPrincipalAccess } = await import("../auth/agent-access");
	const { localPrincipal, rolePermissions } = await import("../auth/principal");
	const { readOrganization } = await import("../auth/organization-store");
	for (const sql of [
		"INSERT INTO users(id,username,display_name,role) VALUES('reader','reader','Reader','admin'),('audience','audience','Audience','admin')",
		"INSERT INTO classifications(id,name) VALUES('cls_secret','Secret')",
		"INSERT INTO classification_audience(classification_id,principal_kind,principal_id) VALUES('cls_secret','user','audience')",
		"INSERT INTO compartments(id,key) VALUES(1,'cls_secret'),(2,'public-fixture')",
		"INSERT INTO compartment_members(compartment_id,classification_id) VALUES(1,'cls_secret')",
		"INSERT INTO memories(id,content,agent_id,created_at,updated_at) VALUES('visible','readable','default','2026-01-01','2026-01-01')",
	])
		await query({ sql, result: "run" }, { operation: "test.seed", lane: "write", deadlineMs: 10000 });
	const organization = await readOrganization();
	app = new Hono();
	app.use("*", async (c, next) => {
		const userId = c.req.header("x-test-user") ?? "reader";
		const principal: Principal = {
			...localPrincipal(),
			kind: "user",
			userId,
			role: "admin",
			permissions: c.req.header("x-test-empty-permissions")
				? new Set<import("../auth/types").Permission>()
				: rolePermissions("admin"),
			credential: { kind: "session", id: userId },
		};
		bindPrincipalAccess(principal, {
			agentModel: "single",
			personalAgentsSelfService: false,
			organizationAgentId: "default",
			personalAgentId: null,
			defaultReadAgentId: "default",
			agents: [{ id: "default", kind: "organization", owner_user_id: null, owner_group_id: null, archived_at: null }],
		});
		c.set("principal", principal);
		c.set("organization", organization);
		await next();
	});
	(await import("./telemetry-routes")).registerTelemetryRoutes(app);
	(await import("./database-diagnostics")).registerDatabaseDiagnosticsRoutes(app);
	(await import("./queue-diagnostics")).registerQueueDiagnosticsRoutes(app);
	(await import("./misc-routes")).registerMiscRoutes(app);
	(await import("./memory-routes")).registerMemoryRoutes(app, { fetchEmbedding: async () => null });
});

afterAll(async () => {
	await close?.();
	if (previousPath === undefined) Reflect.deleteProperty(process.env, "SIGNET_PATH");
	else process.env.SIGNET_PATH = previousPath;
	rmSync(dir, { recursive: true, force: true });
});

async function write(sql: string, params: readonly unknown[] = []) {
	await query({ sql, params, result: "run" }, { operation: "test.mutate", lane: "write", deadlineMs: 10000 });
}
async function body(path: string, audience = false): Promise<Record<string, unknown>> {
	const response = await app.request(path, { headers: audience ? { "x-test-user": "audience" } : {} });
	expect(response.status).toBe(200);
	return response.json();
}

test("embedding status and health expose only documented global counts to administrators", async () => {
	const paths = ["/api/embeddings/status", "/api/embeddings/health"];
	const schema = z
		.object({
			status: z.literal("global_counts"),
			scope: z.literal("workspace"),
			counts: z.object({ embeddings: z.number(), memories: z.number(), pendingJobs: z.number() }).strict(),
		})
		.strict();
	for (const path of paths)
		expect((await app.request(path, { headers: { "x-test-empty-permissions": "1" } })).status).toBe(403);
	const before = await Promise.all(paths.map(async (path) => schema.parse(await body(path))));
	await write(
		"INSERT INTO memories(id,content,agent_id,compartment_id,created_at,updated_at) VALUES('hidden-diagnostic-only','hidden diagnostic text','default',1,'2090','2090')",
	);
	await write(
		"INSERT INTO embeddings(id,content_hash,chunk_text,source_type,source_id,vector,dimensions,created_at,agent_id,compartment_id) VALUES('hidden-diagnostic-e','hidden-diagnostic-h','hidden chunk','memory','hidden-diagnostic-only',?,2,'2090','default',1)",
		[{ type: "bytes", base64: Buffer.from(new Float32Array([1, 0]).buffer).toString("base64") }],
	);
	const after = await Promise.all(paths.map(async (path) => schema.parse(await body(path))));
	for (let index = 0; index < paths.length; index++) {
		expect(after[index]?.counts.embeddings).toBe((before[index]?.counts.embeddings ?? 0) + 1);
		expect(after[index]?.counts.memories).toBe((before[index]?.counts.memories ?? 0) + 1);
	}
	await write("UPDATE memories SET content='edited hidden diagnostic text' WHERE id='hidden-diagnostic-only'");
	expect(await Promise.all(paths.map(async (path) => schema.parse(await body(path))))).toEqual(after);
	await write("DELETE FROM embeddings WHERE id='hidden-diagnostic-e'");
	await write("DELETE FROM memories WHERE id='hidden-diagnostic-only'");
});

test("diagnostic copies and checkpoint links cannot expose hidden targets", async () => {
	await write(
		"INSERT INTO session_transcripts(session_key,content,harness,agent_id,compartment_id,created_at,updated_at) VALUES('private-session','private session','test','default',1,'now','now')",
	);
	await write(
		"INSERT INTO entities(id,name,canonical_name,entity_type,agent_id,compartment_id,created_at,updated_at) VALUES('private-pointer-entity','private entity','private entity','concept','default',1,'now','now')",
	);
	await write(
		"INSERT INTO memories(id,content,agent_id,compartment_id,created_at,updated_at) VALUES('private-result','private result','default',1,'now','now')",
	);
	await write(
		"INSERT INTO session_checkpoints(id,session_key,harness,project,project_normalized,trigger,digest,prompt_count,agent_id,compartment_id,focal_entity_ids,focal_entity_names,created_at) VALUES('pointer-checkpoint','private-session','test','pointer-project','pointer-project','manual','public checkpoint',1,'default',2,json_array('private-pointer-entity'),json_array('private entity'),'now')",
	);
	await write(
		"INSERT INTO memory_search_telemetry(id,created_at,route,agent_id,query,filters_json,method,result_count,no_hits,duration_ms,timings_json,results_json,compartment_id) VALUES('pointer-search','now','test','default','public query','{}','hybrid',1,0,1,'{}',?,2)",
		[JSON.stringify([{ id: "private-result", source: "memory", content: "private result", rank: 1 }])],
	);
	const outside = await body("/api/checkpoints?project=pointer-project");
	expect(JSON.stringify(outside)).not.toContain("private-session");
	expect(JSON.stringify(outside)).not.toContain("private-pointer-entity");
	expect(await body("/api/checkpoints/private-session")).toMatchObject({ count: 0 });
	expect(await body("/api/checkpoints/private-session", true)).toMatchObject({ count: 1 });
	expect(await body("/api/telemetry/memory-search")).toMatchObject({ count: 0 });
	expect(await body("/api/telemetry/memory-search", true)).toMatchObject({
		count: 1,
		items: [{ id: "pointer-search" }],
	});
	await write("DELETE FROM memory_search_telemetry WHERE id='pointer-search'");
	await write("DELETE FROM session_checkpoints WHERE id='pointer-checkpoint'");
	await write("DELETE FROM memories WHERE id='private-result'");
	await write("DELETE FROM entities WHERE id='private-pointer-entity'");
	await write("DELETE FROM session_transcripts WHERE session_key='private-session'");
});

test("unlabelled telemetry is absent unless the reader has all agent and compartment reach", async () => {
	const paths = [
		"/api/telemetry/memory-search?limit=1",
		"/api/telemetry/memory-search/export?limit=1",
		"/api/diagnostics/database/tables/memory_search_telemetry/sample?limit=1",
	];
	const snapshot = () =>
		Promise.all(
			paths.map(async (path) => {
				const res = await app.request(path);
				expect(res.status).toBe(200);
				return res.text();
			}),
		);
	const before = await snapshot();
	await write(
		"INSERT INTO memory_search_telemetry(id,created_at,route,agent_id,query,filters_json,method,result_count,no_hits,duration_ms,timings_json,results_json) VALUES('unknown-label','9999','test','default','unknown snapshot','{}','hybrid',1,0,1,'{}','[]')",
	);
	expect(await snapshot()).toEqual(before);
	await write("UPDATE memory_search_telemetry SET query='updated unknown snapshot' WHERE id='unknown-label'");
	expect(await snapshot()).toEqual(before);
	expect(await body("/api/telemetry/memory-search", true)).toMatchObject({ items: [{ id: "unknown-label" }] });
	const { readScopedSearchTelemetry } = await import("../diagnostics");
	expect(
		(await readScopedSearchTelemetry({ scope: { reach: { kind: "all" }, compartments: "all", projects: null } })).map(
			(row) => row.id,
		),
	).toContain("unknown-label");
	expect(
		await readScopedSearchTelemetry({
			scope: { reach: { kind: "own", agentId: "default" }, compartments: "all", projects: null },
		}),
	).toEqual([]);
	await write("DELETE FROM memory_search_telemetry WHERE id='unknown-label'");
});

test("admin diagnostics exclude hidden inserts and edits, audience reads them, and reclassification hides them", async () => {
	await write(
		"INSERT INTO embeddings(id,content_hash,chunk_text,source_type,source_id,vector,dimensions,created_at,agent_id) VALUES('visible-e','visible-h','chunk','memory','visible',?,2,'2026-01-01','default')",
		[{ type: "bytes", base64: Buffer.from(new Float32Array([1, 0]).buffer).toString("base64") }],
	);
	await write(
		"INSERT INTO entities(id,name,canonical_name,entity_type,agent_id,created_at,updated_at) VALUES('cited-entity','Visible entity','visible entity','concept','default','2026','2026')",
	);
	await write(
		"INSERT INTO evidence_citations(derived_kind,derived_id,agent_id,evidence_kind,evidence_id) VALUES('entity','cited-entity','default','memory','visible')",
	);
	const paths = [
		"/api/telemetry/memory-search?limit=1",
		"/api/telemetry/memory-search/export?limit=1",
		"/api/checkpoints?project=atlas&limit=1",
		"/api/checkpoints/thread?limit=1",
		"/api/diagnostics/database/tables/memories/sample?limit=1",
	];
	const read = async (path: string, audience = false) => {
		const res = await app.request(path, { headers: audience ? { "x-test-user": "audience" } : {} });
		expect(res.status).toBe(200);
		return res.headers.get("content-type")?.includes("ndjson") ? res.text() : res.json();
	};
	const before = await Promise.all(paths.map((path) => read(path)));
	await write(
		"INSERT INTO session_transcripts(session_key,content,harness,agent_id,compartment_id,created_at,updated_at) VALUES('thread','secret session','test','default',1,'9999','9999')",
	);
	await write(
		"INSERT INTO memories(id,content,agent_id,compartment_id,created_at,updated_at) VALUES('hidden','secret','default',1,'9999','9999')",
	);
	await write(
		"INSERT INTO embeddings(id,content_hash,chunk_text,source_type,source_id,vector,dimensions,created_at,agent_id,compartment_id) VALUES('hidden-e','hidden-h','secret','memory','hidden',?,2,'9999','default',1)",
		[{ type: "bytes", base64: Buffer.from(new Float32Array([0, 1]).buffer).toString("base64") }],
	);
	await write(
		"INSERT INTO session_checkpoints(id,session_key,harness,project,project_normalized,trigger,digest,prompt_count,created_at,agent_id,compartment_id) VALUES('hidden-checkpoint','thread','test','atlas','atlas','manual','secret',1,'9999','default',1)",
	);
	await write(
		"INSERT INTO memory_search_telemetry(id,created_at,route,agent_id,session_key,project,query,filters_json,method,result_count,no_hits,duration_ms,timings_json,results_json,compartment_id) VALUES('hidden-search','9999','test','default','thread','atlas','secret','{}','hybrid',1,0,1,'{}','[]',1)",
	);
	await write(
		"INSERT INTO memory_jobs(id,memory_id,job_type,status,error,created_at,updated_at) VALUES('hidden-job','hidden','embed','dead','secret','2000','2000')",
	);
	expect(await Promise.all(paths.map((path) => read(path)))).toEqual(before);
	await write("UPDATE memories SET content='edited secret' WHERE id='hidden'");
	await write("UPDATE session_checkpoints SET digest='edited secret' WHERE id='hidden-checkpoint'");
	await write("UPDATE memory_search_telemetry SET query='edited secret' WHERE id='hidden-search'");
	expect(await Promise.all(paths.map((path) => read(path)))).toEqual(before);
	const allowed = await Promise.all(paths.map((path) => read(path, true)));
	for (let i = 0; i < allowed.length; i++) expect(allowed[i]).not.toEqual(before[i]);
	const queue = await body("/api/diagnostics/queue");
	expect(queue.oldestDeadMemoryJob).toBeNull();
	expect((await body("/api/diagnostics/queue", true)).oldestDeadMemoryJob).toMatchObject({ id: "hidden-job" });
	await write(
		"INSERT INTO memories(id,content,agent_id,created_at,updated_at) VALUES('copied','copied visible','default','2090','2090')",
	);
	await write(
		"INSERT INTO embeddings(id,content_hash,chunk_text,source_type,source_id,vector,dimensions,created_at,agent_id) VALUES('copied-e','copied-h','chunk','memory','copied',?,2,'2090','default')",
		[{ type: "bytes", base64: Buffer.from(new Float32Array([1, 1]).buffer).toString("base64") }],
	);
	await write("INSERT INTO evidence_citations VALUES('memory','copied','default','memory','visible')");
	await write(
		"INSERT INTO memory_jobs(id,memory_id,job_type,status,error,created_at,updated_at) VALUES('copied-job','copied','embed','dead','copied error','2090','2090')",
	);
	expect(await body("/api/diagnostics/queue")).toMatchObject({ oldestDeadMemoryJob: { id: "copied-job" } });
	await write(
		"INSERT INTO memory_search_telemetry(id,created_at,route,agent_id,query,filters_json,method,result_count,no_hits,duration_ms,timings_json,results_json,compartment_id) VALUES('copied-search','2090','copy','default','copied visible','{}','hybrid',1,0,1,'{}','[]',2)",
	);
	await write("INSERT INTO evidence_citations VALUES('telemetry','copied-search','default','memory','copied')");
	expect(await body("/api/telemetry/memory-search")).toMatchObject({ count: 1, items: [{ id: "copied-search" }] });
	await write(
		"INSERT INTO org_jobs(id,kind,status,params_json,created_at) VALUES('pending-classify','classify','running',?, '2026-01-01')",
		[JSON.stringify({ id: "cls_secret", target: { kind: "memory", id: "visible", agentId: "default" } })],
	);
	await write(
		"INSERT INTO classification_assignments(target_kind,target_id,agent_id,classification_id,applied_by,applied_at) VALUES('memory','visible','default','cls_secret','audience','2026-01-01')",
	);
	expect(await body("/api/diagnostics/database/tables/entities/sample")).toMatchObject({ rows: [], rowCount: 0 });
	expect(await body("/api/diagnostics/database/tables/entities/sample", true)).toMatchObject({
		rows: [{ id: "cited-entity" }],
		rowCount: 1,
	});
	expect(await body("/api/telemetry/memory-search")).toMatchObject({ count: 0, items: [] });
	expect(await body("/api/diagnostics/queue")).toMatchObject({
		oldestDeadMemoryJob: null,
		queues: { memory: { dead: 0 } },
	});
	expect(await body("/api/diagnostics/queue", true)).toMatchObject({ queues: { memory: { dead: 2 } } });
	await write("UPDATE memories SET compartment_id=1 WHERE id='visible'");
});

test("organization permissions do not bypass unavailable unlabelled diagnostics or leak into other routes", async () => {
	for (const path of [
		"/api/logs",
		"/api/logs/stream",
		"/api/config",
		"/api/identity",
		"/api/telemetry/events",
		"/api/telemetry/export",
		"/api/telemetry/stats",
		"/api/analytics/usage",
		"/api/analytics/errors",
		"/api/analytics/continuity",
		"/api/analytics/memory-safety",
	]) {
		const response = await app.request(path);
		expect(response.status).toBe(403);
		expect(await response.json()).toMatchObject({ reason: "org_policy" });
	}
	const repair = await app.request("/api/diagnostics/queue/repair", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ action: "requeue", dryRun: true }),
	});
	expect(repair.status).toBe(403);
	expect(await repair.json()).toMatchObject({ reason: "org_policy" });
	expect((await app.request("/api/update/config")).status).toBe(200);
});

test("checkpoint reads require recall permission even for an audience administrator", async () => {
	for (const path of ["/api/checkpoints?project=atlas", "/api/checkpoints/thread"]) {
		const response = await app.request(path, {
			headers: { "x-test-user": "audience", "x-test-empty-permissions": "1" },
		});
		expect(response.status).toBe(403);
		expect(await response.json()).toMatchObject({ reason: "permission", required: "recall" });
	}
});

test("database samples preserve binary cell placeholders over the owner transport", async () => {
	await write(
		"INSERT INTO memories(id,content,agent_id,created_at,updated_at) VALUES('binary-memory',?,'default','2026','2026')",
		[{ type: "bytes", base64: Buffer.from([1, 2, 3]).toString("base64") }],
	);
	expect(await body("/api/diagnostics/database/tables/memories/sample?limit=100")).toMatchObject({
		rows: [{ id: "binary-memory", content: "[blob 3 bytes]" }],
		rowCount: 1,
	});
});

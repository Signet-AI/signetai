import { getDreamingReviewedEvidence } from "./dreaming-evidence-reviews";
import { getDreamingEvidenceExclusions } from "./dreaming";
import { createDreamingAgentTools } from "./dreaming-agent-tools";
import { Hono } from "hono";
import { bindPrincipalAccess } from "../auth/agent-access";
import type { Principal } from "../auth/principal";
import { registerPipelineRoutes } from "../routes/pipeline-routes";
import { dreamingLiveEvents } from "./dreaming-live-events";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDbAccessor, getDbAccessor, initDbAccessor } from "../db-accessor";
import { getDbOwnerForAccessor } from "../db-owner-runtime";
import type { ReadScope } from "../read-scope";
import { getActiveDreamingPasses, getDreamingPass, getDreamingPasses, getDreamingToolCalls } from "./dreaming";
import { listDreamingAttention, createDreamingCapabilities } from "./dreaming-capabilities";
import { readDreamingPassRecord } from "./dreaming-runbook";
import { zoomDreamingHistory } from "./dreaming-history";

let dir = "";
const scope: ReadScope = { reach: { kind: "all" }, compartments: [], projects: null };
const audience: ReadScope = { ...scope, compartments: [1] };
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "dream-read-scope-"));
	initDbAccessor(join(dir, "test.db"), { agentsDir: dir });
	getDbAccessor().withWriteTx((db) => {
		db.prepare(
			"INSERT INTO agents(id,name,created_at,updated_at) VALUES ('agent-a','A','now','now'),('agent-b','B','now','now')",
		).run();
		db.prepare("INSERT INTO compartments(id,key) VALUES(1,'hidden')").run();
		db.prepare("INSERT INTO classifications(id,name,created_at) VALUES('cls_hidden','Hidden','now')").run();
		db.prepare("INSERT INTO compartment_members(compartment_id,classification_id) VALUES(1,'cls_hidden')").run();
		db.prepare(
			"INSERT INTO classification_audience(classification_id,principal_kind,principal_id) VALUES('cls_hidden','user','hr')",
		).run();
		db.prepare(
			"INSERT INTO dreaming_passes(id,agent_id,status,mode,created_at,runbook_json,compartment_id) VALUES('visible','agent-b','running','incremental','2026-01-01','{}',NULL),('hidden','agent-b','running','incremental','2026-01-02','{}',1)",
		).run();
		db.prepare(
			"INSERT INTO dreaming_tool_calls(id,agent_id,pass_id,sequence,tool_name,input_json,output_json,success,latency_ms) VALUES('hidden-call','agent-b','hidden',1,'search_evidence','{}','{}',1,1)",
		).run();
		db.prepare(
			"INSERT INTO dreaming_attention(id,agent_id,kind,subject_ref,details_json,priority,compartment_id) VALUES('visible-attention','agent-b','hygiene','visible','{}',1,NULL),('hidden-attention','agent-b','hygiene','hidden','{}',100,1)",
		).run();
		db.prepare(
			"INSERT INTO dreaming_history_nodes(agent_id,scope_key,level,idx,pass_id,text,compartment_id) VALUES('agent-b','agent-b',0,0,'hidden','secret',1)",
		).run();
	});
});
afterEach(async () => {
	dreamingLiveEvents.reset();
	await closeDbAccessor();
	rmSync(dir, { recursive: true, force: true });
});
test("stored pass reads enforce label and reach before limits and child logs", async () => {
	const accessor = getDbAccessor();
	expect((await getDreamingPasses(accessor, "agent-a", 1, scope)).map((p) => p.id)).toEqual(["visible"]);
	expect((await getActiveDreamingPasses(accessor, "agent-a", { readScope: scope })).map((p) => p.id)).toEqual([
		"visible",
	]);
	expect(await getDreamingPass(accessor, "agent-a", "hidden", { readScope: scope })).toBeNull();
	expect(await getDreamingToolCalls(accessor, "agent-a", "hidden", scope)).toEqual([]);
	expect(await readDreamingPassRecord(await getDbOwnerForAccessor(accessor), "agent-a", "hidden", scope)).toBeNull();
	expect((await getDreamingPasses(accessor, "agent-a", 1, audience)).map((p) => p.id)).toEqual(["hidden"]);
	expect((await getDreamingToolCalls(accessor, "agent-a", "hidden", audience)).map((c) => c.id)).toEqual([
		"hidden-call",
	]);
	expect(
		await getDreamingPass(accessor, "agent-a", "hidden", {
			readScope: { ...audience, reach: { kind: "own", agentId: "agent-a" } },
		}),
	).toBeNull();
});
test("attention lists apply audience and reach before priority limit", async () => {
	const accessor = getDbAccessor();
	expect(await listDreamingAttention(accessor, { limit: 1, readScope: scope })).toMatchObject([
		{ id: "visible-attention" },
	]);
	expect(await listDreamingAttention(accessor, { limit: 1, readScope: audience })).toMatchObject([
		{ id: "hidden-attention" },
	]);
	expect(await listDreamingAttention(accessor, { readScope: { ...audience, projects: ["atlas"] } })).toEqual([]);
});
test("history zoom hides classified nodes and records while admitting their audience", async () => {
	const input = { agentId: "agent-b", scopeKey: "agent-b", allowedScopes: ["agent-b"], id: 0, n: 1 };
	expect(await zoomDreamingHistory(getDbAccessor(), { ...input, readScope: scope })).toEqual({
		ok: false,
		error: "No line 0+1.",
	});
	expect(await zoomDreamingHistory(getDbAccessor(), { ...input, readScope: audience })).toMatchObject({
		ok: true,
		record: { passId: "hidden" },
	});
});
test("public evidence search excludes classified sources before its limit", async () => {
	getDbAccessor().withWriteTx((db) => {
		db.prepare(
			"INSERT INTO memories(id,agent_id,content,type,memory_kind,created_at,updated_at,compartment_id) VALUES('visible-memory','agent-b','public release','fact','episodic','2026-01-01','2026-01-01',NULL),('hidden-memory','agent-b','secret release','fact','episodic','2026-01-02','2026-01-02',1)",
		).run();
	});
	const invoke = async (readScope: ReadScope) => {
		const tool = createDreamingCapabilities({
			accessor: getDbAccessor(),
			agentId: "agent-b",
			actor: "test",
			readScope,
		}).find((t) => t.id === "search_evidence");
		if (!tool) throw new Error("missing evidence capability");
		return tool.invoke({ agentId: "agent-b", query: "release", limit: 1 });
	};
	expect(await invoke(scope)).toMatchObject({ ok: true, items: [{ id: "visible-memory" }] });
	expect(await invoke(audience)).toMatchObject({ ok: true, items: [{ id: "hidden-memory" }] });
});

function orgApp(userId: string): Hono {
	const principal: Principal = {
		kind: "user",
		userId,
		role: "admin",
		permissions: new Set(["recall", "modify", "admin"]),
		compliance: false,
		groupIds: [],
		credential: { kind: "session", id: "test" },
		sessionId: null,
		deviceId: null,
		harness: null,
		boundAgentId: null,
		allowedProjects: null,
	};
	bindPrincipalAccess(principal, {
		agentModel: "single",
		personalAgentsSelfService: false,
		organizationAgentId: "default",
		personalAgentId: null,
		defaultReadAgentId: "default",
		agents: [
			{ id: "default", kind: "organization", owner_user_id: null, owner_group_id: null, archived_at: null },
			{ id: "agent-b", kind: "personal", owner_user_id: "other", owner_group_id: null, archived_at: null },
		],
	});
	const app = new Hono();
	app.use("*", async (c, next) => {
		c.set("principal", principal);
		c.set("organization", true);
		await next();
	});
	registerPipelineRoutes(app);
	return app;
}

test("organization routes hide pass existence and status changes, with audience SSE access", async () => {
	const app = orgApp("outside");
	const snapshot = async () =>
		Promise.all(
			["/api/dream/status", "/api/dream/passes/active"].map(async (path) => (await app.request(path)).json()),
		);
	const before = await snapshot();
	expect(JSON.stringify(before)).toContain("visible");
	expect(JSON.stringify(before)).not.toContain('"hidden"');
	const absent = await app.request("/api/dream/passes/absent/events");
	const hidden = await app.request("/api/dream/passes/hidden/events");
	expect(hidden.status).toBe(404);
	expect(await hidden.json()).toEqual(await absent.json());
	getDbAccessor().withWriteTx((db) =>
		db
			.prepare(
				"UPDATE dreaming_passes SET summary='changed secret',tokens_consumed=900,status='failed' WHERE id='hidden'",
			)
			.run(),
	);
	expect(await snapshot()).toEqual(before);
	const visible = await orgApp("hr").request("/api/dream/passes/hidden/events");
	expect(visible.status).toBe(200);
	const reader = visible.body?.getReader();
	if (!reader) throw new Error("missing event stream");
	const chunk = await reader.read();
	expect(new TextDecoder().decode(chunk.value)).toContain('"passId":"hidden"');
	await reader.cancel();
	dreamingLiveEvents.reset();
});

test("an open organization stream stops before sending newly hidden events", async () => {
	const app = orgApp("outside");
	dreamingLiveEvents.startPass({ passId: "visible", agentId: "agent-b", mode: "incremental" });
	const response = await app.request("/api/dream/passes/visible/events?agentId=agent-b");
	expect(response.status).toBe(200);
	const reader = response.body?.getReader();
	if (!reader) throw new Error("missing event stream");
	await reader.read();
	getDbAccessor().withWriteTx((db) =>
		db.prepare("UPDATE dreaming_passes SET compartment_id=1 WHERE id='visible'").run(),
	);
	dreamingLiveEvents.publish("visible", "assistant_delta", { delta: "new secret" });
	try {
		expect(await reader.read()).toMatchObject({ done: true });
	} finally {
		await reader.cancel();
	}
	dreamingLiveEvents.reset();
});

test("head, review attention, and graph capabilities preserve visible results when hidden content changes", async () => {
	getDbAccessor().withWriteTx((db) => {
		db.prepare(
			"INSERT INTO memories(id,agent_id,content,type,memory_kind,created_at,updated_at,review_after,compartment_id) VALUES('public-due','agent-b','public deadline','fact','episodic','2026-01-01','2026-01-01','2026-01-01',NULL),('hidden-due','agent-b','secret deadline','fact','episodic','2026-01-01','2026-01-01','2025-01-01',1)",
		).run();
		db.prepare(
			"INSERT INTO entities(id,agent_id,name,canonical_name,entity_type,created_at,updated_at,compartment_id) VALUES('public-entity','agent-b','Public System','public system','project','now','now',NULL),('secret-entity','agent-b','Secret System','secret system','project','now','now',1)",
		).run();
		db.prepare(
			"INSERT INTO memory_head_entries(agent_id,entry_id,canonical_text,entry_hash,status,first_revision,last_revision,created_at,updated_at,compartment_id) VALUES('agent-b','public-head','Public head','a','active',1,1,'now','now',NULL),('agent-b','secret-head','Secret head','b','active',1,1,'now','now',1)",
		).run();
	});
	const invoke = async (readScope: ReadScope, id: string, input: Record<string, unknown> = {}) => {
		const tool = createDreamingAgentTools({
			accessor: getDbAccessor(),
			agentId: "agent-b",
			allowedAgentIds: ["agent-b"],
			actor: "test",
			readScope,
		}).find((tool) => tool.name === id);
		if (!tool) throw new Error("missing capability");
		const result = await tool.execute("test", { agentId: "agent-b", ...input });
		const text = result.content[0];
		if (text?.type !== "text") throw new Error("missing text result");
		const parsed: unknown = JSON.parse(text.text);
		return parsed;
	};
	expect(await invoke(scope, "search_entities", { limit: 1 })).toMatchObject({
		ok: true,
		items: [{ id: "public-entity" }],
	});
	expect(await invoke(scope, "get_entity", { entityId: "secret-entity" })).toMatchObject({
		ok: false,
		error: "Entity not found",
	});
	expect(await invoke(audience, "get_entity", { entityId: "secret-entity" })).toMatchObject({
		ok: true,
		entity: { id: "secret-entity" },
	});
	const head = await invoke(scope, "memory_head_read");
	expect(head).toMatchObject({ ok: true, head: { content: "- Public head" } });
	expect(await invoke(audience, "memory_head_read")).toMatchObject({
		ok: true,
		head: { content: "- Public head\n- Secret head" },
	});
	expect(
		await listDreamingAttention(getDbAccessor(), { kind: "review_due", limit: 1, readScope: scope }),
	).toMatchObject([{ id: "public-due" }]);
	expect(
		await listDreamingAttention(getDbAccessor(), { kind: "review_due", limit: 1, readScope: audience }),
	).toMatchObject([{ id: "hidden-due" }]);
	getDbAccessor().withWriteTx((db) =>
		db
			.prepare("UPDATE memory_head_entries SET canonical_text='Changed secret head' WHERE entry_id='secret-head'")
			.run(),
	);
	expect(await invoke(scope, "memory_head_read")).toEqual(head);
	const app = orgApp("outside");
	const read = await app.request("/api/dream/tools/get_entity", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ input: { agentId: "agent-b", entityId: "public-entity" } }),
	});
	expect(await read.json()).toMatchObject({ ok: true, entity: { id: "public-entity" } });
	const quality = await (await app.request("/api/dream/quality")).json();
	expect(quality).toMatchObject({ graphGarbageRate: { totalEntities: 1 }, structureQuality: { totalEntities: 1 } });
	expect(await (await orgApp("hr").request("/api/dream/quality")).json()).toMatchObject({
		graphGarbageRate: { totalEntities: 2 },
	});
});

test("exclusion and reviewed-evidence logs inherit the stored pass audience", async () => {
	getDbAccessor().withWriteTx((db) => {
		for (const pass of ["visible", "hidden"]) {
			db.prepare(
				"INSERT INTO dreaming_evidence_exclusions(agent_id,source_kind,source_id,reason,pass_id) VALUES('agent-b','memory',?,'test',?)",
			).run(pass, pass);
			db.prepare(
				"INSERT INTO dreaming_evidence_reviews(agent_id,source_kind,source_id,source_captured_at,source_revision,reason,pass_id) VALUES('agent-b','memory',?,'now','now','test',?)",
			).run(pass, pass);
		}
	});
	expect(await getDreamingEvidenceExclusions(getDbAccessor(), "agent-a", scope)).toMatchObject([
		{ sourceId: "visible" },
	]);
	expect(await getDreamingReviewedEvidence(getDbAccessor(), "agent-a", scope)).toMatchObject([{ sourceId: "visible" }]);
	expect(await getDreamingEvidenceExclusions(getDbAccessor(), "agent-a", audience)).toHaveLength(2);
	expect(await getDreamingReviewedEvidence(getDbAccessor(), "agent-a", audience)).toHaveLength(2);
});

test("artifact aliases, deduplication, and transcript suppression cannot observe hidden rows", async () => {
	getDbAccessor().withWriteTx((db) => {
		db.prepare(
			"INSERT INTO memory_artifacts(agent_id,source_path,source_node_id,source_sha256,source_kind,source_id,session_key,session_id,session_token,content,captured_at,updated_at,compartment_id) VALUES('agent-b','public-artifact','shared-node','same-sha','source_obsidian_markdown','vault',NULL,'artifact-session','artifact-token','public release','2026-01-01','2026-01-01',NULL),('agent-b','secret-artifact','shared-node','same-sha','source_obsidian_markdown','vault',NULL,'artifact-session','artifact-token','secret release','2026-01-03','2026-01-03',1),('agent-b','public-capture',NULL,'capture-sha','transcript',NULL,'hidden-session','hidden-session','capture-token','capture release','2026-01-02','2026-01-02',NULL)",
		).run();
		db.prepare(
			"INSERT INTO session_transcripts(session_key,agent_id,content,harness,created_at,completed_at,compartment_id) VALUES('hidden-session','agent-b','hidden release','codex','2026-01-03','2026-01-03',1)",
		).run();
	});
	const invoke = async (readScope: ReadScope, input: Record<string, unknown>) => {
		const tool = createDreamingCapabilities({
			accessor: getDbAccessor(),
			agentId: "agent-b",
			actor: "test",
			readScope,
		}).find((t) => t.id === "search_evidence");
		if (!tool) throw new Error("missing capability");
		return tool.invoke({ agentId: "agent-b", ...input });
	};
	const before = await invoke(scope, { query: "release" });
	expect(before).toMatchObject({ ok: true, items: [{ id: "public-capture" }, { id: "public-artifact" }] });
	expect(await invoke(scope, { sourceRef: "artifact:shared-node" })).toMatchObject({
		ok: true,
		items: [{ id: "public-artifact" }],
	});
	expect(await invoke(audience, { sourceRef: "artifact:shared-node" })).toMatchObject({
		ok: true,
		items: [{ id: "secret-artifact" }],
	});
	getDbAccessor().withWriteTx((db) =>
		db
			.prepare("UPDATE memory_artifacts SET content='changed secret release' WHERE source_path='secret-artifact'")
			.run(),
	);
	expect(await invoke(scope, { query: "release" })).toEqual(before);
	expect(await invoke({ ...audience, reach: { kind: "own", agentId: "agent-a" } }, { query: "release" })).toMatchObject(
		{ ok: true, items: [] },
	);
});

test("pending agent classification hides passes and attention before label batches move", async () => {
	getDbAccessor().withWriteTx((db) =>
		db
			.prepare(
				"INSERT INTO org_jobs(id,kind,status,params_json,created_at) VALUES('job_pending','classify','pending',?,'now')",
			)
			.run(JSON.stringify({ id: "cls_hidden", target: { kind: "agent", agentId: "agent-b", id: "agent-b" } })),
	);
	expect(await getDreamingPasses(getDbAccessor(), "agent-a", 10, { ...scope, inFlightUserId: "outside" })).toEqual([]);
	expect(await listDreamingAttention(getDbAccessor(), { readScope: { ...scope, inFlightUserId: "outside" } })).toEqual(
		[],
	);
	expect(await getDreamingPasses(getDbAccessor(), "agent-a", 10, { ...audience, inFlightUserId: "hr" })).toHaveLength(
		2,
	);
});

test("aspect claims and hydrated counts scope before pagination", async () => {
	getDbAccessor().withWriteTx((db) => {
		db.prepare(
			"INSERT INTO entities(id,agent_id,name,canonical_name,entity_type,created_at,updated_at) VALUES('claim-entity','agent-b','Claim System','claim system','project','now','now')",
		).run();
		db.prepare(
			"INSERT INTO entity_aspects(id,agent_id,entity_id,name,canonical_name) VALUES('claim-aspect','agent-b','claim-entity','Configuration','configuration')",
		).run();
		db.prepare(
			"INSERT INTO entity_attributes(id,agent_id,aspect_id,kind,content,normalized_content,importance,compartment_id) VALUES('public-claim','agent-b','claim-aspect','attribute','Public configuration','public configuration',0.5,NULL),('secret-claim','agent-b','claim-aspect','attribute','Secret configuration','secret configuration',1,1)",
		).run();
	});
	const invoke = async (readScope: ReadScope, id: string, input: Record<string, unknown>) => {
		const tool = createDreamingCapabilities({
			accessor: getDbAccessor(),
			agentId: "agent-b",
			actor: "test",
			readScope,
		}).find((c) => c.id === id);
		if (!tool) throw new Error("missing capability");
		return tool.invoke({ agentId: "agent-b", entityId: "claim-entity", ...input });
	};
	expect(
		await invoke(scope, "list_aspect_claims", { aspectId: "claim-aspect", limit: 1, include: ["contradictions"] }),
	).toMatchObject({ ok: true, items: [{ id: "public-claim" }], contradictions: { items: [], count: 0 } });
	expect(await invoke(audience, "list_aspect_claims", { aspectId: "claim-aspect", limit: 1 })).toMatchObject({
		ok: true,
		items: [{ id: "secret-claim" }],
	});
	expect(await invoke(scope, "get_entity", { include: ["aspects"] })).toMatchObject({
		ok: true,
		attributeCount: 1,
		aspects: [{ attributeCount: 1 }],
	});
	expect(await invoke(audience, "get_entity", { include: ["aspects"] })).toMatchObject({
		ok: true,
		attributeCount: 2,
		aspects: [{ attributeCount: 2 }],
	});
});

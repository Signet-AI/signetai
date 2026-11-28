import { afterEach, beforeEach, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import type { Principal } from "../auth/principal";
import { closeDbAccessor, getDbAccessor, initDbAccessor } from "../db-accessor";
import { getDbOwnerForAccessor } from "../db-owner-runtime";
import { ownerReadAll } from "../db-owner-sql";
import { getDreamingEvidenceExclusions, requestDreamingEvidenceRequeue } from "../pipeline/dreaming";
import { bindDreamingPassTools } from "../pipeline/dreaming-pass-tools";
import { registerPipelineRoutes } from "./pipeline-routes";

let directory = "";
beforeEach(() => {
	directory = mkdtempSync(join(tmpdir(), "signet-status-scope-"));
	initDbAccessor(join(directory, "data", "signet.db"), { agentsDir: directory });
	getDbAccessor().withWriteTx((db) => {
		db.exec(
			"INSERT INTO classifications(id,name) VALUES('cls_secret','Secret'); INSERT INTO compartments(id,key) VALUES(1,'cls_secret'); INSERT INTO compartment_members VALUES(1,'cls_secret')",
		);
		db.exec(
			"INSERT INTO agents(id,name,created_at,updated_at) VALUES('alice','Alice','2026-01-01','2026-01-01'),('bob','Bob','2026-01-01','2026-01-01')",
		);
		db.exec(
			"INSERT INTO session_transcripts(session_key,content,agent_id,created_at,updated_at,completed_at) VALUES('same','Durable evidence.','alice','2026-01-01','2026-01-01','2026-01-01')",
		);
		for (const label of [null, 1]) {
			db.prepare(
				"INSERT INTO dreaming_passes(id,agent_id,mode,status,created_at,compartment_id) VALUES(?,'alice','incremental','running','2026-01-01',?)",
			).run(`pass-${label}`, label);
			db.prepare(
				"INSERT INTO dreaming_evidence_exclusions(agent_id,source_kind,source_id,reason,pass_id,excluded_at,compartment_id) VALUES('alice','transcript','same',?,?,'2026-01-01',?)",
			).run(label === null ? "public" : "private", `pass-${label}`, label);
		}
	});
});
afterEach(async () => {
	await closeDbAccessor();
	rmSync(directory, { recursive: true, force: true });
});

it("native exclusion reads hide labels and enforce agent and project scope before returning rows", async () => {
	const accessor = getDbAccessor();
	expect((await getDreamingEvidenceExclusions(accessor, "alice")).map((row) => row.reason)).toEqual(["public"]);
	expect(
		await getDreamingEvidenceExclusions(accessor, "alice", {
			reach: { kind: "own", agentId: "bob" },
			compartments: "all",
			projects: null,
		}),
	).toEqual([]);
	expect(
		await getDreamingEvidenceExclusions(accessor, "alice", {
			reach: { kind: "own", agentId: "alice" },
			compartments: "all",
			projects: ["restricted"],
		}),
	).toEqual([]);
});

it("native manual requeue changes only the readable canonical source label and cites its attention", async () => {
	const accessor = getDbAccessor();
	expect(await requestDreamingEvidenceRequeue(accessor, "alice", "transcript", "same")).toBe(true);
	const owner = await getDbOwnerForAccessor(accessor);
	const rows = await ownerReadAll(
		owner,
		"SELECT reason FROM dreaming_evidence_exclusions WHERE requeue_requested_at IS NOT NULL",
		[],
		{ operation: "test.exclusions" },
	);
	expect(rows).toEqual([{ reason: "public" }]);
	expect(
		await ownerReadAll(owner, "SELECT compartment_id FROM dreaming_attention", [], { operation: "test.attention" }),
	).toEqual([{ compartment_id: null }]);
	expect(
		await ownerReadAll(
			owner,
			"SELECT evidence_kind,evidence_id FROM evidence_citations WHERE derived_kind='attention'",
			[],
			{ operation: "test.citations" },
		),
	).toEqual([{ evidence_kind: "transcript", evidence_id: "same" }]);
});

it("native manual requeue treats hidden and cross-agent sources as missing without side effects", async () => {
	getDbAccessor().withWriteTx((db) => db.exec("UPDATE session_transcripts SET compartment_id=1"));
	const accessor = getDbAccessor();
	expect(await requestDreamingEvidenceRequeue(accessor, "alice", "transcript", "same")).toBe(false);
	expect(await requestDreamingEvidenceRequeue(accessor, "alice", "transcript", "missing")).toBe(false);
	expect(
		await requestDreamingEvidenceRequeue(accessor, "alice", "transcript", "same", {
			reach: { kind: "own", agentId: "bob" },
			compartments: "all",
			projects: null,
		}),
	).toBe(false);
	expect(
		await requestDreamingEvidenceRequeue(accessor, "alice", "transcript", "same", {
			reach: { kind: "own", agentId: "alice" },
			compartments: [1],
			projects: null,
		}),
	).toBe(true);
	const owner = await getDbOwnerForAccessor(accessor);
	expect(
		await ownerReadAll(
			owner,
			"SELECT reason FROM dreaming_evidence_exclusions WHERE requeue_requested_at IS NOT NULL",
			[],
			{ operation: "test.exclusions" },
		),
	).toEqual([{ reason: "private" }]);
	expect(
		await ownerReadAll(owner, "SELECT compartment_id FROM dreaming_attention", [], { operation: "test.attention" }),
	).toEqual([{ compartment_id: 1 }]);
});

it("explicit admin operations inherit readable classified evidence", async () => {
	getDbAccessor().withWriteTx((db) =>
		db.exec("UPDATE session_transcripts SET compartment_id=1 WHERE agent_id='alice'"),
	);
	const response = await appFor(local).request("/api/dream/operations", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			agentId: "alice",
			operations: [
				{
					operation: "create_entity",
					payload: { name: "Classified admin candidate", type: "project" },
					evidence: [{ source_ref: "transcript:same", quote: "Durable evidence." }],
				},
			],
		}),
	});
	expect(response.status).toBe(200);
	expect(
		getDbAccessor().withReadDb((db) =>
			db.prepare("SELECT compartment_id FROM entities WHERE name='Classified admin candidate'").all(),
		),
	).toEqual([{ compartment_id: 1 }]);
	expect(
		getDbAccessor().withReadDb((db) =>
			db.prepare("SELECT evidence_kind,evidence_id FROM evidence_citations WHERE derived_kind='entity'").all(),
		),
	).toEqual([{ evidence_kind: "transcript", evidence_id: "same" }]);
});

it("does not authorize pass tools by a hidden bare pass id", async () => {
	let calls = 0;
	const release = bindDreamingPassTools({
		passId: "pass-1",
		agentId: "alice",
		tools: [
			{
				name: "runbook_write",
				label: "test",
				description: "test",
				parameters: {},
				execute: async () => {
					calls++;
					return { content: [{ type: "text", text: '{"ok":true}' }], details: {} };
				},
			},
		],
	});
	try {
		const member: Principal = {
			...local,
			kind: "legacy",
			role: "operator",
			permissions: new Set(["modify", "recall"]),
			boundAgentId: "alice",
		};
		const request = (passId: string) =>
			appFor(member).request("/api/dream/tools/runbook_write", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ agentId: "alice", passId, input: {} }),
			});
		const hidden = await request("pass-1");
		const absent = await request("missing");
		expect(hidden.status).toBe(404);
		expect([hidden.status, await hidden.json()]).toEqual([absent.status, await absent.json()]);
		expect(calls).toBe(0);
	} finally {
		await release();
	}
});

it("requires a running readable owned pass or explicit admin target for operations", async () => {
	const member: Principal = {
		...local,
		kind: "legacy",
		role: "operator",
		permissions: new Set(["modify", "recall"]),
		boundAgentId: "alice",
	};
	const operations = [
		{
			operation: "create_entity",
			payload: { name: "Scoped mutation", type: "project" },
			evidence: [{ source_ref: "transcript:same", quote: "Durable evidence." }],
		},
	];
	const request = (body: Record<string, unknown>) => ({
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ operations, ...body }),
	});
	const unboundTool = await appFor(member).request("/api/dream/tools/apply_ontology_ops", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ agentId: "alice", input: { operations } }),
	});
	expect(unboundTool.status).toBe(403);
	const unbound = await appFor(member).request("/api/dream/operations", request({ agentId: "alice" }));
	expect(unbound.status).toBe(403);
	const hidden = await appFor(member).request("/api/dream/operations", request({ agentId: "alice", passId: "pass-1" }));
	const absent = await appFor(member).request(
		"/api/dream/operations",
		request({ agentId: "alice", passId: "missing" }),
	);
	expect(hidden.status).toBe(404);
	expect([hidden.status, await hidden.json()]).toEqual([absent.status, await absent.json()]);
	const implicitAdmin = await appFor(local).request("/api/dream/operations", request({}));
	expect(implicitAdmin.status).toBe(403);
	const allowed = await appFor(member).request(
		"/api/dream/operations",
		request({ agentId: "alice", passId: "pass-null" }),
	);
	expect(allowed.status).toBe(200);
});

function appFor(principal?: Principal) {
	const app = new Hono();
	app.use("*", async (c, next) => {
		if (principal) c.set("principal", principal);
		await next();
	});
	registerPipelineRoutes(app);
	return app;
}
const local: Principal = {
	kind: "local",
	userId: null,
	role: "admin",
	permissions: new Set(["admin", "recall", "modify"]),
	compliance: false,
	groupIds: [],
	credential: { kind: "local", id: "local" },
	sessionId: null,
	deviceId: null,
	harness: null,
	boundAgentId: null,
	allowedProjects: null,
};

it("Dreaming read routes fail closed without an actual request principal", async () => {
	const app = appFor();
	for (const path of [
		"/api/dream/status",
		"/api/dream/passes/active",
		"/api/dream/passes/pass-1/policy",
		"/api/dream/passes/pass-1/tools",
		"/api/dream/quality",
	])
		expect((await app.request(`${path}?agentId=alice`)).status).toBe(401);
});

it("Dreaming local status preserves authorized pass projections and awaits attention", async () => {
	const response = await appFor(local).request("/api/dream/status?agentId=alice");
	expect(response.status).toBe(200);
	const body: unknown = await response.json();
	expect(body).toMatchObject({
		attention: [],
		worker: {
			active: true,
			activePasses: [
				{ passId: "pass-1", mode: "incremental" },
				{ passId: "pass-null", mode: "incremental" },
			],
		},
	});
});

it("Dreaming user status excludes hidden active passes and pages before LIMIT even for admins", async () => {
	const { bindPrincipalAccess } = await import("../auth/agent-access");
	const principal: Principal = {
		...local,
		kind: "user",
		userId: "reader",
		credential: { kind: "session", id: "reader-session" },
	};
	bindPrincipalAccess(principal, {
		agentModel: "single",
		personalAgentsSelfService: false,
		organizationAgentId: "alice",
		personalAgentId: null,
		defaultReadAgentId: "alice",
		agents: [{ id: "alice", kind: "organization", owner_user_id: null, owner_group_id: null, archived_at: null }],
	});
	getDbAccessor().withWriteTx((db) => {
		for (let i = 0; i < 12; i++)
			db.prepare(
				"INSERT INTO dreaming_passes(id,agent_id,mode,status,created_at,compartment_id) VALUES(?,'alice','incremental','running','2099-01-01',1)",
			).run(`hidden-${i}`);
		db.exec(
			"INSERT INTO dreaming_attention(id,agent_id,kind,subject_ref,details_json,priority,compartment_id) VALUES('public-attention','alice','evidence_requeue','transcript:same','{}',1,NULL),('hidden-attention','alice','evidence_requeue','transcript:hidden','{}',100,1)",
		);
	});
	const app = appFor(principal);
	const status = await app.request("/api/dream/status?agentId=alice&measure=1");
	expect(status.status).toBe(200);
	const body: unknown = await status.json();
	expect(body).toMatchObject({
		scheduler: null,
		episodicTokensPending: null,
		passes: [{ id: "pass-null" }],
		exclusions: [{ reason: "public" }],
		attention: [{ id: "public-attention" }],
		worker: { activePasses: [{ passId: "pass-null", mode: "incremental" }] },
	});
	expect(JSON.stringify(body)).not.toContain("hidden-");
	expect(JSON.stringify(body)).not.toContain("pass-1");
	for (const id of ["pass-1", "missing"])
		for (const suffix of ["policy", "events"])
			expect((await app.request(`/api/dream/passes/${id}/${suffix}?agentId=alice`)).status).toBe(404);
	expect(await (await app.request("/api/dream/quality?agentId=alice")).json()).toEqual({
		agentId: "alice",
		unavailable: true,
	});
});

it("Dreaming legacy credentials retain public-only and project bounds", async () => {
	const principal: Principal = {
		...local,
		kind: "legacy",
		credential: { kind: "token", id: "legacy" },
		boundAgentId: "alice",
		allowedProjects: ["bounded"],
	};
	const app = appFor(principal);
	expect((await app.request("/api/dream/status?agentId=bob")).status).toBe(403);
	const response = await app.request("/api/dream/status?agentId=alice");
	expect(response.status).toBe(200);
	expect(await response.json()).toMatchObject({
		passes: [],
		exclusions: [],
		attention: [],
		reviewedEvidence: [],
		worker: { activePasses: [], active: false },
		episodicTokensPending: null,
		scheduler: null,
	});
});

it("native review requeue uses the write owner and preserves other label reviews", async () => {
	getDbAccessor().withWriteTx((db) => {
		for (const label of [null, 1])
			db.prepare(
				"INSERT INTO dreaming_evidence_reviews(agent_id,source_kind,source_id,source_captured_at,source_entry_id,source_revision,reason,pass_id,reviewed_at,compartment_id) VALUES('alice','transcript','same','2026-01-01','','2026-01-01','review',?,'2026-01-01',?)",
			).run(`pass-${label}`, label);
	});
	expect(
		await requestDreamingEvidenceRequeue(
			getDbAccessor(),
			"alice",
			"transcript",
			"same",
			{ reach: { kind: "own", agentId: "alice" }, compartments: [], projects: null },
			{ reviewed: true },
		),
	).toBe(true);
	const owner = await getDbOwnerForAccessor(getDbAccessor());
	expect(
		await ownerReadAll(owner, "SELECT compartment_id FROM dreaming_evidence_reviews", [], {
			operation: "test.reviews",
		}),
	).toEqual([{ compartment_id: 1 }]);
	expect(
		await ownerReadAll(
			owner,
			"SELECT evidence_kind,evidence_id FROM evidence_citations WHERE derived_kind='attention'",
			[],
			{ operation: "test.citations" },
		),
	).toEqual([{ evidence_kind: "transcript", evidence_id: "same" }]);
});

it("native manual requeue rolls back its exclusion update when attention cannot be recorded", async () => {
	getDbAccessor().withWriteTx((db) =>
		db.exec(
			"CREATE TRIGGER reject_attention BEFORE INSERT ON dreaming_attention BEGIN SELECT RAISE(ABORT,'attention blocked'); END",
		),
	);
	await expect(requestDreamingEvidenceRequeue(getDbAccessor(), "alice", "transcript", "same")).rejects.toThrow(
		"attention blocked",
	);
	const owner = await getDbOwnerForAccessor(getDbAccessor());
	expect(
		await ownerReadAll(
			owner,
			"SELECT source_id FROM dreaming_evidence_exclusions WHERE requeue_requested_at IS NOT NULL",
			[],
			{ operation: "test.rollback" },
		),
	).toEqual([]);
});

it("native internal state reads preserve the explicit partition while request state stays scoped", async () => {
	getDbAccessor().withWriteTx((db) =>
		db.exec(
			"INSERT INTO dreaming_state(agent_id,compartment_id,consecutive_failures,last_pass_id) VALUES('alice',1,3,'pass-1')",
		),
	);
	const { getDreamingState } = await import("../pipeline/dreaming");
	expect(await getDreamingState(getDbAccessor(), "alice", 1)).toMatchObject({
		consecutiveFailures: 3,
		lastPassId: "pass-1",
	});
	expect(
		await getDreamingState(getDbAccessor(), "alice", 1, {
			reach: { kind: "own", agentId: "alice" },
			compartments: [],
			projects: null,
		}),
	).toMatchObject({ consecutiveFailures: 0, lastPassId: null });
});

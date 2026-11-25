import { contentRead } from "../content-read";
import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compartmentFor, addObsidianSource } from "@signet/core";
import { Hono } from "hono";
import { bindPrincipalAccess } from "../auth/agent-access";
import { readOrganization } from "../auth/organization-store";
import { localPrincipal, rolePermissions } from "../auth/principal";
import { initDbAccessor, closeDbAccessor, getDbAccessor } from "../db-accessor";
import { closeRegisteredDbOwnerMaintenance } from "../db-owner-maintenance";
import { classify } from "../classifications";
import { registerMemoryRoutes } from "./memory-routes";
import { registerSessionRoutes } from "./session-routes";
import { registerTelemetryRoutes } from "./telemetry-routes";
import { registerSourcesRoutes } from "./sources-routes";
import { registerTranscriptImportRoutes } from "./transcript-import-routes";

const previousPath = process.env.SIGNET_PATH;
const directory = mkdtempSync(join(tmpdir(), "org-read-routes-"));
const at = "2026-11-25T00:00:00.000Z";
let app: Hono;
let compartment: number | null;
let sourceId: string;

beforeAll(async () => {
	process.env.SIGNET_PATH = directory;
	mkdirSync(join(directory, "memory"));
	writeFileSync(join(directory, "agent.yaml"), "embedding:\n  provider: none\nauth:\n  mode: local\n");
	const state = await import("./state");
	state.reloadAuthState(directory);
	initDbAccessor(join(directory, "memory", "memories.db"));
	getDbAccessor().withWriteTx((db) => {
		for (const id of ["default", "alpha", "beta"])
			db.prepare("INSERT OR IGNORE INTO agents (id,name,created_at,updated_at) VALUES (?,?,?,?)").run(id, id, at, at);
		db.prepare("UPDATE agents SET kind='organization' WHERE id='default'").run();
		db.prepare("UPDATE agents SET kind='personal',owner_user_id='alice' WHERE id='alpha'").run();
		db.prepare("UPDATE agents SET kind='personal',owner_user_id='bob' WHERE id='beta'").run();
		db.prepare("INSERT INTO classifications(id,name,created_at,updated_at) VALUES ('cls_hr','HR',?,?)").run(at, at);
		db.prepare("INSERT INTO classification_audience VALUES ('cls_hr','user','carol')").run();
		compartment = compartmentFor(db, ["cls_hr"]);
	});
	const org = await readOrganization();
	app = new Hono();
	app.use("*", async (c, next) => {
		if (c.req.header("x-test-local") === "1") {
			c.set("principal", localPrincipal());
			c.set("author", { userId: null, credential: "local" });
			await next();
			return;
		}
		const role =
			c.req.path === "/api/embeddings/projection" || c.req.header("x-test-admin") === "1"
				? ("admin" as const)
				: ("operator" as const);
		const principal = {
			...localPrincipal(),
			kind: "user" as const,
			userId: c.req.header("x-test-user") ?? "alice",
			role,
			permissions: new Set(
				[...rolePermissions(role)].filter(
					(permission) => c.req.header("x-test-no-recall") !== "1" || permission !== "recall",
				),
			),
		};
		bindPrincipalAccess(principal, {
			agentModel: "personal",
			personalAgentsSelfService: true,
			organizationAgentId: "default",
			personalAgentId: principal.userId === "bob" ? "beta" : "alpha",
			defaultReadAgentId: c.req.header("x-test-personal-default") === "1" ? "alpha" : null,
			agents: [
				{ id: "default", kind: "organization", owner_user_id: null, owner_group_id: null, archived_at: null },
				{ id: "alpha", kind: "personal", owner_user_id: "alice", owner_group_id: null, archived_at: null },
				{ id: "beta", kind: "personal", owner_user_id: "bob", owner_group_id: null, archived_at: null },
			],
		});
		c.set("principal", principal);
		c.set("author", { userId: principal.userId, credential: "local" });
		c.set("organization", org);
		await next();
	});
	registerMemoryRoutes(app, { fetchEmbedding: async () => null });
	registerSessionRoutes(app, {
		gitConfig: {
			enabled: false,
			autoCommit: false,
			autoSync: false,
			syncInterval: 300,
			remote: "origin",
			branch: "main",
		},
		stopGitSyncTimer: async () => {},
		startGitSyncTimer: () => {},
		getGitStatus: async () => ({}),
		gitPull: async () => ({}),
		gitPush: async () => ({}),
		gitSync: async () => ({}),
	});
	registerTelemetryRoutes(app);
	const vault = join(directory, "vault");
	mkdirSync(vault);
	const source = addObsidianSource({ root: vault, name: "Atlas" }, directory);
	if (!source.ok) throw new Error(source.error);
	sourceId = source.source.id;
	registerSourcesRoutes(app, { agentsDir: directory });
	registerTranscriptImportRoutes(app);
	seed("visible", null);
});

afterAll(async () => {
	await closeRegisteredDbOwnerMaintenance();
	await closeDbAccessor();
	if (previousPath === undefined) Reflect.deleteProperty(process.env, "SIGNET_PATH");
	else process.env.SIGNET_PATH = previousPath;
	rmSync(directory, { recursive: true, force: true });
});

function seed(id: string, label: number | null): void {
	getDbAccessor().withWriteTx((db) =>
		db
			.prepare(
				"INSERT INTO memories(id,type,content,created_at,updated_at,updated_by,agent_id,visibility,author_user_id,compartment_id) VALUES (?,'fact',?,?,?,'fixture','beta','private','bob',?)",
			)
			.run(id, `atlas reading ${id}`, at, at, label),
	);
}
async function request(path: string, user = "alice", admin = false) {
	const response = await app.request(`http://localhost${path}`, {
		headers: { "x-test-user": user, "x-test-admin": admin ? "1" : "0" },
	});
	const raw = await response.text();
	const body =
		path.includes("blackbox") || path.includes("timeline")
			? JSON.stringify(JSON.parse(raw), (key, value) =>
					["generatedAt", "generatedFor"].includes(key) ? undefined : value,
				)
			: raw;
	return { status: response.status, headers: [...response.headers], body };
}

describe("organization session read routes", () => {
	test("hidden transcript and summary insertions do not change lists, detail, text, or search", async () => {
		const paths = [
			"/api/sessions",
			"/api/sessions/private",
			"/api/sessions/private/transcript",
			"/api/sessions/summaries?limit=1",
		];
		const before = await Promise.all(paths.map((path) => request(path)));
		const search = async (user = "alice") => {
			const response = await app.request("http://localhost/api/sessions/search", {
				method: "POST",
				headers: { "content-type": "application/json", "x-test-user": user },
				body: JSON.stringify({ query: "atlas" }),
			});
			return { status: response.status, body: await response.text() };
		};
		const beforeSearch = await search();
		getDbAccessor().withWriteTx((db) => {
			db.prepare(
				"INSERT INTO session_transcripts(session_key,agent_id,content,harness,created_at,updated_at,speaker_user_id,compartment_id) VALUES ('private','beta','atlas confidential session','test',?,?,'bob',?)",
			).run(at, at, compartment);
			db.prepare(
				"INSERT INTO session_summaries(id,agent_id,project,depth,kind,content,earliest_at,latest_at,created_at,compartment_id) VALUES ('hidden-summary','beta','atlas',0,'session','atlas confidential summary',?,?,?,?)",
			).run(at, at, at, compartment);
		});
		expect(await Promise.all(paths.map((path) => request(path)))).toEqual(before);
		expect(await search()).toEqual(beforeSearch);
		const transcript = await request("/api/sessions/private/transcript", "carol");
		expect(transcript.status).toBe(200);
		expect(JSON.parse(transcript.body)).toMatchObject({ authorUserId: "bob", speakerUserId: "bob" });
		getDbAccessor().withWriteTx((db) => {
			db.prepare(
				"UPDATE session_transcripts SET content='atlas changed confidential session' WHERE session_key='private'",
			).run();
			db.prepare(
				"UPDATE session_summaries SET content='atlas changed confidential summary' WHERE id='hidden-summary'",
			).run();
			db.prepare(
				"INSERT INTO classifications(id,name,created_at,updated_at) VALUES ('cls_session_extra','Extra',?,?)",
			).run(at, at);
			db.prepare("INSERT INTO classification_audience VALUES ('cls_session_extra','user','carol')").run();
		});
		await classify({ kind: "session", id: "private", agentId: "beta" }, "cls_session_extra", {
			local: true,
			userId: null,
			groupIds: [],
			compliance: true,
			boundAgentId: null,
			allowedProjects: null,
			credential: "local",
		});
		expect(await Promise.all(paths.map((path) => request(path)))).toEqual(before);
		expect(await search()).toEqual(beforeSearch);
		getDbAccessor().withWriteTx((db) =>
			db
				.prepare(
					"DELETE FROM classification_assignments WHERE target_kind='session' AND target_id='private' AND classification_id='cls_session_extra'",
				)
				.run(),
		);
		const positive = await search("carol");
		expect(positive.status).toBe(200);
		expect(JSON.parse(positive.body).hits).toHaveLength(1);
	});
});

describe("organization document read routes", () => {
	test("hidden documents do not change list totals or get and chunks replies", async () => {
		const paths = ["/api/documents?limit=1", "/api/documents/hidden-document", "/api/documents/hidden-document/chunks"];
		const before = await Promise.all(paths.map((path) => request(path)));
		getDbAccessor().withWriteTx((db) =>
			db
				.prepare(
					"INSERT INTO documents(id,source_type,status,created_at,updated_at,agent_id,author_user_id,compartment_id) VALUES ('hidden-document','text','completed',?,?,'beta','bob',?)",
				)
				.run(at, at, compartment),
		);
		expect(await Promise.all(paths.map((path) => request(path)))).toEqual(before);
		const positive = await request("/api/documents/hidden-document", "carol");
		expect(positive.status).toBe(200);
		expect(JSON.parse(positive.body).authorUserId).toBe("bob");
		getDbAccessor().withWriteTx((db) =>
			db
				.prepare("UPDATE documents SET title='changed private document',memory_count=100 WHERE id='hidden-document'")
				.run(),
		);
		expect(await Promise.all(paths.map((path) => request(path)))).toEqual(before);
	});
});

describe("organization checkpoint routes", () => {
	test("checkpoint reads hide scoped and ambiguous legacy rows before paging", async () => {
		const paths = ["/api/checkpoints?project=atlas&limit=1", "/api/checkpoints/private"];
		const before = await Promise.all(paths.map((path) => request(path)));
		getDbAccessor().withWriteTx((db) => {
			for (const [id, agent] of [
				["known-checkpoint", "beta"],
				["legacy-checkpoint", null],
			])
				db.prepare(
					"INSERT INTO session_checkpoints(id,session_key,harness,project,project_normalized,trigger,digest,prompt_count,created_at,agent_id,compartment_id) VALUES (?,'private','test','atlas','atlas','test','confidential digest',1,?,?,?)",
				).run(id, at, agent ?? "beta", compartment);
			db.prepare("UPDATE session_checkpoints SET agent_id=NULL WHERE id='legacy-checkpoint'").run();
		});
		expect(await Promise.all(paths.map((path) => request(path)))).toEqual(before);
		expect(JSON.parse((await request("/api/checkpoints/private", "carol")).body).count).toBe(2);
		expect(JSON.parse((await request("/api/checkpoints/private?agentId=beta", "carol")).body).count).toBe(1);
	});
});

describe("organization source routes", () => {
	test("hidden artifact insertion and source classification do not alter source counts, health, or snapshots", async () => {
		const paths = [
			"/api/sources",
			`/api/sources/${sourceId}/health`,
			`/api/sources/${sourceId}/snapshot`,
			"/api/sessions/private/blackbox?at=2026-11-25T00:00:00.000Z",
			"/api/sessions/blackbox",
		];
		const normalized = async (path: string, user = "alice") => {
			const reply = await request(path, user);
			return {
				...reply,
				body: JSON.stringify(JSON.parse(reply.body), (key, value) =>
					["generatedAt", "exportedAt"].includes(key) ? undefined : value,
				),
			};
		};
		const before = await Promise.all(paths.map((path) => normalized(path)));
		getDbAccessor().withWriteTx((db) =>
			db
				.prepare(
					"INSERT INTO memory_artifacts(agent_id,source_path,source_sha256,source_kind,source_id,session_id,session_token,harness,captured_at,content,updated_at,author_user_id,compartment_id) VALUES ('beta','/atlas/private.md','hash','source_obsidian_markdown',?,'private','private','obsidian',?,'atlas confidential artifact',?,'bob',?)",
				)
				.run(sourceId, at, at, compartment),
		);
		expect(await Promise.all(paths.map((path) => normalized(path)))).toEqual(before);
		const positive = await request(`/api/sources/${sourceId}/snapshot`, "carol");
		expect(positive.status).toBe(200);
		expect(JSON.parse(positive.body).artifacts[0]?.authorUserId).toBe("bob");
		getDbAccessor().withWriteTx((db) =>
			db
				.prepare("UPDATE memory_artifacts SET content='atlas changed private artifact' WHERE source_sha256='hash'")
				.run(),
		);
		expect(await Promise.all(paths.map((path) => normalized(path)))).toEqual(before);
		getDbAccessor().withWriteTx((db) =>
			db
				.prepare(
					"INSERT INTO classification_assignments(target_kind,target_id,agent_id,classification_id,applied_by,applied_at) VALUES ('source',?,'default','cls_hr','carol',?)",
				)
				.run(sourceId, at),
		);
		expect((await request(`/api/sources/${sourceId}/health`)).status).toBe(404);
		expect((await request(`/api/sources/${sourceId}/snapshot`)).status).toBe(404);
		expect(JSON.parse((await request("/api/sources")).body).sources).toHaveLength(0);
		expect((await request(`/api/sources/${sourceId}/snapshot`, "carol")).status).toBe(200);
	});
});

describe("organization transcript import reads", () => {
	test("hidden staging records and jobs do not alter counters, pages, or readable file bytes", async () => {
		const publicLine = '{"text":"atlas public import"}\n';
		const privateLine = '{"text":"atlas private import"}\n';
		getDbAccessor().withWriteTx((db) => {
			db.prepare("INSERT INTO classification_assignments VALUES ('session','private','beta','cls_hr','carol',?)").run(
				at,
			);
			db.prepare("INSERT INTO classification_assignments VALUES ('source','hr-import','beta','cls_hr','carol',?)").run(
				at,
			);
			db.prepare(
				"INSERT INTO source_import_jobs(id,kind,agent_id,schema_id,adapter_version,state,total,rejected,created_at,updated_at) VALUES ('public-job','import','beta','signet-export',1,'completed',1,1,?,?)",
			).run(at, at);
			db.prepare(
				"INSERT INTO source_import_files(id,job_id,source_id,agent_id,ordinal,name,managed_path,state,storage_state,upload_size,upload_offset,created_at,updated_at) VALUES ('public-file','public-job','public-import','beta',0,'atlas.jsonl','unused','completed','sealed',?,?,?,?)",
			).run(publicLine.length, publicLine.length, at, at);
			db.prepare(
				"INSERT INTO source_import_records(id,job_id,file_id,source_id,agent_id,ordinal,line_number,byte_offset,byte_length,raw_hash,status,canonical_key,created_at,updated_at) VALUES ('public-record','public-job','public-file','public-import','beta',0,1,0,?,'hash','rejected','public-session',?,?)",
			).run(publicLine.length, at, at);
			const bytes = Buffer.from(publicLine);
			db.prepare(
				"INSERT INTO source_import_chunks(file_id,agent_id,generation,byte_offset,checksum,content) VALUES ('public-file','beta',0,0,?,?)",
			).run(createHash("sha256").update(bytes).digest("hex"), bytes);
		});
		const paths = [
			"/api/sources/imports",
			"/api/sources/imports/public-job",
			"/api/sources/imports/public-job/rejections",
			"/api/sources/imports/public-job/reconciliation",
			"/api/sources/imports/public-job/files/public-file/content",
			"/api/sources/imports/hidden-job",
		];
		const before = await Promise.all(paths.map((path) => request(path)));
		expect(before[0]?.status).toBe(200);
		expect(before[4]?.body).toBe(publicLine);
		getDbAccessor().withWriteTx((db) => {
			db.prepare(
				"INSERT INTO source_import_records(id,job_id,file_id,source_id,agent_id,ordinal,line_number,byte_offset,byte_length,raw_hash,status,canonical_key,created_at,updated_at) VALUES ('hidden-record','public-job','public-file','public-import','beta',1,2,?,?,'hash','rejected','private',?,?)",
			).run(publicLine.length, privateLine.length, at, at);
			db.prepare("UPDATE source_import_jobs SET total=2,rejected=2 WHERE id='public-job'").run();
			db.prepare("UPDATE source_import_files SET upload_size=?,upload_offset=? WHERE id='public-file'").run(
				publicLine.length + privateLine.length,
				publicLine.length + privateLine.length,
			);
			const bytes = Buffer.from(publicLine + privateLine);
			db.prepare("UPDATE source_import_chunks SET content=?,checksum=? WHERE file_id='public-file'").run(
				bytes,
				createHash("sha256").update(bytes).digest("hex"),
			);
			db.prepare(
				"INSERT INTO source_import_jobs(id,kind,agent_id,schema_id,adapter_version,state,created_at,updated_at) VALUES ('hidden-job','import','beta','signet-export',1,'staging',?,?)",
			).run(at, at);
			db.prepare(
				"INSERT INTO source_import_files(id,job_id,source_id,agent_id,ordinal,name,managed_path,state,created_at,updated_at) VALUES ('hidden-file','hidden-job','hr-import','beta',0,'hr.jsonl','unused','staging',?,?)",
			).run(at, at);
		});
		expect(await Promise.all(paths.map((path) => request(path)))).toEqual(before);
		expect((await request(paths[4], "carol")).body).toBe(publicLine + privateLine);
		expect((await request("/api/sources/imports/hidden-job", "carol")).status).toBe(200);
	});
});

test("A14d prospective dedupe labels come from assignments without creating compartments", async () => {
	expect(await contentRead({ op: "dedupe_compartment", writeScope: { agentId: "beta" } })).toEqual({
		exists: true,
		id: null,
		key: "",
	});
	expect(
		await contentRead({ op: "dedupe_compartment", writeScope: { agentId: "beta", sourceId: "hr-import" } }),
	).toEqual({ exists: true, id: compartment, key: "cls_hr" });
	getDbAccessor().withWriteTx((db) => {
		db.prepare("INSERT INTO classifications(id,name,created_at,updated_at) VALUES ('cls_new','New',?,?)").run(at, at);
		db.prepare(
			"INSERT INTO classification_assignments VALUES ('source','future-source','beta','cls_new','carol',?)",
		).run(at);
	});
	expect(
		await contentRead({ op: "dedupe_compartment", writeScope: { agentId: "beta", sourceId: "future-source" } }),
	).toEqual({ exists: false, id: null, key: "cls_new" });
});

test("A14d document URL dedupe cannot reveal a hidden duplicate", async () => {
	getDbAccessor().withWriteTx((db) =>
		db
			.prepare(
				"INSERT INTO documents(id,source_url,source_type,status,created_at,updated_at,agent_id,author_user_id,compartment_id) VALUES ('hidden-url-document','https://example.test/a14-private','url','queued',?,?,'beta','bob',?)",
			)
			.run(at, at, compartment),
	);
	const response = await app.request("http://localhost/api/documents", {
		method: "POST",
		headers: { "content-type": "application/json", "x-test-user": "bob" },
		body: JSON.stringify({ source_type: "url", url: "https://example.test/a14-private", agentId: "beta" }),
	});
	expect(response.status).toBe(201);
	const body = await response.json();
	expect(body.id).not.toBe("hidden-url-document");
	expect(body.deduplicated).not.toBe(true);
});

test("A15 export requires recall even for its author", async () => {
	const response = await app.request("http://localhost/api/org/export?author=bob", {
		headers: { "x-test-user": "bob", "x-test-no-recall": "1" },
	});
	expect(response.status).toBe(403);
});
test("A15 export is cross-agent by default but audience restricted and explicitly narrowable", async () => {
	seed("export-classified-a15", compartment);
	const exportAs = async (user: string, query = "") => {
		const response = await app.request(`http://localhost/api/org/export?author=bob${query}`, {
			headers: { "x-test-user": user, "x-test-admin": "1", "x-test-personal-default": "1" },
		});
		expect(response.status).toBe(200);
		return response.text();
	};
	expect(await exportAs("carol")).toContain("export-classified-a15");
	expect(await exportAs("alice")).not.toContain("export-classified-a15");
	expect(await exportAs("carol", "&agentId=alpha")).not.toContain("export-classified-a15");
	getDbAccessor().withWriteTx((db) => db.prepare("DELETE FROM memories WHERE id='export-classified-a15'").run());
});
test("A15 continuity hides scores of unreadable sessions before aggregates and latest", async () => {
	const paths = ["/api/analytics/continuity", "/api/analytics/continuity/latest"];
	const before = await Promise.all(paths.map((path) => request(path)));
	getDbAccessor().withWriteTx((db) =>
		db
			.prepare(
				"INSERT INTO session_scores(id,session_key,project,harness,score,reasoning,created_at) VALUES ('a15-score','private','atlas','test',0.7,'confidential score',?)",
			)
			.run(at),
	);
	expect(await Promise.all(paths.map((path) => request(path)))).toEqual(before);
	expect((await request(paths[0], "carol")).body).toContain("confidential score");
});
test("A15 serialized content has no internal columns and export redacts credentials", async () => {
	getDbAccessor().withWriteTx((db) =>
		db
			.prepare(
				"INSERT INTO session_transcripts(session_key,agent_id,content,harness,created_at,updated_at,speaker_user_id) VALUES ('export-hygiene','beta','Authorization: Bearer sk-proj-a15secretcredentialabcdefghijklmnop','test',?,?,'bob')",
			)
			.run(at, at),
	);
	for (const path of ["/api/memory/visible", "/api/documents/hidden-document", "/api/org/export?author=bob"]) {
		const response = await request(path, "carol", true);
		if (response.status !== 200) continue;
		expect(response.body).not.toMatch(
			/"(?:compartment_id|content_hash|normalized_content|vector_clock|idempotency_key|rowid|speaker_user_id|author_user_id)"/,
		);
		expect(response.body).not.toContain("a15secretcredential");
		expect(response.body).not.toContain('"kind":"error"');
	}
});

test("A15 hidden superseders leave live lists unchanged and never leak through lineage or history", async () => {
	seed("a15-old", null);
	seed("a15-secret", compartment);
	const before = await request("/api/memories");
	getDbAccessor().withWriteTx((db) => {
		db.prepare(
			"UPDATE memories SET superseded_by='a15-secret',superseded_at=?,superseded_reason='private replacement' WHERE id='a15-old'",
		).run(at);
		db.prepare(
			"INSERT INTO memory_history(id,memory_id,event,changed_by,metadata,created_at) VALUES ('a15-history','a15-old','superseded','fixture',?,?)",
		).run(JSON.stringify({ supersededBy: "a15-secret" }), at);
	});
	expect(await request("/api/memories")).toEqual(before);
	for (const suffix of ["", "/lineage", "/history"]) {
		const response = await request(`/api/memory/a15-old${suffix}`);
		expect(response.status).toBe(200);
		expect(response.body).not.toContain("a15-secret");
	}
	expect((await request("/api/memory/a15-old/lineage", "carol")).body).toContain("a15-secret");
	getDbAccessor().withWriteTx((db) => {
		db.prepare("DELETE FROM memory_history WHERE id='a15-history'").run();
		db.prepare("DELETE FROM memories WHERE id IN ('a15-old','a15-secret')").run();
	});
});

describe("organization memory read routes", () => {
	test("organization and another personal agent read org-visible private content with authorship", async () => {
		for (const query of ["", "?agentId=beta"]) {
			const reply = await request(`/api/memory/visible${query}`);
			expect(reply.status).toBe(200);
			expect(JSON.parse(reply.body)).toMatchObject({ id: "visible", authorUserId: "bob" });
		}
	});

	test("hidden inserts and updates do not change memory lists, FTS scores, facets, or missing replies", async () => {
		const paths = [
			"/api/memories?limit=1",
			"/memory/search?q=atlas",
			"/memory/search?distinct=who",
			"/api/memory/hidden",
			"/api/memory/hidden/history",
			"/api/memory/hidden/lineage",
			"/api/memories/most-used",
			"/api/memories/curator-slices?minSessions=1",
			"/api/memory/review-queue",
			"/api/memory/timeline",
		];
		const before = await Promise.all(paths.map((path) => request(path)));
		seed("hidden", compartment);
		const after = await Promise.all(paths.map((path) => request(path)));
		expect(after).toEqual(before);
		getDbAccessor().withWriteTx((db) =>
			db.prepare("UPDATE memories SET content='atlas atlas reading confidential',importance=1 WHERE id='hidden'").run(),
		);
		expect(await Promise.all(paths.map((path) => request(path)))).toEqual(before);
		const positive = await request("/memory/search?q=atlas", "carol");
		expect(positive.status).toBe(200);
		expect(
			JSON.parse(positive.body)
				.results.map((row: { id: string }) => row.id)
				.sort(),
		).toEqual(["hidden", "visible"]);
	});

	test("embedding-derived list statistics ignore hidden embeddings on readable parents", async () => {
		seed("statistics-parent", compartment);
		const before = await request("/api/memories");
		getDbAccessor().withWriteTx((db) =>
			db
				.prepare(
					"INSERT INTO embeddings(id,source_type,source_id,content_hash,chunk_text,vector,dimensions,created_at,agent_id,compartment_id) VALUES ('statistics-hidden','memory','statistics-parent','statistics-hidden','hidden',?,2,?,'beta',?)",
				)
				.run(Buffer.from(new Float32Array([0, 1]).buffer), at, compartment),
		);
		expect(await request("/api/memories")).toEqual(before);
		const positive = JSON.parse((await request("/api/memories", "carol")).body);
		expect(positive.stats.withEmbeddings).toBeGreaterThan(JSON.parse(before.body).stats.withEmbeddings);
		getDbAccessor().withWriteTx((db) => db.prepare("DELETE FROM embeddings WHERE id='statistics-hidden'").run());
	});

	test("embedding pages, projection geometry, and similar top-k ignore hidden vectors", async () => {
		seed("neighbor", null);
		getDbAccessor().withWriteTx((db) => {
			for (const [id, vector] of [
				["visible", new Float32Array([1, 0])],
				["neighbor", new Float32Array([0.8, 0.2])],
			] as const)
				db.prepare(
					"INSERT INTO embeddings(id,source_type,source_id,content_hash,chunk_text,vector,dimensions,created_at,agent_id) VALUES (?,'memory',?,?,'vector',?,2,?,'beta')",
				).run(`${id}-vector`, id, `${id}-vector`, Buffer.from(vector.buffer), at);
		});
		const paths = ["/api/embeddings?limit=50", "/api/embeddings/projection?limit=50", "/memory/similar?id=visible&k=1"];
		const before = await Promise.all(paths.map((path) => request(path)));
		for (let n = 0; n < 100; n++) seed(`hidden-vector-${n}`, compartment);
		getDbAccessor().withWriteTx((db) => {
			for (let n = 0; n < 100; n++)
				db.prepare(
					"INSERT INTO embeddings(id,source_type,source_id,content_hash,chunk_text,vector,dimensions,created_at,agent_id,compartment_id) VALUES (?,'memory',?,?,'vector',?,2,?,'beta',?)",
				).run(
					`hidden-vector-${n}-embedding`,
					`hidden-vector-${n}`,
					`hidden-vector-${n}`,
					Buffer.from(new Float32Array([1, 0]).buffer),
					at,
					compartment,
				);
		});
		expect(await Promise.all(paths.map((path) => request(path)))).toEqual(before);
		const positive = await request("/memory/similar?id=visible&k=1", "carol");
		expect(JSON.parse(positive.body).results[0]?.id).toMatch(/^hidden-vector-/);
	});

	test("reclassifying a hidden memory preserves every normalized memory projection", async () => {
		const paths = [
			"/api/memories?limit=1",
			"/api/memories/most-used",
			"/api/memories/curator-slices?minSessions=1",
			"/api/memory/review-queue",
			"/api/memory/timeline",
			"/memory/search?q=atlas",
			"/api/memory/hidden",
			"/api/memory/hidden/history",
			"/api/memory/hidden/lineage",
			"/api/embeddings?limit=50",
			"/api/embeddings/projection?limit=50",
			"/memory/similar?id=visible&k=1",
		];
		const before = await Promise.all(paths.map((path) => request(path)));
		getDbAccessor().withWriteTx((db) =>
			db
				.prepare("INSERT INTO classifications(id,name,created_at,updated_at) VALUES ('cls_payroll','Payroll',?,?)")
				.run(at, at),
		);
		await classify({ kind: "memory", id: "hidden", agentId: "beta" }, "cls_payroll", {
			local: true,
			userId: null,
			groupIds: [],
			compliance: true,
			boundAgentId: null,
			allowedProjects: null,
			credential: "local",
		});
		expect(await Promise.all(paths.map((path) => request(path)))).toEqual(before);
		for (const suffix of ["", "/history", "/lineage"]) {
			const hidden = await request(`/api/memory/hidden${suffix}`);
			const missing = await request(`/api/memory/nonexistent${suffix}`);
			expect(hidden.status).toBe(404);
			expect(hidden).toEqual(missing);
		}
	});

	test("forget previews authorize IDs and readable FTS shards before candidate limits", async () => {
		const preview = async (body: Record<string, unknown>) => {
			const reply = await app.request("http://localhost/api/memory/forget", {
				method: "POST",
				headers: { "content-type": "application/json", "x-test-user": "bob" },
				body: JSON.stringify({ mode: "preview", ...body }),
			});
			return { status: reply.status, body: await reply.text() };
		};
		const beforeIds = await preview({ ids: ["hidden-preview"] });
		const beforeQuery = await preview({ query: "atlas", limit: 1 });
		seed("hidden-preview", compartment);
		expect(await preview({ ids: ["hidden-preview"] })).toEqual(beforeIds);
		expect(await preview({ query: "atlas", limit: 1 })).toEqual(beforeQuery);
		getDbAccessor().withWriteTx((db) =>
			db.prepare("INSERT INTO classification_audience VALUES ('cls_hr','user','bob')").run(),
		);
		const positive = await preview({ query: "atlas", limit: 200 });
		expect(positive.status).toBe(200);
		expect(JSON.parse(positive.body).candidates.some((row: { id: string }) => row.id === "hidden-preview")).toBe(true);
		getDbAccessor().withWriteTx((db) =>
			db.prepare("DELETE FROM classification_audience WHERE classification_id='cls_hr' AND principal_id='bob'").run(),
		);
	});

	test("per-user NDJSON export is self or admin and intersects caller visibility", async () => {
		expect((await request("/api/org/export?author=bob")).status).toBe(403);
		const self = await request("/api/org/export?author=alice");
		expect(self.status).toBe(200);
		expect(self.body).toBe("");
	});
});

test("A15 indexed live lists remain responsive on 20000 memories", async () => {
	seed("a15-bench-hidden", compartment);
	getDbAccessor().withWriteTx((db) => {
		const insert = db.prepare(
			"INSERT INTO memories(id,agent_id,type,content,visibility,created_at,updated_at,updated_by,superseded_by) VALUES (?,'beta','fact','benchmark memory','global',?,?,'test',?)",
		);
		for (let index = 0; index < 20000; index++)
			insert.run(
				`a15-bench-${index}`,
				at,
				at,
				index % 10 === 0 ? "visible" : index % 10 === 1 ? "a15-bench-hidden" : null,
			);
	});
	await request("/api/memories?limit=100");
	const timings: number[] = [];
	for (let n = 0; n < 12; n++) {
		const started = performance.now();
		const result = await request("/api/memories?limit=100");
		expect(result.status).toBe(200);
		timings.push(performance.now() - started);
	}
	timings.sort((a, b) => a - b);
	console.log(
		"A15_LIST_BENCH",
		JSON.stringify({
			rows: 20000,
			medianMs: timings[Math.floor(timings.length / 2)],
			maxMs: timings[timings.length - 1],
		}),
	);
	expect(timings[Math.floor(timings.length / 2)]).toBeLessThan(200);
});

test("A15 projection does not stall concurrent memory reads and caches only its scope", async () => {
	getDbAccessor().withWriteTx((db) => {
		const memory = db.prepare(
			"INSERT INTO memories(id,agent_id,type,content,visibility,created_at,updated_at,updated_by) VALUES (?,'beta','fact','projection concurrency','global',?,?,'test')",
		);
		const embedding = db.prepare(
			"INSERT INTO embeddings(id,source_type,source_id,content_hash,chunk_text,vector,dimensions,created_at,agent_id) VALUES (?,'memory',?,?,'projection',?,64,?,'beta')",
		);
		for (let index = 0; index < 2000; index++) {
			const id = `a15-projection-${index}`;
			memory.run(id, at, at);
			embedding.run(
				id,
				id,
				id,
				Buffer.from(Float32Array.from({ length: 64 }, (_, n) => Math.sin(index + n)).buffer),
				at,
			);
		}
	});
	const pending = request("/api/embeddings/projection?limit=2000");
	await new Promise((resolve) => setTimeout(resolve, 40));
	const start = performance.now();
	expect((await request("/api/memories?limit=1")).status).toBe(200);
	const elapsed = performance.now() - start;
	const projected = await pending;
	expect(projected.status).toBe(200);
	expect(elapsed).toBeLessThan(500);
	expect(await request("/api/embeddings/projection?limit=2000")).toEqual(projected);
	console.log("A15_PROJECTION_CONCURRENT_READ_MS", elapsed);
});

test("A15 metadata lists do not transfer transcript bodies", async () => {
	getDbAccessor().withWriteTx((db) => {
		const insert = db.prepare(
			"INSERT INTO session_transcripts(session_key,agent_id,content,harness,created_at,updated_at,speaker_user_id) VALUES (?,'beta',?,'test',?,?,'bob')",
		);
		for (let n = 0; n < 3; n++) insert.run(`a15-list-${n}`, "x".repeat(2 * 1024 * 1024), at, at);
	});
	const scope = await (await import("../read-scope")).resolveReadScope(
		{ reach: { kind: "all" }, projects: null },
		{ local: false, userId: "bob", groupIds: [] },
	);
	const rows = await contentRead<Array<Record<string, unknown>>>({
		op: "transcripts",
		mode: "list",
		scope,
		limit: 100,
	});
	expect(rows.every((row) => !("content" in row))).toBe(true);
	getDbAccessor().withWriteTx((db) =>
		db.prepare("DELETE FROM session_transcripts WHERE session_key LIKE 'a15-list-%'").run(),
	);
});
test("A15 byte pages bound transcript export replies independently of row count", async () => {
	getDbAccessor().withWriteTx((db) => {
		const insert = db.prepare(
			"INSERT INTO session_transcripts(session_key,agent_id,content,harness,created_at,updated_at,speaker_user_id) VALUES (?,'beta',?,'test',?,?,'bob')",
		);
		for (let n = 0; n < 3; n++) insert.run(`a15-byte-${n}`, "x".repeat(2 * 1024 * 1024), at, at);
	});
	const scope = await (await import("../read-scope")).resolveReadScope(
		{ reach: { kind: "all" }, projects: null },
		{ local: false, userId: "bob", groupIds: [] },
	);
	const rows = await contentRead<Array<Record<string, unknown>>>({
		op: "export",
		table: "session_transcripts",
		author: "bob",
		scope,
		cursor: 0,
		limit: 200,
	});
	expect(rows.length).toBeGreaterThan(0);
	expect(Buffer.byteLength(JSON.stringify(rows))).toBeLessThanOrEqual(4 * 1024 * 1024);
	getDbAccessor().withWriteTx((db) =>
		db.prepare("DELETE FROM session_transcripts WHERE session_key LIKE 'a15-byte-%'").run(),
	);
});
test("A15 export failures after headers terminate with an error record", async () => {
	const response = await app.request("http://localhost/api/org/export?author=bob", {
		headers: { "x-test-user": "bob" },
	});
	expect(response.status).toBe(200);
	const reader = response.body?.getReader();
	if (!reader) throw new Error("Export body missing");
	const first = await reader.read();
	expect(first.done).toBe(false);
	getDbAccessor().withWriteTx((db) => db.exec("ALTER TABLE memory_artifacts RENAME TO a15_unavailable_artifacts"));
	try {
		let text = new TextDecoder().decode(first.value);
		for (;;) {
			const part = await reader.read();
			if (part.done) break;
			text += new TextDecoder().decode(part.value);
		}
		const records = text
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line));
		expect(records[records.length - 1]).toMatchObject({ kind: "error" });
	} finally {
		getDbAccessor().withWriteTx((db) => db.exec("ALTER TABLE a15_unavailable_artifacts RENAME TO memory_artifacts"));
	}
});

test("A15 unlisted SQL cannot enter the content-read owner", async () => {
	const { executeContentRead } = await import("../content-read-owner");
	getDbAccessor().withReadDb((db) => {
		expect(() =>
			Reflect.apply(executeContentRead, null, [
				db,
				{
					op: "scoped_query",
					scope: { reach: { kind: "all" }, compartments: [], projects: null },
					statement: { sql: "SELECT 1 AS unrestricted", result: "get" },
				},
			]),
		).toThrow();
	});
});

test("A15 transcript export redacts content and terminates failed streams explicitly", async () => {
	getDbAccessor().withWriteTx((db) =>
		db
			.prepare(
				"INSERT INTO session_transcripts(session_key,agent_id,content,harness,created_at,updated_at,speaker_user_id) VALUES ('a15-transcript-export','beta',?,'a15-export',?,?,'bob')",
			)
			.run("Authorization: Bearer a15mockcredentialonly", at, at),
	);
	const path = "/api/sources/imports/export/transcripts?harness=a15-export";
	const complete = await request(path, "bob");
	expect(complete.status).toBe(200);
	expect(complete.body).not.toContain("a15mockcredentialonly");
	const response = await app.request(`http://localhost${path}`, { headers: { "x-test-user": "bob" } });
	expect(response.status).toBe(200);
	const reader = response.body?.getReader();
	if (!reader) throw new Error("Export body missing");
	const first = await reader.read();
	expect(first.done).toBe(false);
	getDbAccessor().withWriteTx((db) => db.exec("ALTER TABLE session_transcripts RENAME TO a15_unavailable_transcripts"));
	try {
		let text = new TextDecoder().decode(first.value),
			failure: unknown;
		try {
			for (;;) {
				const part = await reader.read();
				if (part.done) break;
				text += new TextDecoder().decode(part.value);
			}
		} catch (error) {
			failure = error;
		}
		expect(failure).toBeUndefined();
		const records = text
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line));
		expect(records.at(-1)).toMatchObject({ kind: "error" });
	} finally {
		getDbAccessor().withWriteTx((db) =>
			db.exec("ALTER TABLE a15_unavailable_transcripts RENAME TO session_transcripts"),
		);
	}
});

test("B2 own identities and foreign session links survive without transcripts in local and org mode", async () => {
	getDbAccessor().withWriteTx((db) => {
		db.prepare(
			"INSERT INTO session_checkpoints(id,session_key,harness,project,project_normalized,trigger,digest,prompt_count,created_at,agent_id) VALUES ('b2-cp','b2-nox','test','atlas','atlas','test','d',1,?,'beta')",
		).run(at);
		db.prepare(
			"INSERT INTO session_claims(session_key,agent_id,runtime_path,harness,claimed_at,expires_at,state) VALUES ('b2-claim','beta','plugin','test',?,?,'active')",
		).run(at, at);
		db.prepare(
			"INSERT INTO session_scores(id,session_key,project,harness,score,created_at) VALUES ('b2-score','b2-claim','atlas','test',0.4,?)",
		).run(at);
		db.prepare(
			"INSERT INTO session_summaries(id,agent_id,project,depth,kind,content,session_key,earliest_at,latest_at,created_at) VALUES ('b2-summary','beta','atlas',0,'session','summary','b2-nox',?,?,?)",
		).run(at, at, at);
	});
	for (const local of [false, true]) {
		const headers = { "x-test-user": "bob", "x-test-local": local ? "1" : "0" };
		for (const [path, identity] of [
			["/api/checkpoints?agent_id=beta&project=atlas", "b2-nox"],
			["/api/analytics/continuity?agent_id=beta", "b2-claim"],
			["/api/sessions/summaries?agent_id=beta&limit=50", "b2-nox"],
		]) {
			const response = await app.request(`http://localhost${path}`, { headers });
			expect(response.status).toBe(200);
			expect(await response.text()).toContain(`"session_key":"${identity}"`);
		}
	}
	const { redactReadPointers } = await import("../read-pointers");
	const { resolveReadScope } = await import("../read-scope");
	const scope = await resolveReadScope(
		{ reach: { kind: "all" }, projects: null },
		{ local: false, userId: "bob", groupIds: [] },
	);
	expect(
		await redactReadPointers({ sessionId: "b2-claim", source_type: "session", source_id: "b2-nox" }, scope),
	).toEqual({ sessionId: "b2-claim", source_type: "session", source_id: "b2-nox" });
	expect(
		await redactReadPointers(
			{
				agent_id: "beta",
				source_kind: "transcript",
				source_path: "artifact",
				source_id: "not-a-memory",
				source_type: "memory",
			},
			scope,
		),
	).toMatchObject({ source_id: "not-a-memory" });
	getDbAccessor().withWriteTx((db) => {
		db.prepare("UPDATE session_checkpoints SET compartment_id=? WHERE id='b2-cp'").run(compartment);
		db.prepare("UPDATE session_summaries SET compartment_id=? WHERE id='b2-summary'").run(compartment);
		db.prepare(
			"INSERT INTO classification_assignments(target_kind,target_id,agent_id,classification_id,applied_by,applied_at) VALUES ('session','b2-claim','beta','cls_hr','carol',?)",
		).run(at);
	});
	expect(
		await redactReadPointers({ sessionId: "b2-claim", source_type: "session", source_id: "b2-nox" }, scope),
	).toEqual({ sessionId: null, source_type: "session", source_id: null });
});

test("B3 history redacts previous and replacement pointers and their legacy reason", async () => {
	seed("b3-old", null);
	seed("b3-hidden", compartment);
	getDbAccessor().withWriteTx((db) =>
		db
			.prepare(
				"INSERT INTO memory_history(id,memory_id,event,changed_by,reason,metadata,created_at) VALUES ('b3-history','b3-old','superseded','fixture','previous b3-hidden',?,?)",
			)
			.run(JSON.stringify({ previousSupersededBy: "b3-hidden", duplicateOf: "b3-hidden" }), at),
	);
	const response = await request("/api/memory/b3-old/history");
	expect(response.status).toBe(200);
	expect(response.body).not.toContain("b3-hidden");
	expect(response.body).toContain('"reason":null');
});
test("B6 readable deleted superseders remain superseding in every mode", async () => {
	seed("b6-old", null);
	seed("b6-new", null);
	getDbAccessor().withWriteTx((db) => {
		db.prepare("UPDATE memories SET type='b6probe',visibility='global' WHERE id IN ('b6-old','b6-new')").run();
		db.prepare("UPDATE memories SET is_deleted=1 WHERE id='b6-new'").run();
		db.prepare("UPDATE memories SET superseded_by='b6-new' WHERE id='b6-old'").run();
	});
	for (const local of [false, true]) {
		const headers = { "x-test-user": "bob", "x-test-local": local ? "1" : "0" };
		const list = await app.request("http://localhost/api/memories?agent_id=beta&type=b6probe", { headers });
		expect(list.status).toBe(200);
		expect(await list.text()).not.toContain('"id":"b6-old"');
		const detail = await app.request("http://localhost/api/memory/b6-old?agent_id=beta", { headers });
		expect(detail.status).toBe(200);
	}
});

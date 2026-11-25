import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { closeDbAccessor, initDbAccessor } from "../db-accessor";
import { parseAuthConfig } from "./config";
import { createIdentityMiddleware } from "./identity-middleware";
import {
	claimOrganization,
	ensureSetupToken,
	issueSession,
	organizationQuery,
	organizationWrite,
	statement,
} from "./organization-store";
import { generateSecret } from "./tokens";

let dir = "";
let app: Hono;
let token = "";
let csrf = "";
let userId = "";
const config = parseAuthConfig({ mode: "team" }, "/isolated");
beforeEach(async () => {
	dir = mkdtempSync(join(tmpdir(), "org-auth-"));
	initDbAccessor(join(dir, "data.db"), { agentsDir: dir });
	const setup = await ensureSetupToken();
	const result = await claimOrganization({
		setupToken: setup ?? "",
		organizationName: "Example",
		admin: { username: "alice", displayName: "Alice", password: "correct horse battery staple" },
	});
	token = result.accessToken;
	csrf = result.csrf ?? "";
	userId = result.user.id;
	app = new Hono();
	app.use("*", createIdentityMiddleware(config, generateSecret()));
	app.get("/private", (c) => c.json({ userId: c.get("principal")?.userId }));
	app.post("/private", (c) => c.json({ ok: true }));
});
afterEach(async () => {
	await (await import("../db-owner-runtime")).closeDbOwner();
	await closeDbAccessor();
	rmSync(dir, { recursive: true, force: true });
});

describe("organization credential boundary", () => {
	test.each([
		"/api/memory/remember",
		"/api/memory/save",
		"/api/hooks/remember",
		"/api/hooks/session-start",
		"/api/hooks/user-prompt-submit",
		"/api/hooks/stop",
		"/api/hooks/session-end",
		"/api/hooks/compaction-complete",
		"/api/documents",
		"/api/sources/import",
		"/api/sources/imports",
	])("A16 rejects blind writes before handlers and side effects: %s", async (path) => {
		const agentId = `personal-${userId.slice(4)}`;
		await organizationWrite([
			statement("INSERT INTO classifications(id,name) VALUES('cls_destination','Destination')"),
			statement("INSERT INTO classification_assignments VALUES('agent',?,?,'cls_destination',?,'now')", [
				agentId,
				agentId,
				userId,
			]),
			statement("CREATE TABLE destination_side_effects(id INTEGER)"),
		]);
		let entered = false;
		app.post(path, async (c) => {
			entered = true;
			await organizationWrite([statement("INSERT INTO destination_side_effects VALUES(1)")]);
			return c.json({ ok: true });
		});
		const response = await app.request(`${path}?agentId=${agentId}`, {
			method: "POST",
			headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
			body: JSON.stringify({ agentId, sessionKey: "blind-session", content: "Blind evidence" }),
		});
		expect(response.status).toBe(403);
		expect(await response.json()).toEqual({ error: "classified destination", reason: "classified_destination" });
		expect(entered).toBe(false);
		expect(await organizationQuery(statement("SELECT count(*) n FROM destination_side_effects", [], "get"))).toEqual({
			n: 0,
		});
		expect(await organizationQuery(statement("SELECT count(*) n FROM session_transcripts", [], "get"))).toEqual({
			n: 0,
		});
	});
	test("A16 source route bindings are decoded before snapshot import side effects", async () => {
		const agentId = `personal-${userId.slice(4)}`;
		await organizationWrite([
			statement("INSERT INTO classifications(id,name) VALUES('cls_destination','Destination')"),
			statement(
				"INSERT INTO classification_assignments VALUES('source','source:classified',?,'cls_destination',?,'now')",
				[agentId, userId],
			),
		]);
		let entered = false;
		app.post("/api/sources/:sourceId/snapshot/import", (c) => {
			entered = true;
			return c.json({ ok: true });
		});
		const response = await app.request("/api/sources/source%3Aclassified/snapshot/import", {
			method: "POST",
			headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
			body: JSON.stringify({ agentId }),
		});
		expect(response.status).toBe(403);
		expect((await response.json()).reason).toBe("classified_destination");
		expect(entered).toBe(false);
	});
	test("A16 static route names are not interpreted as source destinations", async () => {
		const agentId = `personal-${userId.slice(4)}`;
		await organizationWrite([
			statement("INSERT INTO classifications(id,name) VALUES('cls_destination','Destination')"),
			statement("INSERT INTO classification_assignments VALUES('source','import',?,'cls_destination',?,'now')", [
				agentId,
				userId,
			]),
		]);
		app.post("/api/sources/import", (c) => c.json({ ok: true }));
		const response = await app.request("/api/sources/import", {
			method: "POST",
			headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
			body: JSON.stringify({ agentId }),
		});
		expect(response.status).toBe(200);
	});
	test("A16 owner inheritance rejects principals but permits daemon-internal writes", async () => {
		const agentId = `personal-${userId.slice(4)}`;
		await organizationWrite([
			statement("INSERT INTO classifications(id,name) VALUES('cls_destination','Destination')"),
			statement(
				"INSERT INTO classification_assignments VALUES('session','owner-destination',?,'cls_destination',?,'now')",
				[agentId, userId],
			),
		]);
		const write = (author: string | null) =>
			organizationWrite([
				statement(
					"INSERT INTO memories(id,content,agent_id,author_user_id,compartment_id,created_at,updated_at) VALUES('owner-evidence','Owner evidence',?,?,?,'now','now')",
					[agentId, author, { type: "compartment", scope: { agentId, sessionKey: "owner-destination" } }],
				),
			]);
		app.post("/api/owner-inheritance", async (c) => {
			await write(userId);
			return c.json({ ok: true });
		});
		const denied = await app.request("/api/owner-inheritance", {
			method: "POST",
			headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
			body: "{}",
		});
		expect(denied.status).toBe(403);
		expect((await denied.json()).reason).toBe("classified_destination");
		expect(
			await organizationQuery(statement("SELECT count(*) n FROM memories WHERE id='owner-evidence'", [], "get")),
		).toEqual({ n: 0 });
		expect(await organizationQuery(statement("SELECT count(*) n FROM compartments", [], "get"))).toEqual({ n: 0 });
		await write(null);
		expect(
			await organizationQuery(
				statement("SELECT author_user_id,compartment_id FROM memories WHERE id='owner-evidence'", [], "get"),
			),
		).toEqual({ author_user_id: null, compartment_id: expect.any(Number) });
	});
	test("A16 classified session denies outsiders and audience retries dedupe", async () => {
		const { registerMemoryRoutes } = await import("../routes/memory-routes");
		let embeddingCalls = 0;
		registerMemoryRoutes(app, {
			fetchEmbedding: async () => {
				embeddingCalls++;
				return null;
			},
		});
		const agentId = `personal-${userId.slice(4)}`;
		await organizationWrite([
			statement("INSERT INTO classifications(id,name) VALUES('cls_destination','Destination')"),
			statement(
				"INSERT INTO classification_assignments VALUES('session','blind-session',?,'cls_destination',?,'now')",
				[agentId, userId],
			),
		]);
		const post = () =>
			app.request("/api/memory/remember", {
				method: "POST",
				headers: {
					authorization: `Bearer ${token}`,
					"content-type": "application/json",
					"x-signet-session-key": "blind-session",
				},
				body: JSON.stringify({
					agentId,
					sessionKey: "blind-session",
					content: "Blind evidence",
					idempotencyKey: "destination-retry",
				}),
			});
		const denied = await post();
		expect(denied.status).toBe(403);
		expect((await denied.json()).reason).toBe("classified_destination");
		expect(embeddingCalls).toBe(0);
		expect(await organizationQuery(statement("SELECT count(*) n FROM memories", [], "get"))).toEqual({ n: 0 });
		await organizationWrite([
			statement("INSERT INTO classification_audience VALUES('cls_destination','user',?)", [userId]),
		]);
		const first = await post();
		expect(first.status).toBe(200);
		const memory = await first.json();
		expect(
			await organizationQuery(
				statement(
					"SELECT m.author_user_id, cm.classification_id FROM memories m JOIN compartment_members cm ON cm.compartment_id=m.compartment_id WHERE m.id=?",
					[memory.id],
					"get",
				),
			),
		).toEqual({ author_user_id: userId, classification_id: "cls_destination" });
		const second = await post();
		expect(second.status).toBe(200);
		expect(await second.json()).toMatchObject({ id: memory.id, deduped: true });
	});
	test("A14 hidden hash and idempotency duplicates produce ordinary fresh writes", async () => {
		const { registerMemoryRoutes } = await import("../routes/memory-routes");
		registerMemoryRoutes(app, { fetchEmbedding: async () => null });
		const agentId = `personal-${userId.slice(4)}`;
		for (const idempotencyKey of [undefined, "hidden-write-key"]) {
			const content = `Identical classified evidence ${idempotencyKey ?? "hash"}`;
			const post = () =>
				app.request("/api/memory/remember", {
					method: "POST",
					headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
					body: JSON.stringify({ content, agentId, idempotencyKey }),
				});
			const first = await post();
			expect(first.status).toBe(200);
			const hidden = await first.json();
			await organizationWrite([
				statement("INSERT OR IGNORE INTO classifications(id,name) VALUES('cls_hidden','Hidden')"),
				statement("INSERT OR IGNORE INTO compartments(key,created_at) VALUES('cls_hidden','now')"),
				statement(
					"INSERT OR IGNORE INTO compartment_members SELECT id,'cls_hidden' FROM compartments WHERE key='cls_hidden'",
				),
				statement(
					"UPDATE memories SET compartment_id=(SELECT id FROM compartments WHERE key='cls_hidden') WHERE id=?",
					[hidden.id],
				),
			]);
			const fresh = await post();
			expect(fresh.status).toBe(200);
			const result = await fresh.json();
			expect(result.id).toEqual(expect.any(String));
			expect(result.id).not.toBe(hidden.id);
			expect(result.deduped).not.toBe(true);
			expect(
				await organizationQuery(
					statement("SELECT count(*) AS n FROM memories WHERE content=? AND agent_id=?", [content, agentId], "get"),
				),
			).toEqual({ n: 2 });
			const retry = await post();
			expect((await retry.json()).id).toBe(result.id);
		}
	});
	test("cross-agent message content inherits the sender session and admitted author", async () => {
		await organizationWrite([
			statement("INSERT INTO classifications(id,name) VALUES('cls_hr','HR')"),
			statement(
				"INSERT INTO classification_assignments VALUES('session','classified-sender','default','cls_hr',?,'now')",
				[userId],
			),
		]);
		const { createAgentMessageAsync } = await import("../cross-agent");
		const message = await createAgentMessageAsync({
			fromAgentId: "default",
			fromSessionKey: "classified-sender",
			toAgentId: "default",
			content: "classifiedmessage",
			author: { userId, credential: "session:test" },
		});
		expect(
			await organizationQuery(
				statement("SELECT compartment_id,author_user_id FROM cross_agent_messages WHERE id=?", [message.id], "get"),
			),
		).toEqual({ compartment_id: expect.any(Number), author_user_id: userId });
	});
	test("R2 attribution does not manufacture organization jobs", async () => {
		const { createAgentMessageAsync } = await import("../cross-agent");
		await createAgentMessageAsync({
			fromAgentId: "default",
			toAgentId: "default",
			content: "Author context",
			author: { userId, credential: "session:test" },
		});
		expect(
			await organizationQuery(
				statement("SELECT COUNT(*) AS n FROM org_jobs WHERE kind='write_attribution'", [], "get"),
			),
		).toEqual({ n: 0 });
	});

	test("R16 workspace native notes require an administrator", async () => {
		await organizationWrite([statement("UPDATE users SET role='member' WHERE id=?", [userId])]);
		const { registerMemoryRoutes } = await import("../routes/memory-routes");
		registerMemoryRoutes(app);
		const response = await app.request("/api/memory/codex-native-note", {
			method: "POST",
			headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
			body: JSON.stringify({ content: "Workspace native note" }),
		});
		expect(response.status).toBe(403);
	});

	test("R2 reflection answers resolve the personal agent and principal author", async () => {
		const { registerReflectionRoutes } = await import("../routes/reflection-routes");
		registerReflectionRoutes(app, { agentsDir: dir });
		const agentId = `personal-${userId.slice(4)}`;
		await organizationWrite([
			statement(
				"INSERT INTO daily_reflections(id,agent_id,date,question) VALUES ('review-reflection',?,date('now'),'What matters?')",
				[agentId],
			),
		]);
		const response = await app.request("/api/reflections/review-reflection/answer?agentId=default", {
			method: "POST",
			headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
			body: JSON.stringify({ answer: "An attributed reflection answer" }),
		});
		expect(response.status).toBe(200);
		const result = await response.json();
		expect(
			await organizationQuery(
				statement("SELECT agent_id,author_user_id FROM memories WHERE id=?", [result.memoryId], "get"),
			),
		).toEqual({ agent_id: agentId, author_user_id: userId });
	});
	test("R2 compaction summaries retain their explicit principal author", async () => {
		const { commitCompactionSummary } = await import("../session-transcripts");
		const { getDbAccessor } = await import("../db-accessor");
		const agentId = `personal-${userId.slice(4)}`;
		expect(
			await commitCompactionSummary(getDbAccessor(), {
				agentId,
				author: { userId, credential: "session:review" },
				sessionKey: null,
				harness: "test",
				project: null,
				summary: "An attributed summary",
				summaryId: "review-summary",
				now: new Date().toISOString(),
			}),
		).toBe(true);
		expect(
			await organizationQuery(statement("SELECT author_user_id FROM memories WHERE id='review-summary'", [], "get")),
		).toEqual({ author_user_id: userId });
	});
	test("classified hook speaker binding inherits before the empty transcript insert", async () => {
		const agentId = `personal-${userId.slice(4)}`;
		await organizationWrite([
			statement("INSERT INTO classifications(id,name) VALUES('cls_hr','HR')"),
			statement("INSERT INTO classification_audience VALUES('cls_hr','user',?)", [userId]),
			statement("INSERT INTO classification_assignments VALUES('agent',?,?,'cls_hr',?,'now')", [
				agentId,
				agentId,
				userId,
			]),
		]);
		app.post("/api/hooks/session-start", (c) => c.json({ ok: true }));
		const response = await app.request("/api/hooks/session-start", {
			method: "POST",
			headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
			body: JSON.stringify({ sessionKey: "classified-bound", harness: "test" }),
		});
		expect(response.status).toBe(200);
		expect(
			await organizationQuery(
				statement(
					"SELECT speaker_user_id,compartment_id FROM session_transcripts WHERE session_key='classified-bound'",
					[],
					"get",
				),
			),
		).toEqual({ speaker_user_id: userId, compartment_id: expect.any(Number) });
	});
	test("R2 compaction binds the session speaker before the handler", async () => {
		app.post("/api/hooks/compaction-complete", (c) => c.json({ ok: true }));
		const response = await app.request("/api/hooks/compaction-complete", {
			method: "POST",
			headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
			body: JSON.stringify({ sessionKey: "review-compaction", harness: "test", summary: "Summary" }),
		});
		expect(response.status).toBe(200);
		expect(
			await organizationQuery(
				statement("SELECT speaker_user_id FROM session_transcripts WHERE session_key='review-compaction'", [], "get"),
			),
		).toEqual({ speaker_user_id: userId });
	});

	test("documents retain the resolved personal agent and principal author", async () => {
		const { registerMemoryRoutes } = await import("../routes/memory-routes");
		registerMemoryRoutes(app);
		const response = await app.request("/api/documents", {
			method: "POST",
			headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
			body: JSON.stringify({ source_type: "text", content: "Document authorship evidence", agentId: "default" }),
		});
		expect(response.status).toBe(201);
		const body = await response.json();
		expect(
			await organizationQuery(
				statement("SELECT author_user_id,agent_id FROM documents WHERE id = ?", [body.id], "get"),
			),
		).toEqual({ author_user_id: userId, agent_id: `personal-${userId.slice(4)}` });
		expect(
			await organizationQuery(
				statement(
					"SELECT actor_user_id FROM audit_events WHERE action = 'document.created' AND target_id = ?",
					[body.id],
					"get",
				),
			),
		).toEqual({ actor_user_id: userId });
	});
	test("file import rejects a missing author before source registration", async () => {
		const { importDocument } = await import("../document-import-service");
		const input = {
			author: { userId, credential: "session:source" },
			fileName: "missing.md",
			bytes: new TextEncoder().encode("No author"),
			agentId: `personal-${userId.slice(4)}`,
			workspaceRoot: dir,
		};
		Reflect.deleteProperty(input, "author");
		await expect(importDocument(input)).rejects.toThrow("write_author_required");
		expect((await import("node:fs")).existsSync(join(dir, "sources.json"))).toBe(false);
	});
	test("file imports retain the explicit principal on their evidence artifacts", async () => {
		const { importDocument } = await import("../document-import-service");
		const result = await importDocument({
			fileName: "authored.txt",
			bytes: new TextEncoder().encode("Authored file import evidence"),
			workspaceRoot: dir,
			agentId: "default",
			author: { userId, credential: "session:test" },
		});
		if (result.status.status !== "imported") throw new Error("Expected imported evidence");
		expect(
			await organizationQuery(
				statement(
					"SELECT DISTINCT author_user_id FROM memory_artifacts WHERE source_id = ?",
					[result.status.sourceId],
					"all",
				),
			),
		).toEqual([{ author_user_id: userId }]);
	});

	test("POST recall resolves a readable personal agent without requiring act-as", async () => {
		const { id } = await import("./organization-store");
		const other = id("usr");
		await organizationWrite([
			statement("INSERT INTO users (id,username,display_name,role) VALUES (?,'other','Other','member')", [other]),
			statement(
				"INSERT INTO agents (id,name,kind,owner_user_id,read_policy,created_at,updated_at) VALUES ('other-personal','Other','personal',?,'isolated',datetime('now'),datetime('now'))",
				[other],
			),
		]);
		app.post("/api/memory/recall", (c) => c.json({ ok: true }));
		const response = await app.request("/api/memory/recall", {
			method: "POST",
			headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
			body: JSON.stringify({ agentId: "other-personal" }),
		});
		expect(response.status).toBe(200);
	});

	test("cross-agent message creation carries its principal through the DB owner", async () => {
		const { createAgentMessageAsync } = await import("../cross-agent");
		const author = { userId, credential: "session:test" };
		const message = await createAgentMessageAsync({
			fromAgentId: "default",
			toAgentId: "default",
			content: "Owned message",
			author,
		});
		expect(
			await organizationQuery(
				statement(
					"SELECT actor_user_id AS userId,actor_credential AS credential FROM audit_events WHERE target_id=? AND action='message.created'",
					[message.id],
					"get",
				),
			),
		).toEqual(author);
	});
	test("Dreaming pass admission records the initiating principal without changing claim authorship", async () => {
		const { createDreamingPass } = await import("../pipeline/dreaming");
		const { getDbAccessor } = await import("../db-accessor");
		const author = { userId, credential: "session:test" };
		const passId = await createDreamingPass(
			getDbAccessor(),
			"default",
			"incremental",
			{ text: "test policy", source: "custom" },
			author,
		);
		expect(
			await organizationQuery(
				statement(
					"SELECT actor_user_id AS userId,actor_credential AS credential FROM audit_events WHERE target_id=? AND action='dreaming.started'",
					[passId],
					"get",
				),
			),
		).toEqual(author);
	});
	test("ontology proposal writes retain the explicit principal author", async () => {
		const { createOntologyProposal } = await import("../ontology-proposals");
		const { getDbAccessor } = await import("../db-accessor");
		const proposal = await createOntologyProposal(getDbAccessor(), {
			agentId: "default",
			operation: "create_entity",
			payload: { name: "Actor" },
			createdBy: `user:${userId}`,
			author: { userId, credential: "session:test" },
		});
		expect(
			await organizationQuery(
				statement("SELECT author_user_id FROM ontology_proposals WHERE id = ?", [proposal.id], "get"),
			),
		).toEqual({ author_user_id: userId });
	});
	test("board projections retain their principal author across projection retries", async () => {
		const { createBoardThread, projectBoardPost } = await import("../board");
		const author = { userId, credential: "session:test" };
		const result = await createBoardThread({
			viewer: { kind: "operator" },
			author: { agentId: "default", principalAuthor: author },
			topic: "authorship",
			title: "Authored thread",
			body: "Principal-authored board evidence",
		});
		await projectBoardPost(result.post.id);
		expect(
			await organizationQuery(
				statement("SELECT author_user_id FROM memory_artifacts WHERE source_external_id = ?", [result.post.id], "get"),
			),
		).toEqual({ author_user_id: userId });
	});
	test("queued transcript imports retain their principal author through the durable admission record", async () => {
		const { createJob } = await import("../transcript-import-store");
		const jobId = crypto.randomUUID();
		const author = { userId, credential: "session:test" };
		await createJob({ jobId, agentId: "default", author });
		expect(
			await organizationQuery(
				statement(
					"SELECT author_user_id AS userId,author_credential AS credential FROM source_import_jobs WHERE id=? AND agent_id='default'",
					[jobId],
					"get",
				),
			),
		).toEqual(author);
		expect(
			await organizationQuery(
				statement("SELECT id FROM source_import_jobs WHERE id=? AND agent_id='different'", [jobId], "get"),
			),
		).toBeNull();
		const { buildCompletedTranscriptCommit, commitCompletedTranscriptBatchInTx } = await import(
			"../transcript-import-commit"
		);
		const { signetExportV1Adapter } = await import("../transcript-import-adapter");
		const { runWriteTxAsync, getDbAccessor } = await import("../db-accessor");
		const record = signetExportV1Adapter.parse({
			source: "signet",
			id: "imported-original",
			harness: "test",
			agent_id: "default",
			session_key: "original",
			project: null,
			timestamp: new Date().toISOString(),
			message_count: 1,
			messages: [{ role: "user", content: "Original named author remains in this evidence" }],
		});
		const commit = buildCompletedTranscriptCommit(record, {
			author,
			agentId: "default",
			sourceId: "import-source",
			sourceRecordId: "source-record",
		});
		await runWriteTxAsync(getDbAccessor(), (db) => commitCompletedTranscriptBatchInTx(db, [{ ...commit, author }]));
		expect(
			await organizationQuery(
				statement(
					"SELECT speaker_user_id FROM session_transcripts WHERE session_key = ?",
					[commit.canonicalKey],
					"get",
				),
			),
		).toEqual({ speaker_user_id: userId });
	});
	test("legacy team rejects empty-scoped members while claimed organizations reject HMAC credentials", async () => {
		const { createToken } = await import("./tokens");
		const signingSecret = generateSecret();
		const identityApp = new Hono();
		identityApp.use("*", createIdentityMiddleware(config, signingSecret));
		identityApp.get("/api/private", (c) => c.json({ ok: true }));
		const empty = createToken(signingSecret, { sub: "legacy-member", role: "member", scope: {} }, 60);
		expect(
			await (await identityApp.request("/api/private", { headers: { authorization: `Bearer ${empty}` } })).json(),
		).toMatchObject({ reason: "legacy_token" });
		await organizationWrite([statement("UPDATE organization SET claimed_at = NULL")]);
		const denied = await identityApp.request("/api/private", { headers: { authorization: `Bearer ${empty}` } });
		expect(denied.status).toBe(401);
		expect(await denied.json()).toMatchObject({ reason: "empty_scope" });
		const scoped = createToken(
			signingSecret,
			{ sub: "legacy-member", role: "member", scope: { agent: "default" } },
			60,
		);
		expect((await identityApp.request("/api/private", { headers: { authorization: `Bearer ${scoped}` } })).status).toBe(
			200,
		);
	});
	test("transcript artifact projections inherit the durable session speaker, not file metadata", async () => {
		const { dbOwnerSourceArtifactUpsert } = await import("../db-owner-runtime");
		await organizationWrite([
			statement(
				"INSERT INTO session_transcripts (agent_id,session_key,content,harness,created_at,speaker_user_id) VALUES ('default','speaker-session','User: hello','test',?,?)",
				[new Date().toISOString(), userId],
			),
		]);
		const now = new Date().toISOString();
		await dbOwnerSourceArtifactUpsert(
			{
				fields: {
					agentId: "default",
					sourcePath: "transcript.md",
					sourceSha256: "speaker-hash",
					sourceKind: "transcript",
					sessionId: "speaker-session",
					sessionKey: "speaker-session",
					sessionToken: "speaker-session",
					project: null,
					harness: "test",
					capturedAt: now,
					startedAt: null,
					endedAt: null,
					manifestPath: null,
					sourceNodeId: null,
					memorySentence: null,
					memorySentenceQuality: null,
					content: "User: hello",
					updatedAt: now,
					sourceMtimeMs: null,
					sourceId: null,
					sourceRoot: null,
					sourceExternalId: null,
					sourceParentPath: null,
					sourceMetaJson: null,
				},
			},
			{ operation: "test.artifact-author", lane: "write", deadlineMs: 30_000 },
		);
		expect(
			await organizationQuery(
				statement("SELECT author_user_id FROM memory_artifacts WHERE source_path = 'transcript.md'", [], "get"),
			),
		).toEqual({ author_user_id: userId });
	});
	test("sliding browser sessions renew the HttpOnly cookie and server expiry together", async () => {
		await organizationWrite([
			statement("UPDATE auth_sessions SET access_expires_at = ?,last_used_at = ? WHERE user_id = ?", [
				new Date(Date.now() + 86400_000).toISOString(),
				new Date(Date.now() - 120_000).toISOString(),
				userId,
			]),
		]);
		const res = await app.request("/private", { headers: { cookie: `signet_session=${token}; signet_csrf=${csrf}` } });
		expect(res.status).toBe(200);
		expect(
			res.headers
				.getSetCookie()
				.some(
					(cookie) =>
						cookie.startsWith("signet_session=") && cookie.includes("HttpOnly") && cookie.includes("Max-Age=604800"),
				),
		).toBe(true);
	});
	test("read audit is bounded, durable after flush, and prunes expired rows in batches", async () => {
		const { bufferReadAudit, flushReadAudit, auditRuntimeStatus, pruneAudit } = await import("./organization-runtime");
		const { localPrincipal } = await import("./principal");
		const p = localPrincipal();
		const before = auditRuntimeStatus().dropped;
		for (let i = 0; i < 10_003; i++) bufferReadAudit(p, "/api/memories", "default", 1);
		expect(auditRuntimeStatus().queued).toBe(10_000);
		expect(auditRuntimeStatus().dropped - before).toBe(3);
		await flushReadAudit();
		expect(auditRuntimeStatus().queued).toBe(0);
		expect(
			await organizationQuery(
				statement("SELECT COUNT(*) AS n FROM audit_events WHERE action = 'content.read'", [], "get"),
			),
		).toEqual({ n: 10_000 });
		expect(
			await organizationQuery(
				statement(
					"SELECT json_extract(detail_json,'$.count') AS n FROM audit_events WHERE action = 'audit.dropped'",
					[],
					"get",
				),
			),
		).toEqual({ n: 3 });
		await organizationWrite([
			statement(
				"INSERT INTO audit_events (id,at,action,outcome) VALUES ('expired','2000-01-01T00:00:00.000Z','fixture','ok')",
			),
		]);
		await pruneAudit();
		expect(
			await organizationQuery(statement("SELECT id FROM audit_events WHERE id = 'expired'", [], "get")),
		).toBeNull();
	});
	test("a revoked session cannot authenticate on the next request", async () => {
		await organizationWrite([
			statement("UPDATE auth_sessions SET revoked_at = ?,revoked_reason = 'revoked' WHERE user_id = ?", [
				new Date().toISOString(),
				userId,
			]),
		]);
		const response = await app.request("/private", { headers: { authorization: `Bearer ${token}` } });
		expect(response.status).toBe(401);
		expect(await response.json()).toMatchObject({ reason: "revoked" });
	});
	test("evidence writes persist an explicit principal author", async () => {
		const { txIngestEnvelope } = await import("../transactions");
		const { runWriteTxAsync } = await import("../db-accessor");
		const { getDbAccessor } = await import("../db-accessor");
		await runWriteTxAsync(getDbAccessor(), (db) =>
			txIngestEnvelope(db, {
				id: "authored",
				content: "hello",
				contentHash: "hello",
				who: "user",
				why: null,
				project: null,
				importance: 0.5,
				type: "fact",
				tags: null,
				pinned: 0,
				sourceType: "manual",
				sourceId: null,
				agentId: "default",
				createdAt: new Date().toISOString(),
				author: { userId, credential: "session:test" },
			}),
		);
		expect(
			await organizationQuery(statement("SELECT author_user_id FROM memories WHERE id = 'authored'", [], "get")),
		).toEqual({ author_user_id: userId });
		const { txForgetMemory } = await import("../transactions");
		await runWriteTxAsync(getDbAccessor(), (db) =>
			txForgetMemory(db, {
				memoryId: "authored",
				reason: "test",
				changedBy: `user:${userId}`,
				changedAt: new Date().toISOString(),
				force: false,
				ctx: { author: { userId, credential: "session:test" } },
			}),
		);
		expect(
			await organizationQuery(
				statement(
					"SELECT actor_user_id,actor_credential,agent_id FROM audit_events WHERE action = 'memory.deleted' AND target_id = 'authored'",
					[],
					"get",
				),
			),
		).toEqual({ actor_user_id: userId, actor_credential: "session:test", agent_id: "default" });
	});
	test("a session resolves its user from server state and deactivation takes effect on the next request", async () => {
		expect(await (await app.request("/private", { headers: { authorization: `Bearer ${token}` } })).json()).toEqual({
			userId,
		});
		await organizationWrite([statement("UPDATE users SET status = 'deactivated' WHERE id = ?", [userId])]);
		const response = await app.request("/private", { headers: { authorization: `Bearer ${token}` } });
		expect(response.status).toBe(401);
		expect(await response.json()).toMatchObject({ reason: "user_deactivated" });
	});
	test("cookie writes require matching server-bound CSRF; bearer writes do not", async () => {
		const cookie = `signet_session=${token}; signet_csrf=${csrf}`;
		expect((await app.request("/private", { method: "POST", headers: { cookie } })).status).toBe(403);
		expect((await app.request("/private", { method: "POST", headers: { cookie, "x-signet-csrf": csrf } })).status).toBe(
			200,
		);
		expect(
			(await app.request("/private", { method: "POST", headers: { authorization: `Bearer ${token}` } })).status,
		).toBe(200);
	});
	test("device revocation is effective without a credential cache window", async () => {
		await organizationWrite([statement("INSERT INTO devices(id,user_id,name) VALUES ('dev_a',?,'Laptop')", [userId])]);
		const session = await issueSession(userId, "cli", "dev_a");
		expect(
			(await app.request("/private", { headers: { authorization: `Bearer ${session.accessToken}` } })).status,
		).toBe(200);
		await organizationWrite([
			statement("UPDATE devices SET revoked_at = ? WHERE id = 'dev_a'", [new Date().toISOString()]),
		]);
		const res = await app.request("/private", { headers: { authorization: `Bearer ${session.accessToken}` } });
		expect(res.status).toBe(401);
		expect(await res.json()).toMatchObject({ reason: "device_revoked" });
	});
	test("claim consumes the setup token atomically", async () => {
		expect(await ensureSetupToken()).toBeNull();
		expect(await organizationQuery(statement("SELECT setup_token_hash FROM organization", [], "get"))).toEqual({
			setup_token_hash: null,
		});
	});
});

test("trusted proxy HTTPS selects secure cookies and accepts its canonical public origin", async () => {
	const { authCookies } = await import("./cookies");
	const probe = new Hono();
	probe.use(
		"*",
		createIdentityMiddleware(parseAuthConfig({ mode: "team", trustedProxies: ["127.0.0.1"] }, "/unused"), null),
	);
	probe.post("/api/auth/login", (c) => c.json(authCookies(c)));
	for (const peer of ["127.0.0.1", "::ffff:127.0.0.1"]) {
		const response = await probe.fetch(
			new Request("http://daemon.invalid/api/auth/login", {
				method: "POST",
				headers: {
					"content-type": "application/json",
					origin: "https://public.example",
					"x-forwarded-proto": "https",
					"x-forwarded-host": "public.example:443",
				},
				body: "{}",
			}),
			{ incoming: { socket: { remoteAddress: peer } } },
		);
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({
			secure: true,
			session: "__Host-signet_session",
			csrf: "__Host-signet_csrf",
		});
	}
});
test("team authentication accepts public_url but not the development Origin exception", async () => {
	await organizationWrite([statement("UPDATE organization SET public_url='https://public.example' WHERE id=1")]);
	const probe = new Hono();
	probe.use("*", createIdentityMiddleware(config, null));
	probe.post("/api/auth/login", (c) => c.json({ ok: true }));
	for (const [origin, status] of [
		["https://public.example", 200],
		["http://localhost:5173", 403],
	] as const) {
		const response = await probe.request("http://daemon.invalid/api/auth/login", {
			method: "POST",
			headers: { "content-type": "application/json", origin },
			body: "{}",
		});
		expect(response.status).toBe(status);
	}
});

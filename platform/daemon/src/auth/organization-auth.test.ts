import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { initDbAccessor, closeDbAccessor } from "../db-accessor";
import {
	organizationQuery,
	organizationWrite,
	statement,
	ensureSetupToken,
	claimOrganization,
	issueSession,
} from "./organization-store";
import { createIdentityMiddleware } from "./identity-middleware";
import { parseAuthConfig } from "./config";
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
	Bun.gc(true);
	await closeDbAccessor();
	rmSync(dir, { recursive: true, force: true });
});

describe("organization credential boundary", () => {
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

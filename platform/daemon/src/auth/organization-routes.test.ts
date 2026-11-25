import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { initDbAccessor, closeDbAccessor } from "../db-accessor";
import { ensureSetupToken, organizationQuery, statement } from "./organization-store";
import { createIdentityMiddleware } from "./identity-middleware";
import { registerOrganizationRoutes } from "../routes/organization-routes";
import { parseAuthConfig } from "./config";
import { generateSecret } from "./tokens";
let dir = "";
let app: Hono;
let setup = "";
let admin = "";
const initialSignetPath = process.env.SIGNET_PATH;
const config = parseAuthConfig({ mode: "team" }, "/isolated");
async function call(path: string, method = "GET", body?: unknown, bearer = admin) {
	return app.request(path, {
		method,
		headers: { "content-type": "application/json", ...(bearer ? { authorization: `Bearer ${bearer}` } : {}) },
		...(body ? { body: JSON.stringify(body) } : {}),
	});
}
async function claim() {
	const res = await call(
		"/api/org/claim",
		"POST",
		{
			setupToken: setup,
			organizationName: "Acme",
			admin: { username: "admin", displayName: "Admin", password: "test password" },
		},
		"",
	);
	expect(res.status).toBe(200);
	const result = await res.json();
	admin =
		res.headers
			.getSetCookie()
			.find((cookie) => cookie.startsWith("signet_session="))
			?.split(";")[0]
			?.slice("signet_session=".length) ?? "";
	result.accessToken = admin;
	return result;
}
beforeEach(async () => {
	dir = mkdtempSync(join(tmpdir(), "org-routes-"));
	process.env.SIGNET_PATH = dir;
	initDbAccessor((await import("@signet/core")).resolveWorkspaceLayout(dir).database, { agentsDir: dir });
	setup = (await ensureSetupToken()) ?? "";
	admin = "";
	app = new Hono();
	app.use("*", createIdentityMiddleware(config, generateSecret()));
	registerOrganizationRoutes(app, config, dir);
	app.post("/write", (c) => c.json({ written: true }));
});
afterEach(async () => {
	await (await import("../db-owner-runtime")).closeDbOwner();
	Bun.gc(true);
	await closeDbAccessor();
	rmSync(dir, { recursive: true, force: true });
	if (initialSignetPath === undefined) delete process.env.SIGNET_PATH;
	else process.env.SIGNET_PATH = initialSignetPath;
});
describe("organization HTTP flows", () => {
	test("A10 refresh retries within sixty seconds return the same current pair across multiple rotations", async () => {
		const root = await claim();
		const { issueSession } = await import("./organization-store");
		const session = await issueSession(root.user.id, "cli");
		const first = await (await call("/api/auth/refresh", "POST", { refreshToken: session.refreshToken }, "")).json();
		const retry = await call("/api/auth/refresh", "POST", { refreshToken: session.refreshToken }, "");
		expect(retry.status).toBe(200);
		const same = await retry.json();
		expect(same.accessToken === first.accessToken && same.refreshToken === first.refreshToken).toBe(true);
		const { closeDbOwner } = await import("../db-owner-runtime");
		await closeDbOwner();
		const second = await (await call("/api/auth/refresh", "POST", { refreshToken: first.refreshToken }, "")).json();
		const oldRetry = await (await call("/api/auth/refresh", "POST", { refreshToken: session.refreshToken }, "")).json();
		expect(oldRetry.accessToken === second.accessToken && oldRetry.refreshToken === second.refreshToken).toBe(true);
	});
	test("offboarding transfer changes agent ownership without rewriting evidence authorship", async () => {
		const root = await claim();
		const invite = await (await call("/api/org/invites", "POST", { role: "member", groupIds: [] })).json();
		const accepted = await call(
			"/api/auth/invites/accept",
			"POST",
			{
				token: new URL(invite.inviteUrl).pathname.split("/").pop(),
				username: "original",
				displayName: "Original",
				password: "test",
			},
			"",
		);
		const departing = await accepted.json();
		const { organizationWrite } = await import("./organization-store");
		await organizationWrite([
			statement(
				"INSERT INTO session_transcripts (agent_id,session_key,content,harness,created_at,speaker_user_id) VALUES (?,?,'User: original evidence','test',?,?)",
				[`personal-${departing.user.id}`, "original-session", new Date().toISOString(), departing.user.id],
			),
		]);
		const preview = await call(`/api/org/users/${departing.user.id}/deactivate`, "POST", {
			mode: "transfer",
			transferTo: root.user.id,
		});
		expect(preview.status).toBe(200);
		expect(
			await organizationQuery(statement("SELECT status FROM users WHERE id = ?", [departing.user.id], "get")),
		).toEqual({ status: "active" });
		const transfer = await call(`/api/org/users/${departing.user.id}/deactivate`, "POST", {
			mode: "transfer",
			transferTo: root.user.id,
			dryRun: false,
		});
		expect(transfer.status).toBe(202);
		expect(
			await organizationQuery(
				statement("SELECT speaker_user_id FROM session_transcripts WHERE session_key = 'original-session'", [], "get"),
			),
		).toEqual({ speaker_user_id: departing.user.id });
		expect(
			await organizationQuery(
				statement("SELECT owner_user_id FROM agents WHERE id = ?", [`personal-${departing.user.id}`], "get"),
			),
		).toEqual({ owner_user_id: root.user.id });
	});
	test("simultaneous refresh retries return the same pair without revoking the session", async () => {
		const root = await claim();
		const { issueSession } = await import("./organization-store");
		const cli = await issueSession(root.user.id, "cli");
		const results = await Promise.all([
			call("/api/auth/refresh", "POST", { refreshToken: cli.refreshToken }, ""),
			call("/api/auth/refresh", "POST", { refreshToken: cli.refreshToken }, ""),
		]);
		expect(results.map((r) => r.status).sort()).toEqual([200, 200]);
		const pairs = await Promise.all(results.map((response) => response.json()));
		expect(pairs[0].accessToken === pairs[1].accessToken && pairs[0].refreshToken === pairs[1].refreshToken).toBe(true);
		const record = await organizationQuery(
			statement("SELECT revoked_reason FROM auth_sessions WHERE id = ?", [cli.sessionId], "get"),
		);
		expect(record).toEqual({ revoked_reason: null });
	});
	test("purge offboarding deletes only authored evidence through the deletion owners", async () => {
		const root = await claim();
		const invite = await (await call("/api/org/invites", "POST", { role: "member", groupIds: [] })).json();
		const accepted = await call(
			"/api/auth/invites/accept",
			"POST",
			{
				token: new URL(invite.inviteUrl).pathname.split("/").pop(),
				username: "departing",
				displayName: "Departing",
				password: "test",
			},
			"",
		);
		const departing = await accepted.json();
		const { getDbAccessor, runWriteTxAsync } = await import("../db-accessor");
		const { txIngestEnvelope } = await import("../transactions");
		const { organizationWrite } = await import("./organization-store");
		await runWriteTxAsync(getDbAccessor(), (db) => {
			for (const [memoryId, owner] of [
				["purge-target", departing.user.id],
				["keep-other", root.user.id],
			])
				txIngestEnvelope(db, {
					id: memoryId,
					content: memoryId,
					contentHash: memoryId,
					who: "fixture",
					why: null,
					project: null,
					importance: 0.5,
					type: "fact",
					tags: null,
					pinned: 0,
					sourceType: "manual",
					sourceId: null,
					agentId: `personal-${owner}`,
					createdAt: new Date().toISOString(),
					author: { userId: owner, credential: "session:fixture" },
				});
		});
		await organizationWrite([
			statement(
				"INSERT INTO session_transcripts (agent_id,session_key,content,harness,created_at,speaker_user_id) VALUES (?,?,'User: disposable test','test',?,?)",
				[`personal-${departing.user.id}`, "departing-session", new Date().toISOString(), departing.user.id],
			),
		]);
		const started = await call(`/api/org/users/${departing.user.id}/deactivate`, "POST", {
			mode: "purge",
			dryRun: false,
		});
		expect(started.status).toBe(202);
		const job = await started.json();
		let status = await (await call(`/api/org/jobs/${job.jobId}`)).json();
		const deadline = Date.now() + 10_000;
		while (status.status === "running" && Date.now() < deadline) {
			await Bun.sleep(50);
			status = await (await call(`/api/org/jobs/${job.jobId}`)).json();
		}
		expect(status.error).toBeNull();
		expect(status.status).toBe("complete");
		expect(
			await organizationQuery(statement("SELECT id FROM memories WHERE id = 'purge-target'", [], "get")),
		).toBeNull();
		expect(await organizationQuery(statement("SELECT id FROM memories WHERE id = 'keep-other'", [], "get"))).toEqual({
			id: "keep-other",
		});
		expect(
			await organizationQuery(
				statement("SELECT session_key FROM session_transcripts WHERE speaker_user_id = ?", [departing.user.id], "all"),
			),
		).toEqual([]);
		expect(
			await organizationQuery(
				statement("SELECT target_id FROM audit_events WHERE action = 'memory.purged'", [], "all"),
			),
		).toEqual([{ target_id: "purge-target" }]);
	});
	test("browser login exposes CSRF and expiry but keeps the access secret in HttpOnly cookies", async () => {
		await claim();
		const response = await call("/api/auth/login", "POST", { username: "admin", password: "test password" }, "");
		expect(response.status).toBe(200);
		const result = await response.json();
		expect(result.accessToken).toBeUndefined();
		expect(result.expiresAt).toBeString();
		expect(result.csrf).toBeString();
		expect(
			response.headers
				.getSetCookie()
				.some((cookie) => cookie.startsWith("signet_session=") && cookie.includes("HttpOnly")),
		).toBe(true);
	});
	test("admin shared-key issuance does not require joining the owning group", async () => {
		await claim();
		const group = await (await call("/api/org/groups", "POST", { name: "Engineering" })).json();
		const created = await call("/api/agents", "POST", { name: "CI", kind: "team", ownerGroupId: group.id });
		expect(created.status).toBe(201);
		const agent = await created.json();
		const key = await call("/api/auth/api-keys", "POST", {
			name: "CI automation",
			kind: "shared",
			agentId: agent.agentId,
			permissions: ["recall"],
			expiresAt: new Date(Date.now() + 3600_000).toISOString(),
		});
		expect(key.status).toBe(201);
	});
	test("empty personal-key permissions never regain the user's admin permissions", async () => {
		await claim();
		const issued = await call("/api/auth/api-keys", "POST", {
			name: "no authority",
			permissions: [],
			expiresAt: new Date(Date.now() + 3600_000).toISOString(),
		});
		expect(issued.status).toBe(201);
		const key = await issued.json();
		const who = await (await call("/api/auth/whoami", "GET", undefined, key.secret)).json();
		expect(who.permissions).toEqual([]);
		expect((await call("/api/org/users", "GET", undefined, key.secret)).status).toBe(403);
	});
	test("idp-managed groups reject manual changes and settings reject embedded secrets", async () => {
		await claim();
		const { organizationWrite } = await import("./organization-store");
		await organizationWrite([
			statement("INSERT INTO groups (id,name,managed_by) VALUES ('grp_idp','Provider group','idp')"),
		]);
		const root = await (await call("/api/auth/whoami")).json();
		expect((await call(`/api/org/groups/grp_idp/members/${root.user.id}`, "PUT", { role: "member" })).status).toBe(409);
		expect(
			(
				await call("/api/org/settings", "PATCH", {
					oidc: {
						issuer: "https://issuer.example",
						clientId: "client",
						clientSecret: "not-allowed",
						allowedDomains: [],
					},
				})
			).status,
		).toBe(400);
	});
	test("claim, invite, device approval, connector provisioning, revocation", async () => {
		await claim();
		const invited = await call("/api/org/invites", "POST", { email: "alice@acme.test", role: "member", groupIds: [] });
		expect(invited.status).toBe(201);
		const invite = await invited.json();
		const accepted = await call(
			"/api/auth/invites/accept",
			"POST",
			{
				token: new URL(invite.inviteUrl).pathname.split("/").pop(),
				username: "alice",
				displayName: "Alice",
				password: "test password",
			},
			"",
		);
		expect(accepted.status).toBe(200);
		const alice = await accepted.json();
		alice.accessToken = accepted.headers
			.getSetCookie()
			.find((cookie) => cookie.startsWith("signet_session="))
			?.split(";")[0]
			?.slice("signet_session=".length);
		const started = await call(
			"/api/auth/device/start",
			"POST",
			{ client: "cli", deviceName: "Laptop", platform: "linux" },
			"",
		);
		expect(started.status).toBe(200);
		const flow = await started.json();
		expect((await call("/api/auth/device/token", "POST", { deviceCode: flow.deviceCode }, "")).status).toBe(428);
		expect(
			(
				await call(
					"/api/auth/device/approve",
					"POST",
					{ userCode: flow.userCode, decision: "approve" },
					alice.accessToken,
				)
			).status,
		).toBe(200);
		const polled = await call("/api/auth/device/token", "POST", { deviceCode: flow.deviceCode }, "");
		expect(polled.status).toBe(200);
		const cli = await polled.json();
		const keyed = await call(
			"/api/auth/connector-keys",
			"POST",
			{ harness: "hermes-agent", deviceId: cli.deviceId },
			cli.accessToken,
		);
		expect(keyed.status).toBe(201);
		const key = await keyed.json();
		const { organizationWrite } = await import("./organization-store");
		const nearingExpiry = new Date(Date.now() + 86_400_000).toISOString();
		await organizationWrite([
			statement("UPDATE api_keys SET expires_at = ? WHERE id = ?", [nearingExpiry, key.key.id]),
		]);
		const who = await call("/api/auth/whoami", "GET", undefined, key.secret);
		expect(who.status).toBe(200);
		expect(await who.json()).toMatchObject({ user: { username: "alice" }, credential: { harness: "hermes-agent" } });
		const renewed = await organizationQuery<{ expires_at: string }>(
			statement("SELECT expires_at FROM api_keys WHERE id = ?", [key.key.id], "get"),
		);
		expect(Date.parse(renewed.expires_at)).toBeGreaterThan(Date.parse(nearingExpiry));
		await organizationWrite([
			statement("UPDATE auth_sessions SET revoked_at = ? WHERE id = ?", [new Date().toISOString(), cli.sessionId]),
			statement("UPDATE api_keys SET expires_at = ? WHERE id = ?", [nearingExpiry, key.key.id]),
		]);
		expect((await call("/api/auth/whoami", "GET", undefined, key.secret)).status).toBe(200);
		expect(
			await organizationQuery(statement("SELECT expires_at FROM api_keys WHERE id = ?", [key.key.id], "get")),
		).toEqual({ expires_at: nearingExpiry });
		const plan = await call(`/api/org/users/${alice.user.id}/deactivate`, "POST", { mode: "keep" });
		expect(plan.status).toBe(200);
		const job = await call(`/api/org/users/${alice.user.id}/deactivate`, "POST", { mode: "keep", dryRun: false });
		expect(job.status).toBe(202);
		const revoked = await call("/api/auth/connector-keys", "GET", undefined, key.secret);
		expect(revoked.status).toBe(401);
		expect(await organizationQuery(statement("SELECT COUNT(*) AS n FROM audit_events", [], "get"))).toMatchObject({
			n: expect.any(Number),
		});
	});
	test("refresh rotation detects old refresh reuse and revokes the new access token", async () => {
		const root = await claim();
		const { issueSession } = await import("./organization-store");
		const session = await issueSession(root.user.id, "cli");
		const refreshed = await call("/api/auth/refresh", "POST", { refreshToken: session.refreshToken }, "");
		expect(refreshed.status).toBe(200);
		const current = await refreshed.json();
		const { organizationWrite } = await import("./organization-store");
		await organizationWrite([
			statement("UPDATE auth_sessions SET refresh_retry_json = '[]' WHERE id = ?", [session.sessionId]),
			statement("UPDATE audit_events SET at = ? WHERE action = 'session.refreshed' AND target_id = ?", [
				new Date(Date.now() - 61_000).toISOString(),
				session.sessionId,
			]),
		]);
		const reused = await call("/api/auth/refresh", "POST", { refreshToken: session.refreshToken }, "");
		expect(reused.status).toBe(401);
		expect(await reused.json()).toMatchObject({ reason: "refresh_reuse" });
		expect((await call("/api/auth/sessions", "GET", undefined, current.accessToken)).status).toBe(401);
	});
	test("connector request aliases and actor spoofing fail before a write", async () => {
		const root = await claim();
		const { issueSession } = await import("./organization-store");
		const { organizationWrite } = await import("./organization-store");
		await organizationWrite([
			statement("INSERT INTO devices(id,user_id,name) VALUES ('dev_a',?,'Laptop')", [root.user.id]),
		]);
		const session = await issueSession(root.user.id, "cli", "dev_a");
		const key = await (
			await call("/api/auth/connector-keys", "POST", { harness: "codex", deviceId: "dev_a" }, session.accessToken)
		).json();
		expect((await call("/write", "POST", { agentId: "other" }, key.secret)).status).toBe(403);
		expect((await call("/write", "POST", { fromAgentId: "other" }, key.secret)).status).toBe(403);
		expect(
			(
				await app.request("/write?agentId=other", {
					method: "POST",
					headers: { authorization: `Bearer ${key.secret}`, "content-type": "application/json" },
					body: JSON.stringify({ agentId: key.key.agentId }),
				})
			).status,
		).toBe(400);
		expect(
			(
				await app.request("/write", {
					method: "POST",
					headers: { authorization: `Bearer ${key.secret}`, "x-signet-actor": "spoof" },
				})
			).status,
		).toBe(403);
	});
});

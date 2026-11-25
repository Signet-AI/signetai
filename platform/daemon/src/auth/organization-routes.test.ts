import { afterEach, beforeEach, describe, expect, test, spyOn } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
	app.delete("/api/test-empty", (c) => c.json({ written: true }));
});
afterEach(async () => {
	await (await import("../db-owner-runtime")).closeDbOwner();
	await closeDbAccessor();
	rmSync(dir, { recursive: true, force: true });
	if (initialSignetPath === undefined) delete process.env.SIGNET_PATH;
	else process.env.SIGNET_PATH = initialSignetPath;
});
describe("organization HTTP flows", () => {
	test("R6 POST recalls audit the published resolved agent and result count", async () => {
		await claim();
		const { registerGlobalMiddleware } = await import("../middleware");
		const { reloadAuthState } = await import("../routes/state");
		const { flushReadAudit } = await import("./organization-runtime");
		writeFileSync(join(dir, "agent.yaml"), "auth:\n  mode: team\n");
		reloadAuthState(dir);
		const probe = new Hono();
		registerGlobalMiddleware(probe);
		probe.post("/api/memory/recall", (c) => {
			c.set("readAuditAgent", "default");
			c.set("readAuditCount", 2);
			return c.json({ results: [{ id: "one" }, { id: "two" }] });
		});
		try {
			expect(
				(
					await probe.request("/api/memory/recall", {
						method: "POST",
						headers: { authorization: `Bearer ${admin}`, "content-type": "application/json" },
						body: JSON.stringify({ query: "test" }),
					})
				).status,
			).toBe(200);
			await flushReadAudit();
			const row = await organizationQuery<{ detail_json: string }>(
				statement(
					"SELECT detail_json FROM audit_events WHERE action='content.read' AND target_id='/api/memory/recall' ORDER BY at DESC LIMIT 1",
					[],
					"get",
				),
			);
			expect(row && JSON.parse(row.detail_json)).toEqual({ agentId: "default", count: 2 });
		} finally {
			reloadAuthState(join(dir, "local-restore"));
		}
	});

	test("R5 restart recovery leaves classification jobs with their owner", async () => {
		await claim();
		const { organizationWrite } = await import("./organization-store");
		await organizationWrite([
			statement(
				"INSERT INTO org_jobs(id,kind,status) VALUES ('class-job','classification_apply','running'),('off-job','offboard','pending'),('keys-job','bulk_revoke','running')",
			),
		]);
		const { startOrganizationRuntime, stopOrganizationRuntime } = await import("./organization-runtime");
		try {
			await startOrganizationRuntime("http://127.0.0.1");
			expect(await organizationQuery(statement("SELECT id,status FROM org_jobs ORDER BY id", [], "all"))).toEqual([
				{ id: "class-job", status: "running" },
				{ id: "keys-job", status: "failed" },
				{ id: "off-job", status: "failed" },
			]);
		} finally {
			await stopOrganizationRuntime();
		}
	});
	test("R5 read audit retries cannot duplicate or poison their batch", async () => {
		await claim();
		const { auditStatement, organizationWrite } = await import("./organization-store");
		const event = auditStatement(null, "content.read", "route", "/api/memory/recall");
		await organizationWrite([event]);
		await organizationWrite([event]);
		expect(
			await organizationQuery(
				statement("SELECT COUNT(*) AS n FROM audit_events WHERE id=?", [event.params?.[0] ?? null], "get"),
			),
		).toEqual({ n: 1 });
	});
	test("R7 retention prunes expired device authorizations", async () => {
		await claim();
		const { organizationWrite } = await import("./organization-store");
		await organizationWrite([
			statement(
				"INSERT INTO device_authorizations(id,status,expires_at) VALUES ('expired-flow','pending','2000-01-01T00:00:00.000Z')",
			),
		]);
		await (await import("./organization-runtime")).pruneAudit();
		expect(
			await organizationQuery(statement("SELECT id FROM device_authorizations WHERE id='expired-flow'", [], "get")),
		).toBeNull();
	});

	test("R8 invite lookup uses a JSON token rather than a URL secret", async () => {
		await claim();
		const invite = await (await call("/api/org/invites", "POST", { role: "member", groupIds: [] })).json();
		const token = new URL(invite.inviteUrl).pathname.split("/").pop();
		expect((await call("/api/auth/invites/lookup", "POST", { token }, "")).status).toBe(200);
		expect((await call(`/api/auth/invites/${token}`, "GET", undefined, "")).status).not.toBe(200);
	});
	test("R8 request logs use the device route template not its code", async () => {
		const { logger } = await import("../logger");
		const { registerGlobalMiddleware } = await import("../middleware");
		const probe = new Hono();
		registerGlobalMiddleware(probe);
		probe.get("/api/auth/device/:userCode", (c) => c.json({ ok: true }));
		const calls = spyOn(logger.api, "request");
		try {
			expect((await probe.request("/api/auth/device/TEST-CODE")).status).toBe(200);
			expect(calls.mock.calls.at(-1)?.[1]).toBe("/api/auth/device/:userCode");
		} finally {
			calls.mockRestore();
		}
	});

	test("R7 pending device flow admission is capped", async () => {
		await claim();
		const { organizationWrite } = await import("./organization-store");
		await organizationWrite([
			statement(
				"WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<1000) INSERT INTO device_authorizations(id,status,expires_at) SELECT 'pending-'||x,'pending','2099-01-01T00:00:00.000Z' FROM n",
			),
		]);
		const response = await call(
			"/api/auth/device/start",
			"POST",
			{ client: "cli", deviceName: "Laptop", platform: "linux" },
			"",
		);
		expect(response.status).toBe(429);
		expect(
			await organizationQuery(
				statement("SELECT COUNT(*) AS n FROM device_authorizations WHERE status='pending'", [], "get"),
			),
		).toEqual({ n: 1000 });
	});

	test("R7 refresh requests are limited per peer before credential work", async () => {
		await claim();
		let response: Response | undefined;
		for (let n = 0; n < 21; n++) response = await call("/api/auth/refresh", "POST", { refreshToken: "invalid" }, "");
		expect(response?.status).toBe(429);
		expect(response?.headers.get("Retry-After")).toBeTruthy();
	});
	test("R7 limiter capacity is bounded and expired peers are evicted", async () => {
		const { AuthRateLimiter } = await import("./rate-limiter");
		const limiter = new AuthRateLimiter(1, 1);
		const now = Date.now;
		try {
			Date.now = () => 1000;
			for (let n = 0; n < 10000; n++) limiter.record(`peer-${n}`);
			expect(limiter.check("new-peer").allowed).toBe(false);
			Date.now = () => 2000;
			expect(limiter.check("new-peer").allowed).toBe(true);
		} finally {
			Date.now = now;
		}
	});

	test("R15 principal binding does not load unrelated personal agents", async () => {
		const root = await claim();
		const { organizationWrite, issueSession, verifySession, readOrganization } = await import("./organization-store");
		await organizationWrite([
			statement(
				"INSERT INTO agents(id,name,kind,owner_user_id,created_at,updated_at) VALUES ('foreign-personal','Foreign','personal','usr_foreign',datetime('now'),datetime('now'))",
			),
		]);
		const session = await issueSession(root.user.id, "cli");
		const verified = await verifySession(session.accessToken, undefined, false, await readOrganization());
		const { principalAccess } = await import("./agent-access");
		expect(principalAccess(verified.principal)?.agents.some((agent) => agent.id === "foreign-personal")).toBe(false);
	});

	test("R14 deactivation preserves prior revocation timestamps and reasons", async () => {
		await claim();
		const { organizationWrite, issueSession, id } = await import("./organization-store");
		const userId = id("usr");
		await organizationWrite([
			statement("INSERT INTO users(id,username,display_name,role) VALUES (?,'departing','Departing','member')", [
				userId,
			]),
		]);
		const session = await issueSession(userId, "cli");
		await organizationWrite([
			statement("UPDATE auth_sessions SET revoked_at='2001-01-01T00:00:00.000Z',revoked_reason='manual' WHERE id=?", [
				session.sessionId,
			]),
		]);
		expect((await call(`/api/org/users/${userId}/deactivate`, "POST", { mode: "keep", dryRun: false })).status).toBe(
			202,
		);
		expect(
			await organizationQuery(
				statement("SELECT revoked_at,revoked_reason FROM auth_sessions WHERE id=?", [session.sessionId], "get"),
			),
		).toEqual({ revoked_at: "2001-01-01T00:00:00.000Z", revoked_reason: "manual" });
	});

	test("R10 concurrent claims have a conflict loser rather than a server error", async () => {
		const payload = {
			setupToken: setup,
			organizationName: "Acme",
			admin: { username: "admin", displayName: "Admin", password: "test" },
		};
		const responses = await Promise.all([
			call("/api/org/claim", "POST", payload, ""),
			call("/api/org/claim", "POST", payload, ""),
		]);
		expect(responses.map((r) => r.status).sort()).toEqual([200, 409]);
		expect(await organizationQuery(statement("SELECT COUNT(*) AS n FROM users", [], "get"))).toEqual({ n: 1 });
	});
	test("R10 concurrent device exchanges have an unauthorized loser", async () => {
		await claim();
		const flow = await (
			await call("/api/auth/device/start", "POST", { client: "cli", deviceName: "Laptop", platform: "linux" }, "")
		).json();
		expect(
			(await call("/api/auth/device/approve", "POST", { userCode: flow.userCode, decision: "approve" })).status,
		).toBe(200);
		const responses = await Promise.all([
			call("/api/auth/device/token", "POST", { deviceCode: flow.deviceCode }, ""),
			call("/api/auth/device/token", "POST", { deviceCode: flow.deviceCode }, ""),
		]);
		expect(responses.map((r) => r.status).sort()).toEqual([200, 401]);
	});

	test("R11 a remote hybrid open request has no local principal", async () => {
		const hybrid = new Hono();
		hybrid.use("*", createIdentityMiddleware(parseAuthConfig({ mode: "hybrid" }, dir), generateSecret()));
		hybrid.get("/api/auth/methods", (c) => c.json({ principal: c.get("principal")?.kind ?? null }));
		const response = await hybrid.request(
			"/api/auth/methods",
			{},
			{ incoming: { socket: { remoteAddress: "203.0.113.12" } } },
		);
		expect(await response.json()).toEqual({ principal: null });
		const local = await hybrid.request(
			"/api/auth/methods",
			{},
			{ incoming: { socket: { remoteAddress: "127.0.0.1" } } },
		);
		expect(await local.json()).toEqual({ principal: "local" });
	});

	test("R13 secure sessions use Host prefixed root cookies", async () => {
		const response = await app.request("https://org.test/api/org/claim", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				setupToken: setup,
				organizationName: "Acme",
				admin: { username: "admin", displayName: "Admin", password: "test" },
			}),
		});
		expect(response.status).toBe(200);
		const cookies = response.headers.getSetCookie();
		expect(
			cookies.some(
				(value) => value.startsWith("__Host-signet_session=") && value.includes("Secure") && value.includes("Path=/"),
			),
		).toBe(true);
		expect(cookies.some((value) => value.startsWith("__Host-signet_csrf="))).toBe(true);
	});

	test("R12 non HTTP public URLs are rejected", async () => {
		await claim();
		expect((await call("/api/org/settings", "PATCH", { publicUrl: "javascript:alert(1)" })).status).toBe(400);
	});
	test("R12 password login cannot be disabled without OIDC", async () => {
		await claim();
		const response = await call("/api/org/settings", "PATCH", { passwordLogin: false });
		expect(response.status).toBe(409);
		expect(await response.json()).toMatchObject({ reason: "org_policy" });
	});

	test("R9 new password hashes use six hundred thousand iterations", async () => {
		const { passwordHash } = await import("./organization-store");
		expect((await passwordHash("test password")).split("$")[1]).toBe("600000");
	});
	test("R9 an unknown username still performs asynchronous password verification", async () => {
		const { verifyUserPassword } = await import("./organization-store");
		let finished = false;
		const pending = verifyUserPassword("test password", null).then((value) => {
			finished = true;
			return value;
		});
		await Promise.resolve();
		expect(finished).toBe(false);
		expect(await pending).toBe(false);
	});

	test("R4 a personal agent can commit its curated memory head", async () => {
		const root = await claim();
		const record = await organizationQuery<{ personal_agent_id: string }>(
			statement("SELECT personal_agent_id FROM users WHERE id=?", [root.user.id], "get"),
		);
		const { commitCuratedMemoryHead, readCuratedMemoryHead } = await import("../memory-head");
		const { organizationWrite } = await import("./organization-store");
		await organizationWrite([
			statement("INSERT INTO dreaming_passes(id,agent_id,mode,status) VALUES (?,?, 'incremental-content','running')", [
				"personal-head-test",
				record.personal_agent_id,
			]),
			statement(
				"INSERT INTO memories(id,content,agent_id,memory_kind,type,visibility,created_at,updated_at,author_user_id) VALUES ('head-evidence','Personal head evidence',?,'episodic','fact','private',datetime('now'),datetime('now'),?)",
				[record.personal_agent_id, root.user.id],
			),
		]);
		await readCuratedMemoryHead(record.personal_agent_id);
		const result = await commitCuratedMemoryHead({
			agentId: record.personal_agent_id,
			passId: "personal-head-test",
			entries: [
				{
					entryId: "personal-entry",
					text: "Personal head evidence",
					support: [{ source_ref: "memory:head-evidence", quote: "Personal head evidence" }],
				},
			],
		});
		expect(result).toMatchObject({ ok: true });
		expect(record.personal_agent_id).toMatch(/^personal-[a-f0-9]{32}$/);
	});

	test("R1 text plain claim cannot bypass the JSON boundary", async () => {
		const response = await app.request("/api/org/claim", {
			method: "POST",
			headers: { "content-type": "text/plain" },
			body: JSON.stringify({
				setupToken: setup,
				organizationName: "Acme",
				admin: { username: "admin", displayName: "Admin", password: "test password" },
			}),
		});
		expect(response.status).toBe(415);
		expect(await response.json()).toMatchObject({ reason: "unsupported_media_type" });
		expect(await organizationQuery(statement("SELECT COUNT(*) AS n FROM users", [], "get"))).toEqual({ n: 0 });
	});
	test("R1 foreign Origin cannot claim an organization", async () => {
		const response = await app.request("/api/org/claim", {
			method: "POST",
			headers: { "content-type": "application/json", origin: "https://attacker.invalid" },
			body: JSON.stringify({
				setupToken: setup,
				organizationName: "Acme",
				admin: { username: "admin", displayName: "Admin", password: "test password" },
			}),
		});
		expect(response.status).toBe(403);
		expect(await organizationQuery(statement("SELECT COUNT(*) AS n FROM users", [], "get"))).toEqual({ n: 0 });
	});
	test("R1 an empty JSON mutation body is accepted", async () => {
		await claim();
		expect((await call("/api/test-empty", "DELETE")).status).toBe(200);
	});

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
	test("R14 transfer preserves authorship and reactivation restores writing", async () => {
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
				[`personal-${departing.user.id.slice(4)}`, "original-session", new Date().toISOString(), departing.user.id],
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
				statement("SELECT owner_user_id FROM agents WHERE id = ?", [`personal-${departing.user.id.slice(4)}`], "get"),
			),
		).toEqual({ owner_user_id: root.user.id });
		expect((await call(`/api/org/users/${departing.user.id}/reactivate`, "POST", {})).status).toBe(200);
		const { issueSession } = await import("./organization-store");
		const restored = await issueSession(departing.user.id, "cli");
		expect((await call("/write", "POST", {}, restored.accessToken)).status).toBe(200);
		const current = await organizationQuery<{ personal_agent_id: string }>(
			statement("SELECT personal_agent_id FROM users WHERE id=?", [departing.user.id], "get"),
		);
		expect(current.personal_agent_id).not.toBe(`personal-${departing.user.id.slice(4)}`);
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
				["purge-derived", root.user.id],
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
					agentId: `personal-${owner.slice(4)}`,
					createdAt: new Date().toISOString(),
					author: { userId: owner, credential: "session:fixture" },
				});
		});
		await organizationWrite([
			statement(
				"INSERT INTO session_transcripts (agent_id,session_key,content,harness,created_at,speaker_user_id) VALUES (?,?,'User: disposable test','test',?,?)",
				[`personal-${departing.user.id.slice(4)}`, "departing-session", new Date().toISOString(), departing.user.id],
			),
		]);
		await organizationWrite([
			statement(
				"INSERT INTO derived_memory_sources (agent_id,derived_memory_id,source_kind,source_id,created_at) VALUES (?,'purge-derived','memory','purge-target',?)",
				[`personal-${root.user.id.slice(4)}`, new Date().toISOString()],
			),
			statement(
				"INSERT INTO documents (id,source_type,raw_content,created_at,updated_at,author_user_id) VALUES ('purge-doc','text','private',?,?,?)",
				[new Date().toISOString(), new Date().toISOString(), departing.user.id],
			),
			statement(
				"INSERT INTO memory_artifacts (agent_id,source_path,source_sha256,source_kind,session_id,session_token,captured_at,updated_at,author_user_id) VALUES (?,'purge-artifact','hash','summary','unbound','unbound',?,?,?)",
				[
					`personal-${departing.user.id.slice(4)}`,
					new Date().toISOString(),
					new Date().toISOString(),
					departing.user.id,
				],
			),
			statement(
				"INSERT INTO session_claims (agent_id,session_key,claimed_at,expires_at) VALUES (?,'departing-session',?,?)",
				[
					`personal-${departing.user.id.slice(4)}`,
					new Date().toISOString(),
					new Date(Date.now() + 60000).toISOString(),
				],
			),
		]);
		await organizationWrite([
			statement(
				"INSERT INTO session_summaries (id,kind,content,earliest_at,latest_at,created_at,agent_id) VALUES ('purge-dag','session','private',?,?,?,?),('purge-parent','arc','private',?,?,?,?)",
				[
					new Date().toISOString(),
					new Date().toISOString(),
					new Date().toISOString(),
					`personal-${departing.user.id.slice(4)}`,
					new Date().toISOString(),
					new Date().toISOString(),
					new Date().toISOString(),
					`personal-${departing.user.id.slice(4)}`,
				],
			),
			statement(
				"INSERT INTO session_summary_memories (summary_id,memory_id) VALUES ('purge-dag','purge-target'),('purge-dag','keep-other')",
				[],
			),
			statement(
				"INSERT INTO session_summary_children (parent_id,child_id,ordinal) VALUES ('purge-parent','purge-dag',0)",
				[],
			),
		]);
		await organizationWrite([
			statement(
				"INSERT INTO session_summaries(id,kind,content,earliest_at,latest_at,created_at,agent_id,session_key) VALUES ('transcript-owned-summary','session','private',?,?,?,?,'departing-session')",
				[
					new Date().toISOString(),
					new Date().toISOString(),
					new Date().toISOString(),
					`personal-${departing.user.id.slice(4)}`,
				],
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
			await organizationQuery(
				statement("SELECT COUNT(*) AS n FROM session_summaries WHERE id IN ('purge-dag','purge-parent')", [], "get"),
			),
		).toEqual({ n: 0 });
		expect(await organizationQuery(statement("SELECT id FROM documents WHERE id='purge-doc'", [], "get"))).toBeNull();
		expect(
			await organizationQuery(
				statement("SELECT source_path FROM memory_artifacts WHERE source_path='purge-artifact'", [], "get"),
			),
		).toBeNull();
		const progress = JSON.parse(status.progress_json);
		expect(progress.removed.session_summaries).toBe(3);
		expect(progress.residual).toBeDefined();
		expect(Object.values(progress.residual).every((n) => n === 0)).toBe(true);

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
		).toEqual(expect.arrayContaining([{ target_id: "purge-target" }, { target_id: "purge-derived" }]));
	});
	test.each([true, false])(
		"R3 pinned evidence reports incomplete and residual instead of success (authored=%s)",
		async (owned: boolean) => {
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
					["purge-derived", root.user.id],
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
						pinned: memoryId === "purge-target" ? 1 : 0,
						sourceType: !owned && memoryId === "purge-target" ? "session" : "manual",
						sourceId: !owned && memoryId === "purge-target" ? "departing-session" : null,
						agentId: `personal-${owner.slice(4)}`,
						createdAt: new Date().toISOString(),
						author: { userId: !owned && memoryId === "purge-target" ? null : owner, credential: "system" },
					});
			});
			await organizationWrite([
				statement(
					"INSERT INTO session_transcripts (agent_id,session_key,content,harness,created_at,speaker_user_id) VALUES (?,?,'User: disposable test','test',?,?)",
					[`personal-${departing.user.id.slice(4)}`, "departing-session", new Date().toISOString(), departing.user.id],
				),
			]);
			await organizationWrite([
				statement(
					"INSERT INTO derived_memory_sources (agent_id,derived_memory_id,source_kind,source_id,created_at) VALUES (?,'purge-derived','memory','purge-target',?)",
					[`personal-${root.user.id.slice(4)}`, new Date().toISOString()],
				),
				statement(
					"INSERT INTO documents (id,source_type,raw_content,created_at,updated_at,author_user_id) VALUES ('purge-doc','text','private',?,?,?)",
					[new Date().toISOString(), new Date().toISOString(), departing.user.id],
				),
				statement(
					"INSERT INTO memory_artifacts (agent_id,source_path,source_sha256,source_kind,session_id,session_token,captured_at,updated_at,author_user_id) VALUES (?,'purge-artifact','hash','summary','unbound','unbound',?,?,?)",
					[
						`personal-${departing.user.id.slice(4)}`,
						new Date().toISOString(),
						new Date().toISOString(),
						departing.user.id,
					],
				),
				statement(
					"INSERT INTO session_claims (agent_id,session_key,claimed_at,expires_at) VALUES (?,'departing-session',?,?)",
					[
						`personal-${departing.user.id.slice(4)}`,
						new Date().toISOString(),
						new Date(Date.now() + 60000).toISOString(),
					],
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
			expect(status.status).toBe("incomplete");
			expect(JSON.parse(status.progress_json).residual.memories).toBe(1);
			expect(JSON.parse(status.progress_json).removed.retainedPinned).toBeUndefined();
		},
	);
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
				await call(
					"/write",
					"POST",
					{ sessionKey: `agent:personal-${root.user.id}:main`, fromSessionKey: "agent:other:main" },
					key.secret,
				)
			).status,
		).toBe(400);
		expect((await call("/write?scope=all", "POST", {}, key.secret)).status).toBe(403);
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

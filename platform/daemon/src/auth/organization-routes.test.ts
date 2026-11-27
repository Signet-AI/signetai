import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { closeDbAccessor, initDbAccessor } from "../db-accessor";
import { registerOrganizationRoutes } from "../routes/organization-routes";
import { parseAuthConfig } from "./config";
import { createIdentityMiddleware } from "./identity-middleware";
import { ensureSetupToken, organizationQuery, statement } from "./organization-store";
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
async function member(username: string) {
	const invite = await (await call("/api/org/invites", "POST", { role: "member", groupIds: [] })).json();
	const accepted = await call(
		"/api/auth/invites/accept",
		"POST",
		{
			token: new URL(invite.inviteUrl).pathname.split("/").pop(),
			username,
			displayName: username,
			password: "test password",
		},
		"",
	);
	expect(accepted.status).toBe(200);
	const token =
		accepted.headers
			.getSetCookie()
			.find((value) => value.startsWith("signet_session="))
			?.split(";")[0]
			?.slice("signet_session=".length) ?? "";
	const identity = await (await call("/api/auth/whoami", "GET", undefined, token)).json();
	return { token, userId: identity.user.id, agentId: identity.agents.defaultWrite };
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
	test("L2 handoff previews identity without replacing an existing session until confirmation", async () => {
		await claim();
		const bob = await member("handoff-bob");
		const handoff = await (await call("/api/auth/handoff", "POST", {})).json();
		const preview = await call("/api/auth/handoff/redeem", "POST", { code: handoff.code }, bob.token);
		expect(preview.status).toBe(200);
		expect(preview.headers.getSetCookie()).toEqual([]);
		expect(await preview.json()).toMatchObject({
			confirmationRequired: true,
			user: { displayName: "Admin" },
			organization: { name: "Acme" },
		});
		expect((await (await call("/api/auth/whoami", "GET", undefined, bob.token)).json()).user.id).toBe(bob.userId);
		const confirmed = await call("/api/auth/handoff/redeem", "POST", { code: handoff.code, confirm: true }, bob.token);
		expect(confirmed.status).toBe(200);
		expect(confirmed.headers.getSetCookie().some((value) => value.startsWith("signet_session="))).toBe(true);
		expect((await confirmed.json()).user.displayName).toBe("Admin");
	});

	test.each(["principal", "global"])("L3 key exchange enforces the %s active-session cap", async (scope) => {
		const root = await claim();
		const other = scope === "global" ? await member("exchange-other") : { userId: root.user.id, token: admin };
		const expiresAt = new Date(Date.now() + 300_000).toISOString();
		const makeKey = async (bearer: string) =>
			(
				await call("/api/auth/api-keys", "POST", { name: "exchange", permissions: ["recall"], expiresAt }, bearer)
			).json();
		const seeded = await makeKey(other.token);
		const target = await makeKey(admin);
		const { organizationWrite } = await import("./organization-store");
		const ceiling = JSON.stringify({ permissions: ["recall"], agentId: null, projects: null, expiresAt });
		await organizationWrite([
			statement(
				"WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<?) INSERT INTO auth_sessions(id,user_id,kind,token_hash,access_expires_at,source_key_id,source_key_ceiling_json) SELECT 'cap-'||x,?,'browser','hash',?,?,? FROM n",
				[scope === "global" ? 1000 : 20, other.userId, expiresAt, seeded.key.id, ceiling],
			),
		]);
		const denied = await call("/api/auth/session", "POST", {}, target.secret);
		expect(denied.status).toBe(429);
		expect(Number(denied.headers.get("Retry-After"))).toBeGreaterThan(0);
		await organizationWrite([statement("UPDATE auth_sessions SET revoked_at='released' WHERE id LIKE 'cap-%'")]);
		expect((await call("/api/auth/session", "POST", {}, target.secret)).status).toBe(200);
	});
	test("L3 handoff caps apply across a user's sessions with Retry-After", async () => {
		const root = await claim();
		const { issueSession } = await import("./organization-store");
		for (let sessionIndex = 0; sessionIndex < 4; sessionIndex++) {
			const session = await issueSession(root.user.id, "cli");
			for (let i = 0; i < 5; i++)
				expect((await call("/api/auth/handoff", "POST", {}, session.accessToken)).status).toBe(200);
		}
		const denied = await call("/api/auth/handoff", "POST", {});
		expect(denied.status).toBe(429);
		expect(Number(denied.headers.get("Retry-After"))).toBeGreaterThan(0);
	});

	test("M2 admin session-management keys may sign out all sessions", async () => {
		await claim();
		const key = await (
			await call("/api/auth/api-keys", "POST", {
				name: "session manager",
				permissions: ["admin"],
				expiresAt: new Date(Date.now() + 300_000).toISOString(),
			})
		).json();
		expect((await call("/api/auth/logout", "POST", { all: true }, key.secret)).status).toBe(200);
		expect((await (await call("/api/auth/whoami")).json()).authenticated).toBe(false);
	});
	test.each(["key", "derived"])("M2 recall-only %s cannot sign out other sessions", async (kind) => {
		await claim();
		const key = await (
			await call("/api/auth/api-keys", "POST", {
				name: "recall",
				permissions: ["recall"],
				expiresAt: new Date(Date.now() + 300_000).toISOString(),
			})
		).json();
		const exchange = await call("/api/auth/session", "POST", {}, key.secret);
		const body = await exchange.json();
		const cookie = exchange.headers
			.getSetCookie()
			.map((value) => value.split(";")[0])
			.join("; ");
		const logout = (all: boolean) =>
			kind === "key"
				? call("/api/auth/logout", "POST", { all }, key.secret)
				: app.request("/api/auth/logout", {
						method: "POST",
						headers: { cookie, "content-type": "application/json", "x-signet-csrf": body.csrf },
						body: JSON.stringify({ all }),
					});
		expect((await logout(true)).status).toBe(403);
		expect((await (await call("/api/auth/whoami")).json()).authenticated).toBe(true);
		expect((await logout(false)).status).toBe(200);
		expect((await (await call("/api/auth/whoami")).json()).authenticated).toBe(true);
	});

	test.each(["long", "equal"])("B2 child expiry and descendant revocation: %s", async (expiry) => {
		await claim();
		const expiresAt = new Date(Date.now() + 300_000).toISOString();
		const parent = await (
			await call("/api/auth/api-keys", "POST", { name: "parent", permissions: ["recall"], expiresAt })
		).json();
		const childResponse = await call(
			"/api/auth/api-keys",
			"POST",
			{
				name: "child",
				permissions: ["recall"],
				expiresAt: expiry === "long" ? new Date(Date.now() + 86400_000).toISOString() : expiresAt,
			},
			parent.secret,
		);
		expect(childResponse.status).toBe(201);
		const child = await childResponse.json();
		expect(child.key.expiresAt).toBe(expiresAt);
		expect(
			(await call("/api/auth/api-keys", "POST", { name: "widen", permissions: ["admin"], expiresAt }, parent.secret))
				.status,
		).toBe(403);
		const grandchild = await (
			await call("/api/auth/api-keys", "POST", { name: "grandchild", permissions: ["recall"], expiresAt }, child.secret)
		).json();
		expect((await call("/api/auth/api-keys/" + parent.key.id, "DELETE")).status).toBe(200);
		for (const key of [parent, child, grandchild]) {
			expect((await (await call("/api/auth/whoami", "GET", undefined, key.secret)).json()).authenticated).toBe(false);
			expect(
				await organizationQuery(
					statement("SELECT revoked_at IS NOT NULL AS revoked FROM api_keys WHERE id=?", [key.key.id], "get"),
				),
			).toEqual({ revoked: 1 });
		}
	});
	test.each(["revoked", "expired"])("B2 requests validate the live key ancestor: %s", async (reason) => {
		await claim();
		const expiresAt = new Date(Date.now() + 300_000).toISOString();
		const parent = await (
			await call("/api/auth/api-keys", "POST", { name: "parent", permissions: ["recall"], expiresAt })
		).json();
		const child = await (
			await call("/api/auth/api-keys", "POST", { name: "child", permissions: ["recall"], expiresAt }, parent.secret)
		).json();
		const exchanged = await call("/api/auth/session", "POST", {}, child.secret);
		expect(exchanged.status).toBe(200);
		const cookie = exchanged.headers
			.getSetCookie()
			.map((value) => value.split(";")[0])
			.join("; ");
		const { organizationWrite } = await import("./organization-store");
		await organizationWrite([
			statement(
				reason === "revoked"
					? "UPDATE api_keys SET revoked_at=? WHERE id=?"
					: "UPDATE api_keys SET expires_at=? WHERE id=?",
				["2000-01-01T00:00:00.000Z", parent.key.id],
			),
		]);
		expect((await (await call("/api/auth/whoami", "GET", undefined, child.secret)).json()).authenticated).toBe(false);
		expect((await (await app.request("/api/auth/whoami", { headers: { cookie } })).json()).authenticated).toBe(false);
	});
	test("B1 bearer keys cannot approve device authorizations", async () => {
		await claim();
		const key = await (
			await call("/api/auth/api-keys", "POST", {
				name: "recall only",
				permissions: ["recall"],
				expiresAt: new Date(Date.now() + 300_000).toISOString(),
			})
		).json();
		const flow = await (await call("/api/auth/device/start", "POST", { client: "cli", deviceName: "evil" }, "")).json();
		expect(
			(await call("/api/auth/device/approve", "POST", { userCode: flow.userCode, decision: "approve" }, key.secret))
				.status,
		).toBe(403);
		expect((await call("/api/auth/device/token", "POST", { deviceCode: flow.deviceCode }, "")).status).toBe(428);
	});
	test("B1 device sessions retain the approving session permission ceiling through refresh", async () => {
		await claim();
		const bob = await member("ceiling-bob");
		const before = await (await call("/api/auth/whoami", "GET", undefined, bob.token)).json();
		const flow = await (
			await call("/api/auth/device/start", "POST", { client: "cli", deviceName: "Laptop" }, "")
		).json();
		expect(
			(await call("/api/auth/device/approve", "POST", { userCode: flow.userCode, decision: "approve" }, bob.token))
				.status,
		).toBe(200);
		await call(`/api/org/users/${bob.userId}`, "PATCH", { role: "admin" });
		const login = await (await call("/api/auth/device/token", "POST", { deviceCode: flow.deviceCode }, "")).json();
		expect((await (await call("/api/auth/whoami", "GET", undefined, login.accessToken)).json()).permissions).toEqual(
			before.permissions,
		);
		const refreshed = await (await call("/api/auth/refresh", "POST", { refreshToken: login.refreshToken }, "")).json();
		expect(
			(await (await call("/api/auth/whoami", "GET", undefined, refreshed.accessToken)).json()).permissions,
		).toEqual(before.permissions);
	});

	test("SSO configuration refuses narrowed authority before secret access and never publishes missing secrets", async () => {
		await claim();
		const alice = await member("sso-alice");
		const identity = await (await call("/api/auth/whoami")).json();
		const input = { issuer: "https://idp.example", clientId: "fixture-client", clientSecretRef: "MISSING_SSO_FIXTURE" };
		expect((await call("/api/org/sso", "POST", input, alice.token)).status).toBe(403);
		const key = await (
			await call("/api/auth/api-keys", "POST", {
				name: "scoped SSO",
				agentId: identity.agents.defaultWrite,
				permissions: ["admin"],
				expiresAt: new Date(Date.now() + 60_000).toISOString(),
			})
		).json();
		expect(typeof key.secret).toBe("string");
		expect((await call("/api/org/sso", "POST", input, key.secret)).status).toBe(403);
		const before = await (await call("/api/org/settings")).json();
		expect((await call("/api/org/sso", "POST", { ...input, clientSecret: "fixture-secret" })).status).toBe(400);
		expect((await call("/api/org/sso", "POST", input)).status).toBe(503);
		expect(await (await call("/api/org/settings")).json()).toEqual(before);
	});

	test("agent purge is an audited owner job and refuses narrowed credentials", async () => {
		await claim();
		const alice = await member("purge-alice");
		const group = await (await call("/api/org/groups", "POST", { name: "purge-team" })).json();
		const agent = await (
			await call("/api/agents", "POST", { name: "purge-target", kind: "team", ownerGroupId: group.id })
		).json();
		expect(typeof agent.agentId).toBe("string");
		expect((await call(`/api/org/agents/${agent.agentId}/purge`, "POST", {}, alice.token)).status).toBe(403);
		expect((await call(`/api/org/agents/${agent.agentId}/purge`, "POST", {})).status).toBe(409);
		const key = await (
			await call("/api/auth/api-keys", "POST", {
				name: "narrow purge",
				kind: "shared",
				agentId: agent.agentId,
				permissions: ["admin"],
				expiresAt: new Date(Date.now() + 60_000).toISOString(),
			})
		).json();
		expect(typeof key.secret).toBe("string");
		expect((await call(`/api/org/agents/${agent.agentId}/purge`, "POST", {}, key.secret)).status).toBe(403);
		expect((await call("/api/org/agents/default/purge", "POST", {})).status).toBe(409);
		expect((await call(`/api/agents/${agent.agentId}`, "PATCH", { archived: true })).status).toBe(200);
		const result = await call(`/api/org/agents/${agent.agentId}/purge`, "POST", {});
		expect(result.status).toBe(202);
		const started = await result.json();
		let job: { status: string } = { status: "running" };
		for (let i = 0; i < 100; i++) {
			job = await (await call(`/api/org/jobs/${started.jobId}`)).json();
			if (job.status !== "running") break;
			await Bun.sleep(20);
		}
		expect(job.status).toBe("complete");
		expect(
			(await (await call("/api/agents")).json()).agents.some((row: { id: string }) => row.id === agent.agentId),
		).toBe(false);
		const events = (await (await call("/api/org/audit?action=agent.created")).json()).events;
		expect(events.some((row: { target_id: string }) => row.target_id === agent.agentId)).toBe(true);
		expect((await (await call("/api/org/audit?action=agent.purged")).json()).events.length).toBe(1);
	});

	test("host bootstrap requires the setup nonce and preserves the checked public URL", async () => {
		expect((await (await call("/api/auth/methods")).json()).organization.claimed).toBe(false);
		const bad = await call(
			"/api/org/bootstrap",
			"POST",
			{ setupToken: "invalid-fixture-token-123456", publicUrl: "https://org.example" },
			"",
		);
		expect(bad.status).toBe(401);
		const good = await call("/api/org/bootstrap", "POST", { setupToken: setup, publicUrl: "https://org.example" }, "");
		expect(good.status).toBe(200);
		await claim();
		expect((await (await call("/api/org/settings")).json()).publicUrl).toBe("https://org.example");
		expect(
			(await call("/api/org/bootstrap", "POST", { setupToken: setup, publicUrl: "https://other.example" }, "")).status,
		).toBe(409);
	});
	test("organization doctor requires diagnostics and reports an explicit server clock", async () => {
		await claim();
		const bob = await member("doctor-member");
		expect((await call("/api/org/operator/doctor", "GET", undefined, bob.token)).status).toBe(403);
		const response = await call("/api/org/operator/doctor");
		expect(response.status).toBe(200);
		const result = await response.json();
		expect(result.identity.user.username).toBe("admin");
		expect(Number.isFinite(Date.parse(result.serverTime))).toBe(true);
		expect(result.diagnostics.database).toBe("ready");
		expect(result.diagnostics.content).toBe("unavailable");
	});
	test("restart without a verified supervisor refuses without stopping", async () => {
		await claim();
		const bob = await member("restart-member");
		expect((await call("/api/org/operator/restart", "POST", {}, bob.token)).status).toBe(403);
		expect((await call("/api/org/operator/restart", "POST", {})).status).toBe(409);
		expect((await (await call("/api/org/operator/capabilities")).json()).supervisor).toBeNull();
		expect((await call("/api/auth/whoami")).status).toBe(200);
	});
	test("operator repairs are durable scoped jobs rather than unscoped dispatch", async () => {
		const { registerClassificationRoutes } = await import("../routes/classification-routes");
		registerClassificationRoutes(app);
		await claim();
		const bob = await member("repair-owner");
		const who = await (await call("/api/auth/whoami")).json();
		const myAgent = who.agents.defaultWrite;
		writeFileSync(join(dir, "agent.yaml"), "auth:\n  mode: team\n");
		const { organizationWrite } = await import("./organization-store");
		await organizationWrite([
			statement(
				"INSERT INTO memories(id,agent_id,content,type,memory_kind,created_at,updated_at) VALUES('operator-memory',?,'repair source','fact','episodic','2020','2020')",
				[myAgent],
			),
			statement(
				"INSERT INTO memory_jobs(id,memory_id,job_type,status,created_at,updated_at) VALUES('operator-dead','operator-memory','hints','dead','2020','2020')",
				[],
			),
		]);
		expect(
			(
				await call(
					"/api/org/operator/jobs",
					"POST",
					{ action: "queue.requeue", agentId: myAgent, options: { dryRun: false } },
					bob.token,
				)
			).status,
		).toBe(403);
		await call(`/api/org/users/${bob.userId}`, "PATCH", { role: "admin", compliance: true });
		const label = await (
			await call(
				"/api/classifications",
				"POST",
				{ name: "Repair HR", audience: [{ kind: "user", id: bob.userId }] },
				bob.token,
			)
		).json();
		await organizationWrite([
			statement("INSERT INTO compartments(key) VALUES(?)", [label.id]),
			statement(
				"INSERT INTO compartment_members(compartment_id,classification_id) SELECT id,? FROM compartments WHERE key=?",
				[label.id, label.id],
			),
			statement(
				"INSERT INTO memories(id,agent_id,content,type,memory_kind,compartment_id,created_at,updated_at) SELECT 'operator-hidden',?,'hidden repair source','fact','episodic',id,'2020','2020' FROM compartments WHERE key=?",
				[myAgent, label.id],
			),
			statement(
				"INSERT INTO memory_jobs(id,memory_id,job_type,status,created_at,updated_at) VALUES('operator-hidden-dead','operator-hidden','hints','dead','2020','2020')",
				[],
			),
		]);
		const started = await call("/api/org/operator/jobs", "POST", {
			action: "queue.requeue",
			agentId: myAgent,
			options: { dryRun: false },
		});
		expect(started.status).toBe(202);
		const job = await started.json();
		const state = await (await call(`/api/org/jobs/${job.jobId}`)).json();
		expect(state.status).toBe("complete");
		expect(JSON.parse(state.progress_json).affected).toBe(1);
		expect(
			await organizationQuery(statement("SELECT status FROM memory_jobs WHERE id='operator-dead'", [], "get")),
		).toEqual({ status: "pending" });
		const audit = await call("/api/org/operator/jobs", "POST", { action: "embed.audit", agentId: myAgent });
		expect(audit.status).toBe(202);
		const auditJob = await audit.json();
		const auditState = await (await call(`/api/org/jobs/${auditJob.jobId}`)).json();
		expect(auditState.status).toBe("complete");
		expect(JSON.parse(auditState.progress_json).total).toBe(1);
		expect(
			await organizationQuery(statement("SELECT status FROM memory_jobs WHERE id='operator-hidden-dead'", [], "get")),
		).toEqual({ status: "dead" });
		const backfill = await (
			await call("/api/org/operator/jobs", "POST", {
				action: "embed.backfill",
				agentId: myAgent,
				options: { dryRun: true },
			})
		).json();
		const preview = await (await call(`/api/org/jobs/${backfill.jobId}`)).json();
		expect(preview.status).toBe("complete");
		expect(JSON.parse(preview.progress_json)).toMatchObject({
			total: 1,
			missing: 1,
			selected: 1,
			affected: 0,
			dryRun: true,
		});
		const log = await (await call("/api/org/audit?action=operator.job_completed")).json();
		expect(JSON.stringify(log)).toContain(job.jobId);
		const other = await (await call("/api/agents", "POST", { name: "Restricted operator", kind: "personal" })).json();
		const key = await (
			await call("/api/auth/api-keys", "POST", {
				name: "bound-operator",
				agentId: other.agentId,
				permissions: ["admin", "diagnostics"],
				expiresAt: new Date(Date.now() + 60_000).toISOString(),
			})
		).json();
		expect(
			(await call("/api/org/operator/jobs", "POST", { action: "queue.requeue", agentId: myAgent }, key.secret)).status,
		).toBe(403);
		expect((await call(`/api/org/jobs/${job.jobId}`, "GET", undefined, key.secret)).status).toBe(404);
	});
	test("classified transcript material includes source IDs only inside read scope", async () => {
		const { registerClassificationRoutes } = await import("../routes/classification-routes");
		registerClassificationRoutes(app);
		await claim();
		const bob = await member("import-reviewer");
		await call(`/api/org/users/${bob.userId}`, "PATCH", { role: "admin", compliance: true });
		const label = await (
			await call(
				"/api/classifications",
				"POST",
				{ name: "Imported HR", audience: [{ kind: "user", id: bob.userId }] },
				bob.token,
			)
		).json();
		const { organizationWrite } = await import("./organization-store");
		await organizationWrite([
			statement("INSERT INTO compartments(key) VALUES(?)", [label.id]),
			statement(
				"INSERT INTO compartment_members(compartment_id,classification_id) SELECT id,? FROM compartments WHERE key=?",
				[label.id, label.id],
			),
			statement(
				"INSERT INTO session_transcripts(agent_id,session_key,source_id,content,harness,project,compartment_id,created_at) SELECT ?,'imported-session','imported-source','classified transcript','codex','review',id,'2026-11-26' FROM compartments WHERE key=?",
				[bob.agentId, label.id],
			),
			statement(
				"INSERT INTO classification_assignments(target_kind,target_id,agent_id,classification_id,applied_by,applied_at) VALUES('source','imported-source',?,?,?,'2026-11-26')",
				[bob.agentId, label.id, bob.userId],
			),
		]);
		const path = `/api/classifications/${label.id}/items`;
		const result = await (await call(path, "GET", undefined, bob.token)).json();
		expect(result.items).toContainEqual({ target_kind: "source", target_id: "imported-source", agent_id: bob.agentId });
		expect((await call(path)).status).toBe(404);
		const otherAgent = await (
			await call("/api/agents", "POST", { name: "Outside import scope", kind: "personal" }, bob.token)
		).json();
		for (const limits of [{ agentId: otherAgent.agentId }, { allowedProjects: ["unrelated"] }]) {
			const key = await (
				await call(
					"/api/auth/api-keys",
					"POST",
					{
						name: "restricted-import-review",
						permissions: ["recall"],
						expiresAt: new Date(Date.now() + 60_000).toISOString(),
						...limits,
					},
					bob.token,
				)
			).json();
			const denied = await call(path, "GET", undefined, key.secret);
			expect(denied.status).toBe(200);
			expect((await denied.json()).items).toEqual([]);
		}
	});
	test("Dreaming review metadata follows pass audience and agent scope", async () => {
		const { registerPipelineRoutes } = await import("../routes/pipeline-routes");
		const { registerClassificationRoutes } = await import("../routes/classification-routes");
		registerPipelineRoutes(app);
		registerClassificationRoutes(app);
		await claim();
		const bob = await member("dream-reviewer");
		await call(`/api/org/users/${bob.userId}`, "PATCH", { role: "admin", compliance: true });
		const team = await (await call("/api/org/groups", "POST", { name: "Dream review" })).json();
		await call(`/api/org/groups/${team.id}/members/${bob.userId}`, "PUT", { role: "member" });
		const agent = await (
			await call("/api/agents", "POST", { name: "Dream team", kind: "team", ownerGroupId: team.id })
		).json();
		const label = await (
			await call(
				"/api/classifications",
				"POST",
				{ name: "Dream HR", audience: [{ kind: "user", id: bob.userId }] },
				bob.token,
			)
		).json();
		const { organizationWrite } = await import("./organization-store");
		await organizationWrite([
			statement(
				"INSERT INTO dreaming_passes(id,agent_id,mode,status,started_at,created_at) VALUES('review-dream-public',?,'content','running','2026-11-26','2026-11-26')",
				[agent.agentId],
			),
			statement("INSERT INTO compartments(key) VALUES(?)", [label.id]),
			statement(
				"INSERT INTO compartment_members(compartment_id,classification_id) SELECT id,? FROM compartments WHERE key=?",
				[label.id, label.id],
			),
		]);
		const path = `/api/dream/status?agentId=${agent.agentId}`;
		const before = await (await call(path)).json();
		expect(before.passes[0].author).toEqual({ kind: "system", name: "Dreaming" });
		expect(before.passes[0].team).toEqual({ id: team.id, name: "Dream review" });
		expect(before.passes[0]).not.toHaveProperty("classifications");
		await organizationWrite([
			statement(
				"INSERT INTO dreaming_passes(id,agent_id,compartment_id,mode,status,started_at,created_at) SELECT 'review-dream-hr',?,id,'content','running','2026-11-26','2026-11-26' FROM compartments WHERE key=?",
				[agent.agentId, label.id],
			),
		]);
		expect(await (await call(path)).json()).toEqual(before);
		const allowedResponse = await call(path, "GET", undefined, bob.token);
		expect(allowedResponse.status, await allowedResponse.clone().text()).toBe(200);
		const allowed = await allowedResponse.json();
		expect(allowed.passes.find((pass: { id: string }) => pass.id === "review-dream-hr").classifications).toEqual([
			{ id: label.id, name: "Dream HR" },
		]);
		const active = await (
			await call(`/api/dream/passes/active?agentId=${agent.agentId}`, "GET", undefined, bob.token)
		).json();
		expect(active.items.find((pass: { id: string }) => pass.id === "review-dream-hr").classifications).toEqual([
			{ id: label.id, name: "Dream HR" },
		]);
		const key = await (
			await call(
				"/api/auth/api-keys",
				"POST",
				{
					name: "bound-dream-review",
					agentId: bob.agentId,
					permissions: ["recall"],
					expiresAt: new Date(Date.now() + 60_000).toISOString(),
				},
				bob.token,
			)
		).json();
		expect((await call(path, "GET", undefined, key.secret)).status).toBe(403);
	});
	test("memory review filters and totals stay inside audience and agent scope", async () => {
		const { registerMemoryRoutes } = await import("../routes/memory-routes");
		const { registerClassificationRoutes } = await import("../routes/classification-routes");
		registerMemoryRoutes(app);
		registerClassificationRoutes(app);
		await claim();
		const bob = await member("bob");
		await call(`/api/org/users/${bob.userId}`, "PATCH", { compliance: true });
		const team = await (await call("/api/org/groups", "POST", { name: "Review" })).json();
		await call(`/api/org/groups/${team.id}/members/${bob.userId}`, "PUT", { role: "member" });
		const agent = await (
			await call("/api/agents", "POST", { name: "Review agent", kind: "team", ownerGroupId: team.id })
		).json();
		const { organizationWrite } = await import("./organization-store");
		for (const id of ["review-public", "review-hr"])
			await organizationWrite([
				statement(
					"INSERT INTO memories(id,content,agent_id,author_user_id,memory_kind,type,created_at,updated_at) VALUES (?, 'review evidence',?,?,'episodic','fact',datetime('now'),datetime('now'))",
					[id, agent.agentId, bob.userId],
				),
			]);
		const label = await (
			await call(
				"/api/classifications",
				"POST",
				{
					name: "HR review",
					audience: [{ kind: "user", id: bob.userId }],
					appliers: [{ kind: "user", id: bob.userId }],
				},
				bob.token,
			)
		).json();
		expect(
			(
				await call(
					`/api/classifications/${label.id}/apply?wait=1`,
					"POST",
					{ target: { kind: "memory", id: "review-hr", agentId: agent.agentId } },
					bob.token,
				)
			).status,
		).toBe(202);
		const path = `/api/memories?agentId=${agent.agentId}&author=${bob.userId}&team=${team.id}`;
		const publicView = await (await call(path)).json();
		expect(publicView.stats.total).toBe(1);
		expect(publicView.memories.map((m: { id: string }) => m.id)).toEqual(["review-public"]);
		expect(publicView.memories[0]).not.toHaveProperty("classifications");
		expect((await (await call(`${path}&classification=${label.id}`)).json()).stats.total).toBe(0);
		const audience = await (await call(`${path}&classification=${label.id}`, "GET", undefined, bob.token)).json();
		expect(audience.stats.total).toBe(1);
		expect(audience.memories[0].id).toBe("review-hr");
		expect(audience.memories[0].classifications).toEqual([{ id: label.id, name: "HR review" }]);
		expect((await (await call(`${path}&limit=1&offset=1`, "GET", undefined, bob.token)).json()).stats.total).toBe(2);
		expect((await (await call(`/api/memories?agentId=${agent.agentId}&author=unknown`)).json()).stats.total).toBe(0);
		expect((await (await call(`/api/memories?agentId=${agent.agentId}&team=unknown`)).json()).stats.total).toBe(0);
		const key = await (
			await call(
				"/api/auth/api-keys",
				"POST",
				{
					name: "bound-review",
					agentId: bob.agentId,
					permissions: ["recall"],
					expiresAt: new Date(Date.now() + 60_000).toISOString(),
				},
				bob.token,
			)
		).json();
		expect((await call(path, "GET", undefined, key.secret)).status).toBe(403);
	});
	test("compliance lookup requires two characters and limits each principal", async () => {
		await claim();
		const alice = await member("lookup-alice");
		await call(`/api/org/users/${alice.userId}`, "PATCH", { compliance: true });
		expect((await call("/api/org/users/lookup?q=a", "GET", undefined, alice.token)).status).toBe(400);
	});

	test("compliance lookup rate limit is per principal", async () => {
		await claim();
		const alice = await member("limited-alice");
		await call(`/api/org/users/${alice.userId}`, "PATCH", { compliance: true });
		for (let i = 0; i < 30; i++)
			expect((await call("/api/org/users/lookup?q=al", "GET", undefined, alice.token)).status).toBe(200);
		const limited = await call("/api/org/users/lookup?q=al", "GET", undefined, alice.token);
		expect(limited.status).toBe(429);
		expect(Number(limited.headers.get("Retry-After"))).toBeGreaterThan(0);
		expect((await call("/api/org/users/lookup?q=al")).status).toBe(200);
	});

	test("bounded user lookup serves compliance without widening the directory", async () => {
		await claim();
		const alice = await member("alice");
		const bob = await member("albert");
		expect((await call("/api/org/users/lookup?q=alice", "GET", undefined, bob.token)).status).toBe(403);
		await call(`/api/org/users/${bob.userId}`, "PATCH", { compliance: true });
		const found = await call("/api/org/users/lookup?q=alice&limit=1", "GET", undefined, bob.token);
		expect(found.status).toBe(200);
		expect((await found.json()).users).toEqual([{ id: alice.userId, displayName: "alice", email: null }]);
		const { organizationWrite } = await import("./organization-store");
		await organizationWrite([statement("UPDATE users SET email=? WHERE id=?", ["alice@example.test", alice.userId])]);
		expect(
			(await (await call("/api/org/users/lookup?q=%40example.test", "GET", undefined, bob.token)).json()).users,
		).toEqual([{ id: alice.userId, displayName: "alice", email: "alice@example.test" }]);
		expect((await (await call("/api/org/users/lookup?q=%25%25", "GET", undefined, bob.token)).json()).users).toEqual(
			[],
		);
		const page = await (await call("/api/org/users/lookup?q=al&limit=1", "GET", undefined, bob.token)).json();
		expect(page.users).toHaveLength(1);
		expect(typeof page.nextCursor).toBe("string");
		const next = await (
			await call(`/api/org/users/lookup?q=al&limit=1&cursor=${page.nextCursor}`, "GET", undefined, bob.token)
		).json();
		expect(next.users).toHaveLength(1);
		expect(next.users[0].id).not.toBe(page.users[0].id);
		expect(next.nextCursor).toBeNull();
		expect((await call("/api/org/users", "GET", undefined, bob.token)).status).toBe(403);
		expect((await call("/api/org/users/lookup?q=alice&limit=51", "GET", undefined, bob.token)).status).toBe(400);
		const key = await (
			await call(
				"/api/auth/api-keys",
				"POST",
				{ name: "narrowed-lookup", permissions: ["recall"], expiresAt: new Date(Date.now() + 60_000).toISOString() },
				bob.token,
			)
		).json();
		expect((await call("/api/org/users/lookup?q=alice", "GET", undefined, key.secret)).status).toBe(403);
		const scoped = await (
			await call(
				"/api/auth/api-keys",
				"POST",
				{
					name: "scoped-lookup",
					agentId: bob.agentId,
					permissions: ["classify"],
					expiresAt: new Date(Date.now() + 60_000).toISOString(),
				},
				bob.token,
			)
		).json();
		expect((await call("/api/org/users/lookup?q=alice", "GET", undefined, scoped.secret)).status).toBe(403);
	});
	test("operator log streams are scoped, content-free and cancelled cleanly", async () => {
		const { registerMiscRoutes } = await import("../routes/misc-routes");
		const { logger } = await import("../logger");
		registerMiscRoutes(app);
		await claim();
		const alice = await member("alice");
		expect((await call("/api/logs", "GET", undefined, alice.token)).status).toBe(403);
		logger.info("api", "classified-log-marker", { content: "private-log-detail" });
		const recent = await call("/api/logs?limit=5");
		expect(recent.status).toBe(200);
		const snapshot = await recent.json();
		expect(snapshot.redacted).toBe(true);
		expect(JSON.stringify(snapshot)).not.toContain("classified-log-marker");
		const listeners = logger.listenerCount("log");
		const controller = new AbortController();
		const response = await app.request("/api/logs/stream", {
			headers: { authorization: `Bearer ${admin}` },
			signal: controller.signal,
		});
		expect(response.status).toBe(200);
		expect(logger.listenerCount("log")).toBe(listeners + 1);
		const reader = response.body?.getReader();
		if (!reader) throw new Error("missing log stream");
		expect(new TextDecoder().decode((await reader.read()).value)).toContain('"redacted":true');
		logger.info("api", "classified-log-marker", { content: "private-log-detail" });
		const event = new TextDecoder().decode((await reader.read()).value);
		expect(event).not.toContain("classified-log-marker");
		expect(event).not.toContain("private-log-detail");
		controller.abort();
		await reader.cancel();
		expect(logger.listenerCount("log")).toBe(listeners);
		expect(
			await organizationQuery(
				statement("SELECT COUNT(*) AS n FROM audit_events WHERE action='operator.logs_opened'", [], "get"),
			),
		).toEqual({ n: 2 });
		expect((await call(`/api/org/users/${alice.userId}`, "PATCH", { role: "operator" })).status).toBe(200);
		expect((await call("/api/logs", "GET", undefined, alice.token)).status).toBe(403);
		const identity = await (await call("/api/auth/whoami")).json();
		const key = await (
			await call("/api/auth/api-keys", "POST", {
				name: "scoped-logs",
				agentId: identity.agents.defaultWrite,
				permissions: ["admin", "diagnostics"],
				expiresAt: new Date(Date.now() + 60_000).toISOString(),
			})
		).json();
		expect((await call("/api/logs", "GET", undefined, key.secret)).status).toBe(403);
		expect((await call("/api/logs?limit=501")).status).toBe(400);
		const bounded = await app.request("/api/logs/stream?limit=1", { headers: { authorization: `Bearer ${admin}` } });
		const boundedReader = bounded.body?.getReader();
		if (!boundedReader) throw new Error("missing bounded log stream");
		await boundedReader.read();
		logger.info("api", "bounded event");
		expect((await boundedReader.read()).done).toBe(false);
		expect((await boundedReader.read()).done).toBe(true);
		expect(logger.listenerCount("log")).toBe(listeners);
		const first = await app.request("/api/logs/stream", { headers: { authorization: `Bearer ${admin}` } });
		const second = await app.request("/api/logs/stream", { headers: { authorization: `Bearer ${admin}` } });
		expect((await app.request("/api/logs/stream", { headers: { authorization: `Bearer ${admin}` } })).status).toBe(429);
		await first.body?.cancel();
		await second.body?.cancel();
		expect(logger.listenerCount("log")).toBe(listeners);
	});
	test("classified import admission is atomic and hidden staging jobs stay absent", async () => {
		const { registerClassificationRoutes } = await import("../routes/classification-routes");
		const { registerTranscriptImportRoutes } = await import("../routes/transcript-import-routes");
		registerClassificationRoutes(app);
		registerTranscriptImportRoutes(app);
		await claim();
		const bob = await member("bob");
		const alice = await member("alice");
		await call(`/api/org/users/${bob.userId}`, "PATCH", { compliance: true });
		const label = await (
			await call(
				"/api/classifications",
				"POST",
				{ name: "Import HR", audience: [{ kind: "user", id: bob.userId }] },
				bob.token,
			)
		).json();
		const denied = await call(
			"/api/sources/imports",
			"POST",
			{ classificationId: label.id, files: [{ name: "classified.jsonl" }] },
			alice.token,
		);
		expect({ status: denied.status, body: await denied.json() }).toMatchObject({ status: 403 });
		expect(await organizationQuery(statement("SELECT COUNT(*) AS n FROM source_import_jobs", [], "get"))).toEqual({
			n: 0,
		});
		const created = await call(
			"/api/sources/imports",
			"POST",
			{ classificationId: label.id, files: [{ name: "classified.jsonl" }] },
			bob.token,
		);
		expect({ status: created.status, body: await created.clone().json() }).toMatchObject({ status: 201 });
		const job = await created.json();
		expect(
			await organizationQuery(statement("SELECT labels_json FROM source_import_jobs WHERE id=?", [job.id], "get")),
		).toEqual({ labels_json: JSON.stringify([label.id]) });
		expect(
			(
				await organizationQuery<{ n: number }>(
					statement(
						"SELECT COUNT(*) AS n FROM classification_assignments WHERE target_kind='source' AND agent_id=? AND classification_id=?",
						[bob.agentId, label.id],
						"get",
					),
				)
			).n,
		).toBe(1);
		const hidden = await call(`/api/sources/imports?agentId=${bob.agentId}`, "GET", undefined, alice.token);
		expect(hidden.status).toBe(200);
		expect(JSON.stringify(await hidden.json())).not.toContain(job.id);
	});
	test("personal-key cookie sessions retain durable permission, agent and expiry ceilings", async () => {
		const root = await claim();
		const bob = await member("bob");
		const expiresAt = new Date(Date.now() + 300_000).toISOString();
		const issued = await (
			await call("/api/auth/api-keys", "POST", {
				name: "browser fallback",
				permissions: ["recall"],
				agentId: root.user.personalAgentId ?? (await (await call("/api/auth/whoami")).json()).agents.defaultWrite,
				allowedProjects: ["project-a"],
				expiresAt,
			})
		).json();
		const exchanged = await app.request("/api/auth/session", {
			method: "POST",
			headers: { authorization: `Bearer ${issued.secret}` },
		});
		expect(exchanged.status).toBe(200);
		const payload = await exchanged.json();
		expect(payload).not.toHaveProperty("accessToken");
		expect(payload.expiresAt).toBe(expiresAt);
		const cookie = exchanged.headers
			.getSetCookie()
			.map((item) => item.split(";")[0])
			.join("; ");
		const read = (path: string, headers: Record<string, string> = {}) =>
			app.request(path, { headers: { cookie, ...headers } });
		const identity = await (await read("/api/auth/whoami")).json();
		expect(identity.permissions).toEqual(["recall"]);
		const denied = await read(`/api/agents?agentId=${bob.agentId}`);
		expect(denied.status).toBe(403);
		expect(
			(
				await app.request("/api/org/invites", {
					method: "POST",
					headers: { cookie, "content-type": "application/json", "x-signet-csrf": payload.csrf },
					body: "{}",
				})
			).status,
		).toBe(403);
		const { organizationWrite } = await import("./organization-store");
		await organizationWrite([
			statement(
				"UPDATE auth_sessions SET last_used_at='2000-01-01T00:00:00.000Z',access_expires_at=? WHERE source_key_id=?",
				[new Date(Date.now() + 90_000).toISOString(), issued.key.id],
			),
		]);
		await read("/api/auth/whoami");
		const persisted = await organizationQuery<{ access_expires_at: string }>(
			statement("SELECT access_expires_at FROM auth_sessions WHERE source_key_id=?", [issued.key.id], "get"),
		);
		expect(persisted.access_expires_at).toBe(expiresAt);
		await closeDbAccessor();
		initDbAccessor((await import("@signet/core")).resolveWorkspaceLayout(dir).database, { agentsDir: dir });
		expect((await (await read("/api/auth/whoami")).json()).permissions).toEqual(["recall"]);
		expect((await call(`/api/auth/api-keys/${issued.key.id}`, "DELETE")).status).toBe(200);
		expect((await read("/api/agents")).status).toBe(401);
	});
	test("key-cookie handoff and live parent narrowing cannot widen issuance ceilings", async () => {
		await claim();
		const own = (await (await call("/api/auth/whoami")).json()).agents.defaultWrite;
		const expiresAt = new Date(Date.now() + 300_000).toISOString();
		const issued = await (
			await call("/api/auth/api-keys", "POST", {
				name: "handoff ceiling",
				permissions: ["recall"],
				agentId: own,
				allowedProjects: ["project-a"],
				expiresAt,
			})
		).json();
		const exchanged = await app.request("/api/auth/session", {
			method: "POST",
			headers: { authorization: `Bearer ${issued.secret}` },
		});
		expect(exchanged.status).toBe(200);
		const initial = await exchanged.json();
		const cookie = exchanged.headers
			.getSetCookie()
			.map((item) => item.split(";")[0])
			.join("; ");
		const write = (path: string, body: unknown, csrf = initial.csrf) =>
			app.request(path, {
				method: "POST",
				headers: { cookie, "content-type": "application/json", "x-signet-csrf": csrf },
				body: JSON.stringify(body),
			});
		expect((await write("/api/auth/handoff", {}, "wrong")).status).toBe(403);
		expect((await write("/api/auth/api-keys", { name: "escape", permissions: ["recall"] })).status).toBe(403);
		expect((await write("/api/auth/device/approve", { userCode: "AAAA-AAAA", decision: "approve" })).status).toBe(403);
		const handoff = await (await write("/api/auth/handoff", {})).json();
		const redeemed = await call("/api/auth/handoff/redeem", "POST", { code: handoff.code, confirm: true }, "");
		expect(redeemed.status).toBe(200);
		expect((await redeemed.json()).expiresAt).toBe(expiresAt);
		const secondCookie = redeemed.headers
			.getSetCookie()
			.map((item) => item.split(";")[0])
			.join("; ");
		const read = (path: string) => app.request(path, { headers: { cookie: secondCookie } });
		const { organizationWrite } = await import("./organization-store");
		await organizationWrite([
			statement(
				"UPDATE api_keys SET permissions_json=?,agent_id=NULL,scope_json=json_remove(scope_json,'$.agent'),allowed_projects_json=NULL,expires_at=? WHERE id=?",
				[JSON.stringify(["recall", "remember"]), new Date(Date.now() + 86400_000).toISOString(), issued.key.id],
			),
		]);
		expect((await (await read("/api/auth/whoami")).json()).permissions).toEqual(["recall"]);
		expect((await read("/api/agents?agentId=default")).status).toBe(403);
		expect((await read("/api/agents?project=project-b")).status).toBe(403);
		await organizationWrite([
			statement("UPDATE api_keys SET permissions_json='[]',expires_at=? WHERE id=?", [
				new Date(Date.now() + 120_000).toISOString(),
				issued.key.id,
			]),
		]);
		const narrowed = await (await read("/api/auth/whoami")).json();
		expect(narrowed.permissions).toEqual([]);
		expect(Date.parse(narrowed.credential.expiresAt)).toBeLessThan(Date.parse(expiresAt));
		await organizationWrite([
			statement("UPDATE api_keys SET expires_at='2000-01-01T00:00:00.000Z' WHERE id=?", [issued.key.id]),
		]);
		const expired = await read("/api/agents");
		expect(expired.status).toBe(401);
		expect(await expired.json()).toMatchObject({ reason: "expired" });
	});
	test("key-cookie exchange denies wrong scope and shared credentials", async () => {
		await claim();
		const bob = await member("bob");
		const issued = await (
			await call("/api/auth/api-keys", "POST", {
				name: "scope",
				permissions: ["recall"],
				expiresAt: new Date(Date.now() + 60_000).toISOString(),
			})
		).json();
		const { organizationWrite } = await import("./organization-store");
		await organizationWrite([
			statement("UPDATE api_keys SET agent_id=?,scope_json=json_set(scope_json,'$.agent',?) WHERE id=?", [
				"default",
				"default",
				issued.key.id,
			]),
		]);
		expect(
			(
				await app.request(`/api/auth/session?agentId=${bob.agentId}`, {
					method: "POST",
					headers: { authorization: `Bearer ${issued.secret}`, "content-type": "application/json" },
					body: "{}",
				})
			).status,
		).toBe(403);
		await organizationWrite([statement("UPDATE api_keys SET kind='shared' WHERE id=?", [issued.key.id])]);
		expect((await call("/api/auth/session", "POST", {}, issued.secret)).status).toBe(403);
		expect(
			await organizationQuery(
				statement("SELECT COUNT(*) AS n FROM auth_sessions WHERE user_id=?", [bob.userId], "get"),
			),
		).toEqual({ n: 1 });
	});
	test("self-service email fields are uniformly forbidden without changing identity", async () => {
		await claim();
		const alice = await member("email-alice");
		const bob = await member("email-bob");
		expect((await call(`/api/org/users/${bob.userId}`, "PATCH", { email: "taken@example.com" })).status).toBe(200);
		for (const email of ["taken@example.com", "free@example.com", null, "invalid"]) {
			const response = await call("/api/auth/profile", "PATCH", { email }, alice.token);
			expect(response.status).toBe(403);
			expect(await response.json()).toMatchObject({ reason: "email_change_requires_admin" });
		}
		expect((await (await call("/api/auth/profile", "GET", undefined, alice.token)).json()).user.email).toBeNull();
		expect((await (await call("/api/auth/profile", "GET", undefined, bob.token)).json()).user.email).toBe(
			"taken@example.com",
		);
	});

	test("own profile updates are scoped and SSO identity fields are read-only", async () => {
		await claim();
		const alice = await member("alice");
		const bob = await member("bob");
		const updated = await call("/api/auth/profile", "PATCH", { displayName: "Alice Changed" }, alice.token);
		expect(updated.status).toBe(200);
		expect(await updated.json()).toMatchObject({
			user: { id: alice.userId, displayName: "Alice Changed", email: null, ssoManaged: false },
			editableFields: ["displayName"],
		});
		expect(
			(await call("/api/auth/profile", "PATCH", { userId: bob.userId, displayName: "spoof" }, alice.token)).status,
		).toBe(400);
		expect((await (await call("/api/auth/profile", "GET", undefined, bob.token)).json()).user.displayName).toBe("bob");
		const { organizationWrite } = await import("./organization-store");
		const group = await (await call("/api/org/groups", "POST", { name: "Managed Team" })).json();
		expect((await call(`/api/org/groups/${group.id}/members/${alice.userId}`, "PUT", { role: "member" })).status).toBe(
			200,
		);
		await organizationWrite([
			statement("UPDATE group_members SET managed_by='idp' WHERE group_id=? AND user_id=?", [group.id, alice.userId]),
		]);
		expect((await (await call("/api/auth/whoami", "GET", undefined, alice.token)).json()).user.groups).toContainEqual({
			id: group.id,
			name: "Managed Team",
			role: "member",
			managedBy: "idp",
		});
		await organizationWrite([
			statement("UPDATE users SET oidc_issuer=?,oidc_subject=? WHERE id=?", [
				"https://idp.example",
				"alice-subject",
				alice.userId,
			]),
		]);
		expect(await (await call("/api/auth/profile", "GET", undefined, alice.token)).json()).toMatchObject({
			user: { ssoManaged: true },
			editableFields: [],
			identityProvider: { kind: "oidc", issuer: "https://idp.example" },
		});
		expect((await call("/api/auth/profile", "PATCH", { email: "changed@example.com" }, alice.token)).status).toBe(403);
	});
	test("a member can rename only their own personal agent without transferring it", async () => {
		await claim();
		const alice = await member("alice");
		const bob = await member("bob");
		expect((await call(`/api/agents/${alice.agentId}`, "PATCH", { name: "Alice Notes" }, alice.token)).status).toBe(
			200,
		);
		expect((await call(`/api/agents/${bob.agentId}`, "PATCH", { name: "Other Notes" }, alice.token)).status).toBe(403);
		expect(
			(await call(`/api/agents/${alice.agentId}`, "PATCH", { name: "Notes", ownerUserId: bob.userId }, alice.token))
				.status,
		).toBe(403);
		const inventory = await (await call("/api/agents")).json();
		expect(inventory.agents.find((item: { id: string }) => item.id === alice.agentId)).toMatchObject({
			name: "Alice Notes",
			ownerUserId: alice.userId,
		});
	});

	test("SSO invitation continuation is token-free, single-use and short-lived", async () => {
		await claim();
		const provider = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch(request) {
				const issuer = new URL(request.url).origin;
				return Response.json({
					issuer,
					authorization_endpoint: `${issuer}/authorize`,
					token_endpoint: `${issuer}/token`,
					jwks_uri: `${issuer}/jwks`,
				});
			},
		});
		try {
			await call("/api/org/settings", "PATCH", {
				oidc: { issuer: provider.url.origin, clientId: "fixture", allowedDomains: [] },
				requireSso: true,
			});
			const invite = await (await call("/api/org/invites", "POST", { role: "member", groupIds: [] })).json();
			const token = new URL(invite.inviteUrl).pathname.split("/").pop();
			const accepted = await (
				await call("/api/auth/invites/accept", "POST", { token, username: "sso-user", displayName: "SSO User" }, "")
			).json();
			expect(accepted.ssoStartPath).not.toContain(token);
			const path = new URL(accepted.ssoStartPath, "http://localhost");
			expect(path.searchParams.has("invite")).toBe(false);
			expect(path.searchParams.get("continuation")).toBeTruthy();
			const started = await call(path.pathname + path.search, "GET", undefined, "");
			expect(started.status).toBe(302);
			expect(started.headers.get("location")).not.toContain(token);
			expect((await call(path.pathname + path.search, "GET", undefined, "")).status).toBe(401);
			const retry = await (
				await call("/api/auth/invites/accept", "POST", { token, username: "sso-user", displayName: "SSO User" }, "")
			).json();
			const now = Date.now();
			const clock = spyOn(Date, "now").mockReturnValue(now + 61_000);
			try {
				expect((await call(retry.ssoStartPath, "GET", undefined, "")).status).toBe(401);
			} finally {
				clock.mockRestore();
			}
		} finally {
			provider.stop(true);
		}
	});
	test("connector error summaries are bounded and visible only to the key owner", async () => {
		await claim();
		const alice = await member("alice");
		const bob = await member("bob");
		const flow = await (
			await call("/api/auth/device/start", "POST", { client: "cli", deviceName: "Laptop", platform: "linux" }, "")
		).json();
		expect(
			(await call("/api/auth/device/approve", "POST", { userCode: flow.userCode, decision: "approve" }, alice.token))
				.status,
		).toBe(200);
		const cli = await (await call("/api/auth/device/token", "POST", { deviceCode: flow.deviceCode }, "")).json();
		const issued = await (
			await call("/api/auth/connector-keys", "POST", { harness: "codex", deviceId: cli.deviceId }, cli.accessToken)
		).json();
		const path = `/api/auth/connector-keys/${issued.key.id}/errors`;
		const forged = `${issued.secret.slice(0, -1)}${issued.secret.endsWith("a") ? "b" : "a"}`;
		expect((await call("/api/auth/devices", "GET", undefined, forged)).status).toBe(401);
		expect((await (await call(path, "GET", undefined, alice.token)).json()).errors).toEqual([]);
		for (let i = 0; i < 12; i++) {
			const rejected = await app.request("http://localhost/api/agents", {
				method: "POST",
				headers: {
					authorization: `Bearer ${issued.secret}`,
					"content-type": "application/json",
					"x-signet-agent-id": bob.agentId,
				},
				body: JSON.stringify({ name: "private-request-body" }),
			});
			expect(rejected.status).toBe(403);
			if (i === 0) expect((await (await call(path, "GET", undefined, alice.token)).json()).errors).toHaveLength(1);
		}
		expect(
			await organizationQuery(
				statement("SELECT COUNT(*) AS n FROM audit_events WHERE action='connector.error'", [], "get"),
			),
		).toEqual({ n: 0 });
		expect(
			await organizationQuery(
				statement(
					"SELECT COUNT(*) AS n FROM audit_events WHERE action='auth.failure' AND target_id=?",
					[issued.key.id],
					"get",
				),
			),
		).toEqual({ n: 1 });
		const result = await call(path, "GET", undefined, alice.token);
		expect(result.status).toBe(200);
		const summary = await result.json();
		expect(summary.errors).toHaveLength(10);
		expect(summary.errors[0]).toMatchObject({ status: 403, reason: "agent_binding_conflict" });
		expect(JSON.stringify(summary)).not.toContain("private-request-body");
		expect(JSON.stringify(summary)).not.toContain(issued.secret);
		expect((await call(path, "GET", undefined, bob.token)).status).toBe(403);
		expect((await call(path)).status).toBe(403);
		expect((await call(`/api/auth/connector-keys/${issued.key.id}`, "DELETE", undefined, alice.token)).status).toBe(
			200,
		);
		expect((await call("/api/auth/devices", "GET", undefined, issued.secret)).status).toBe(401);
		await closeDbAccessor();
		initDbAccessor((await import("@signet/core")).resolveWorkspaceLayout(dir).database, { agentsDir: dir });
		expect((await (await call(path, "GET", undefined, alice.token)).json()).errors[0]).toMatchObject({
			status: 401,
			reason: "revoked",
		});
	});
	test("classification principal metadata is visible only to definition managers", async () => {
		const { registerClassificationRoutes } = await import("../routes/classification-routes");
		registerClassificationRoutes(app);
		await claim();
		const alice = await member("alice");
		const bob = await member("bob");
		expect((await call(`/api/org/users/${bob.userId}`, "PATCH", { compliance: true })).status).toBe(200);
		const created = await (
			await call(
				"/api/classifications",
				"POST",
				{ name: "HR", audience: [{ kind: "user", id: alice.userId }], appliers: [{ kind: "user", id: bob.userId }] },
				bob.token,
			)
		).json();
		const managed = await (await call(`/api/classifications/${created.id}`, "GET", undefined, bob.token)).json();
		expect(managed.audience).toEqual([{ kind: "user", id: alice.userId, displayName: "alice" }]);
		expect(managed.appliers).toEqual([{ kind: "user", id: bob.userId, displayName: "bob" }]);
		const readable = await (await call(`/api/classifications/${created.id}`, "GET", undefined, alice.token)).json();
		expect(readable.id).toBe(created.id);
		expect(readable).not.toHaveProperty("audience");
		expect(readable).not.toHaveProperty("appliers");
		expect((await call(`/api/classifications/${created.id}`)).status).toBe(404);
		expect(await (await call("/api/classifications")).json()).toEqual([]);
		expect((await (await call("/api/classifications", "GET", undefined, bob.token)).json())[0].audience).toEqual(
			managed.audience,
		);
		const narrowed = await (
			await call(
				"/api/auth/api-keys",
				"POST",
				{ name: "limited", permissions: ["recall"], expiresAt: new Date(Date.now() + 60_000).toISOString() },
				bob.token,
			)
		).json();
		expect(
			await (await call(`/api/classifications/${created.id}`, "GET", undefined, narrowed.secret)).json(),
		).not.toHaveProperty("audience");
	});
	test("offboarding purge removes exactly the actor-visible preview", async () => {
		const { registerClassificationRoutes } = await import("../routes/classification-routes");
		registerClassificationRoutes(app);
		await claim();
		const departed = await member("departed");
		const manager = await member("hr-manager");
		await call(`/api/org/users/${manager.userId}`, "PATCH", { compliance: true });
		const hr = await (
			await call(
				"/api/classifications",
				"POST",
				{ name: "HR purge", audience: [{ kind: "user", id: manager.userId }] },
				manager.token,
			)
		).json();
		const { organizationWrite } = await import("./organization-store");
		await organizationWrite([
			statement(
				"INSERT INTO memories(id,agent_id,author_user_id,content,type,memory_kind,created_at,updated_at) VALUES('departed-public',?,?,'public','fact','episodic','2026','2026'),('departed-hr',?,?,'private','fact','episodic','2026','2026')",
				[departed.agentId, departed.userId, departed.agentId, departed.userId],
			),
			statement(
				"INSERT INTO memory_artifacts(agent_id,source_path,source_sha256,source_kind,session_id,session_token,author_user_id,captured_at,updated_at) VALUES(?,'departed-hr-artifact','hash','source_import_md','unbound','unbound',?,'2026','2026')",
				[departed.agentId, departed.userId],
			),
		]);
		expect(
			(
				await call(
					`/api/classifications/${hr.id}/apply?wait=1`,
					"POST",
					{ target: { kind: "memory", id: "departed-hr", agentId: departed.agentId } },
					manager.token,
				)
			).status,
		).toBe(202);
		await organizationWrite([
			statement(
				"UPDATE memory_artifacts SET compartment_id=(SELECT compartment_id FROM memories WHERE id='departed-hr') WHERE source_path='departed-hr-artifact'",
			),
		]);
		const preview = await (
			await call(`/api/org/users/${departed.userId}/deactivate`, "POST", { mode: "purge" })
		).json();
		expect(preview.plan.counts).toMatchObject({ memories: 1, artifacts: 0 });
		const started = await (
			await call(`/api/org/users/${departed.userId}/deactivate`, "POST", { mode: "purge", dryRun: false })
		).json();
		let job = await (await call(`/api/org/jobs/${started.jobId}`)).json();
		for (let i = 0; job.status === "running" && i < 100; i++) {
			await Bun.sleep(20);
			job = await (await call(`/api/org/jobs/${started.jobId}`)).json();
		}
		expect(job.status).toBe("complete");
		expect(JSON.parse(job.progress_json).removed).toMatchObject({ memories: 1, memory_artifacts: 0 });
		expect(
			await organizationQuery(statement("SELECT id FROM memories WHERE author_user_id=?", [departed.userId], "all")),
		).toEqual([{ id: "departed-hr" }]);
		expect(
			await organizationQuery(
				statement("SELECT COUNT(*) AS n FROM memory_artifacts WHERE author_user_id=?", [departed.userId], "get"),
			),
		).toEqual({ n: 1 });
		const material = `/api/classifications/${hr.id}/purge-author`;
		expect((await call(material, "POST", { userId: departed.userId })).status).toBe(403);
		const managerPreview = await call(material, "POST", { userId: departed.userId }, manager.token);
		expect(managerPreview.status).toBe(200);
		expect((await managerPreview.json()).plan.counts).toMatchObject({ memories: 1, artifacts: 1 });
		const managerStarted = await call(material, "POST", { userId: departed.userId, dryRun: false }, manager.token);
		expect(managerStarted.status).toBe(202);
		const managerJob = await managerStarted.json();
		let managerStatus = await (await call(`/api/org/jobs/${managerJob.jobId}`, "GET", undefined, manager.token)).json();
		for (let i = 0; managerStatus.status === "running" && i < 100; i++) {
			await Bun.sleep(20);
			managerStatus = await (await call(`/api/org/jobs/${managerJob.jobId}`, "GET", undefined, manager.token)).json();
		}
		expect(managerStatus.status).toBe("complete");
		expect(JSON.parse(managerStatus.progress_json).removed).toMatchObject({ memories: 1, memory_artifacts: 1 });
		expect(
			await organizationQuery(
				statement("SELECT COUNT(*) AS n FROM memories WHERE author_user_id=?", [departed.userId], "get"),
			),
		).toEqual({ n: 0 });
		expect(
			await organizationQuery(
				statement("SELECT COUNT(*) AS n FROM memory_artifacts WHERE author_user_id=?", [departed.userId], "get"),
			),
		).toEqual({ n: 0 });
	});

	test("offboarding preview excludes HR evidence and reports only active sessions", async () => {
		const { registerClassificationRoutes } = await import("../routes/classification-routes");
		registerClassificationRoutes(app);
		const root = await claim();
		const bob = await member("bob");
		expect((await call(`/api/org/users/${bob.userId}`, "PATCH", { compliance: true })).status).toBe(200);
		const hrAgent = await (await call("/api/agents", "POST", { name: "HR notes", kind: "personal" }, bob.token)).json();
		const { organizationWrite, issueSession } = await import("./organization-store");
		const now = new Date().toISOString();
		for (const [suffix, agentId] of [
			["public", bob.agentId],
			["hr", hrAgent.agentId],
		]) {
			await organizationWrite([
				statement(
					"INSERT INTO memories(id,content,agent_id,memory_kind,type,visibility,created_at,updated_at,author_user_id) VALUES (?, 'offboarding evidence',?,'episodic','fact','private',?,?,?)",
					[`memory-${suffix}`, agentId, now, now, bob.userId],
				),
				statement(
					"INSERT INTO session_transcripts(agent_id,session_key,content,harness,created_at,speaker_user_id) VALUES (?,?,'offboarding transcript','test',?,?)",
					[agentId, `session-${suffix}`, now, bob.userId],
				),
				statement(
					"INSERT INTO documents(id,agent_id,source_type,raw_content,created_at,updated_at,author_user_id) VALUES (?,?,'text','offboarding document',?,?,?)",
					[`doc-${suffix}`, agentId, now, now, bob.userId],
				),
				statement(
					"INSERT INTO memory_artifacts(agent_id,source_path,source_sha256,source_kind,session_id,session_token,captured_at,updated_at,author_user_id) VALUES (?,?,'hash','summary','unbound','unbound',?,?,?)",
					[agentId, `artifact-${suffix}`, now, now, bob.userId],
				),
			]);
		}
		await organizationWrite([
			statement(
				"INSERT INTO memories(id,content,agent_id,memory_kind,type,visibility,created_at,updated_at) VALUES ('hr-child','derived private',?,'semantic','fact','private',?,?),('hr-grandchild','copied private',?,'semantic','fact','private',?,?)",
				[hrAgent.agentId, now, now, hrAgent.agentId, now, now],
			),
			statement(
				"INSERT INTO derived_memory_sources(agent_id,derived_memory_id,source_kind,source_id,created_at) VALUES (?,'hr-child','memory','memory-hr',?),(?,'hr-grandchild','memory','hr-child',?)",
				[hrAgent.agentId, now, hrAgent.agentId, now],
			),
		]);
		const expired = await issueSession(bob.userId, "cli");
		await organizationWrite([
			statement(
				"UPDATE auth_sessions SET access_expires_at='2000-01-01T00:00:00.000Z',refresh_expires_at='2000-01-01T00:00:00.000Z' WHERE id=?",
				[expired.sessionId],
			),
		]);
		const hr = await (
			await call(
				"/api/classifications",
				"POST",
				{ name: "HR offboarding", audience: [{ kind: "user", id: bob.userId }] },
				bob.token,
			)
		).json();
		expect(
			(
				await call(
					`/api/classifications/${hr.id}/apply?wait=1`,
					"POST",
					{ target: { kind: "agent", id: hrAgent.agentId, agentId: hrAgent.agentId } },
					bob.token,
				)
			).status,
		).toBe(202);
		const preview = await (
			await call(`/api/org/users/${bob.userId}/deactivate`, "POST", { mode: "transfer", transferTo: root.user.id })
		).json();
		expect(preview.plan.counts).toMatchObject({
			memories: 1,
			transcripts: 1,
			artifacts: 1,
			documents: 1,
			sessions: 1,
			agents: 1,
		});
		expect(preview.plan.ownedAgents).toEqual([
			{ id: bob.agentId, name: "bob", kind: "personal", transferTo: { userId: root.user.id, displayName: "Admin" } },
		]);
		expect(JSON.stringify(preview)).not.toContain(hrAgent.agentId);
		expect((await call(`/api/org/users/${root.user.id}/deactivate`, "POST", { mode: "keep" }, bob.token)).status).toBe(
			403,
		);
		expect(
			(
				await call(
					`/api/classifications/${hr.id}/audience`,
					"PUT",
					[
						{ kind: "user", id: bob.userId },
						{ kind: "user", id: root.user.id },
					],
					bob.token,
				)
			).status,
		).toBe(200);
		const authorized = await (await call(`/api/org/users/${bob.userId}/deactivate`, "POST", { mode: "keep" })).json();
		expect(authorized.plan.counts).toMatchObject({
			memories: 4,
			transcripts: 2,
			artifacts: 2,
			documents: 2,
			sessions: 1,
			agents: 2,
		});
		expect(
			(await call(`/api/classifications/${hr.id}/audience`, "PUT", [{ kind: "user", id: bob.userId }], bob.token))
				.status,
		).toBe(200);
		const purged = await (
			await call(`/api/org/users/${bob.userId}/deactivate`, "POST", { mode: "purge", dryRun: false })
		).json();
		let status = await (await call(`/api/org/jobs/${purged.jobId}`)).json();
		for (let attempt = 0; status.status === "running" && attempt < 100; attempt++) {
			await Bun.sleep(25);
			status = await (await call(`/api/org/jobs/${purged.jobId}`)).json();
		}
		expect(status.status).toBe("complete");
		expect(JSON.parse(status.progress_json).removed).toMatchObject({
			memories: 1,
			documents: 1,
			memory_artifacts: 1,
			session_transcripts: 1,
		});
		expect(
			await organizationQuery(statement("SELECT id FROM memories WHERE author_user_id=?", [bob.userId], "all")),
		).toEqual([{ id: "memory-hr" }]);
	});
	test("agent transfer changes organizational ownership without retaining the old owner", async () => {
		await claim();
		const agent = await (await call("/api/agents", "POST", { name: "transfer-me", kind: "personal" })).json();
		const group = await (await call("/api/org/groups", "POST", { name: "eng" })).json();
		expect((await call(`/api/agents/${agent.agentId}`, "PATCH", { ownerGroupId: group.id })).status).toBe(200);
		const inventory = await (await call("/api/agents")).json();
		expect(inventory.agents.find((item: { id: string }) => item.id === agent.agentId)).toMatchObject({
			kind: "team",
			ownerUserId: null,
			ownerGroupId: group.id,
		});
		expect((await call("/api/agents/default", "PATCH", { ownerGroupId: group.id })).status).toBe(403);
	});

	test("agent preference persists a readable default without changing write ownership", async () => {
		const claimed = await claim();
		const created = await (await call("/api/agents", "POST", { name: "my-notes", kind: "personal" })).json();
		const response = await call("/api/auth/preferences", "PATCH", { defaultReadAgentId: created.agentId });
		expect(response.status).toBe(200);
		const identity = await (await call("/api/auth/whoami")).json();
		expect(identity).toMatchObject({ effectiveAccess: true, accessMode: "authenticated" });
		expect(await (await call("/api/auth/whoami", "GET", undefined, "")).json()).toMatchObject({
			effectiveAccess: false,
			accessMode: "none",
		});
		expect(identity.agents.defaultRead).toBe(created.agentId);
		expect(identity.agents.defaultWrite).not.toBe(created.agentId);
		const invite = await (await call("/api/org/invites", "POST", { role: "member", groupIds: [] })).json();
		const accepted = await call(
			"/api/auth/invites/accept",
			"POST",
			{
				token: new URL(invite.inviteUrl).pathname.split("/").pop(),
				username: "member",
				displayName: "Member",
				password: "test password",
			},
			"",
		);
		const memberToken =
			accepted.headers
				.getSetCookie()
				.find((value) => value.startsWith("signet_session="))
				?.split(";")[0]
				?.slice("signet_session=".length) ?? "";
		expect(
			(
				await call(
					"/api/auth/preferences",
					"PATCH",
					{ defaultReadAgentId: "default", userId: claimed.user.id },
					memberToken,
				)
			).status,
		).toBe(400);
		expect((await (await call("/api/auth/whoami")).json()).agents.defaultRead).toBe(created.agentId);
		expect((await call("/api/auth/preferences", "PATCH", { defaultReadAgentId: "missing" })).status).toBe(403);
		expect(claimed.user.id).toBeTruthy();
	});

	test("dashboard handoff is single-use, cookie-only and bound to a live session", async () => {
		await claim();
		const issued = await call("/api/auth/handoff", "POST", {});
		expect(issued.status).toBe(200);
		const handoff = await issued.json();
		expect(Date.parse(handoff.expiresAt) - Date.now()).toBeLessThanOrEqual(60_000);
		const redeemed = await call("/api/auth/handoff/redeem", "POST", { code: handoff.code, confirm: true }, "");
		expect(redeemed.status).toBe(200);
		expect(
			redeemed.headers
				.getSetCookie()
				.some((value) => value.startsWith("signet_session=") && value.includes("HttpOnly")),
		).toBe(true);
		expect(await redeemed.json()).not.toHaveProperty("accessToken");
		expect((await call("/api/auth/handoff/redeem", "POST", { code: handoff.code, confirm: true }, "")).status).toBe(
			401,
		);
		const device = await (
			await call("/api/auth/device/start", "POST", { client: "cli", deviceName: "handoff" }, "")
		).json();
		await call("/api/auth/device/approve", "POST", { userCode: device.userCode, decision: "approve" });
		const login = await (await call("/api/auth/device/token", "POST", { deviceCode: device.deviceCode }, "")).json();
		const key = await (
			await call("/api/auth/connector-keys", "POST", { harness: "codex", deviceId: login.deviceId }, login.accessToken)
		).json();
		expect((await call("/api/auth/handoff", "POST", {}, key.secret)).status).toBe(403);
		const revoked = await (await call("/api/auth/handoff", "POST", {})).json();
		await call("/api/auth/logout", "POST", {});
		expect((await call("/api/auth/handoff/redeem", "POST", { code: revoked.code, confirm: true }, "")).status).toBe(
			401,
		);
	});

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
			await startOrganizationRuntime("http://127.0.0.1", dir);
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
			expect(limiter.check("new-peer").allowed).toBe(true);
			limiter.record("new-peer");
			expect(limiter.check("peer-0").allowed).toBe(true);
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

	test("session revocation and logout clear retry state", async () => {
		const root = await claim();
		const { issueSession, organizationWrite } = await import("./organization-store");
		for (const action of ["revoke", "logout-all"]) {
			const session = await issueSession(root.user.id, "cli");
			await organizationWrite([
				statement("UPDATE auth_sessions SET refresh_retry_json = ? WHERE id = ?", ["[1]", session.sessionId]),
			]);
			const response =
				action === "revoke"
					? await call(`/api/auth/sessions/${session.sessionId}`, "DELETE")
					: await call("/api/auth/logout", "POST", { all: true });
			expect(response.status).toBe(200);
			expect(
				await organizationQuery(
					statement("SELECT refresh_retry_json FROM auth_sessions WHERE id = ?", [session.sessionId], "get"),
				),
			).toEqual({ refresh_retry_json: "[]" });
		}
	});
	test("single-session logout clears retry state", async () => {
		const root = await claim();
		const { issueSession, organizationWrite, readOrganization, verifySession } = await import("./organization-store");
		const { logout } = await import("./organization-operations");
		const session = await issueSession(root.user.id, "cli");
		const { principal } = await verifySession(session.accessToken, undefined, false, await readOrganization());
		await organizationWrite([
			statement("UPDATE auth_sessions SET refresh_retry_json = ? WHERE id = ?", ["[1]", session.sessionId]),
		]);
		await logout(principal, {});
		expect(
			await organizationQuery(
				statement("SELECT refresh_retry_json FROM auth_sessions WHERE id = ?", [session.sessionId], "get"),
			),
		).toEqual({ refresh_retry_json: "[]" });
	});
	test("device exchange and revocation clear retry state", async () => {
		await claim();
		const { organizationWrite } = await import("./organization-store");
		const flow = await (
			await call("/api/auth/device/start", "POST", { client: "cli", deviceName: "Laptop" }, "")
		).json();
		expect(
			(await call("/api/auth/device/approve", "POST", { userCode: flow.userCode, decision: "approve" })).status,
		).toBe(200);
		const pending = await organizationQuery<{ session_id: string }>(
			statement("SELECT session_id FROM device_authorizations WHERE user_code = ?", [flow.userCode], "get"),
		);
		await organizationWrite([
			statement("UPDATE auth_sessions SET refresh_retry_json = ? WHERE id = ?", ["[1]", pending.session_id]),
		]);
		const response = await call("/api/auth/device/token", "POST", { deviceCode: flow.deviceCode }, "");
		expect(response.status).toBe(200);
		const cli = await response.json();
		expect(
			await organizationQuery(
				statement("SELECT refresh_retry_json FROM auth_sessions WHERE id = ?", [pending.session_id], "get"),
			),
		).toEqual({ refresh_retry_json: "[]" });
		await organizationWrite([
			statement("UPDATE auth_sessions SET refresh_retry_json = ? WHERE id = ?", ["[1]", cli.sessionId]),
		]);
		expect((await call(`/api/auth/devices/${cli.deviceId}`, "DELETE")).status).toBe(200);
		expect(
			await organizationQuery(
				statement("SELECT refresh_retry_json FROM auth_sessions WHERE id = ?", [cli.sessionId], "get"),
			),
		).toEqual({ refresh_retry_json: "[]" });
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

	test("A10 a lost rotation survives sixty seconds and restart until the new access token is used", async () => {
		const root = await claim();
		const { issueSession } = await import("./organization-store");
		const session = await issueSession(root.user.id, "cli");
		const first = await (await call("/api/auth/refresh", "POST", { refreshToken: session.refreshToken }, "")).json();
		const clock = Date.now;
		const later = clock() + 61_000;
		try {
			Date.now = () => later;
			await (await import("../db-owner-runtime")).closeDbOwner();
			const retry = await call("/api/auth/refresh", "POST", { refreshToken: session.refreshToken }, "");
			expect(retry.status).toBe(200);
			const same = await retry.json();
			expect(same.accessToken === first.accessToken && same.refreshToken === first.refreshToken).toBe(true);
			const replayAudit = await organizationQuery(
				statement(
					"SELECT outcome,target_kind,target_id,detail_json FROM audit_events WHERE action = 'session.refresh_replayed' AND target_id = ?",
					[session.sessionId],
					"get",
				),
			);
			expect(replayAudit).toEqual({
				outcome: "ok",
				target_kind: "session",
				target_id: session.sessionId,
				detail_json: "null",
			});
			expect((await call("/api/auth/sessions", "GET", undefined, first.accessToken)).status).toBe(200);
			const reuse = await call("/api/auth/refresh", "POST", { refreshToken: session.refreshToken }, "");
			expect(reuse.status).toBe(401);
			expect(await reuse.json()).toMatchObject({ reason: "refresh_reuse" });
			expect((await call("/api/auth/sessions", "GET", undefined, first.accessToken)).status).toBe(401);
			expect(
				await organizationQuery(
					statement("SELECT revoked_reason FROM auth_sessions WHERE id=?", [session.sessionId], "get"),
				),
			).toEqual({ revoked_reason: "refresh_reuse" });
		} finally {
			Date.now = clock;
		}
	});
	test("A10 use of the new refresh token ends the preceding retry grace", async () => {
		const root = await claim();
		const { issueSession } = await import("./organization-store");
		const session = await issueSession(root.user.id, "cli");
		const first = await (await call("/api/auth/refresh", "POST", { refreshToken: session.refreshToken }, "")).json();
		expect((await call("/api/auth/refresh", "POST", { refreshToken: first.refreshToken }, "")).status).toBe(200);
		const reuse = await call("/api/auth/refresh", "POST", { refreshToken: session.refreshToken }, "");
		expect(reuse.status).toBe(401);
		expect(await reuse.json()).toMatchObject({ reason: "refresh_reuse" });
		expect(
			await organizationQuery(
				statement("SELECT refresh_retry_json FROM auth_sessions WHERE id = ?", [session.sessionId], "get"),
			),
		).toEqual({ refresh_retry_json: "[]" });
	});
	test("A10 an unused rotation has a twenty-four-hour retry bound", async () => {
		const root = await claim();
		const { issueSession } = await import("./organization-store");
		const session = await issueSession(root.user.id, "cli");
		const clock = Date.now;
		const start = clock();
		try {
			Date.now = () => start;
			const first = await (await call("/api/auth/refresh", "POST", { refreshToken: session.refreshToken }, "")).json();
			Date.now = () => start + 86400_000 - 1;
			const retry = await call("/api/auth/refresh", "POST", { refreshToken: session.refreshToken }, "");
			expect(retry.status).toBe(200);
			const same = await retry.json();
			expect(same.accessToken === first.accessToken && same.refreshToken === first.refreshToken).toBe(true);
			Date.now = () => start + 86400_000;
			const reuse = await call("/api/auth/refresh", "POST", { refreshToken: session.refreshToken }, "");
			expect(reuse.status).toBe(401);
			expect(await reuse.json()).toMatchObject({ reason: "refresh_reuse" });
		} finally {
			Date.now = clock;
		}
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
				["purge-grandchild", root.user.id],
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
				"INSERT INTO derived_memory_sources (agent_id,derived_memory_id,source_kind,source_id,created_at) VALUES (?,'purge-grandchild','memory','purge-derived',?)",
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
		const preview = await (
			await call(`/api/org/users/${departing.user.id}/deactivate`, "POST", { mode: "purge" })
		).json();
		expect(preview.plan.counts).toMatchObject({
			memories: 3,
			summaries: 3,
			artifacts: 1,
			documents: 1,
			transcripts: 1,
		});
		const beforeMemories = await organizationQuery<{ n: number }>(
			statement("SELECT COUNT(*) AS n FROM memories", [], "get"),
		);
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
		const afterMemories = await organizationQuery<{ n: number }>(
			statement("SELECT COUNT(*) AS n FROM memories", [], "get"),
		);
		expect(beforeMemories.n - afterMemories.n).toBe(preview.plan.counts.memories);
		expect(progress.removed.memories).toBe(preview.plan.counts.memories);
		expect(progress.removed.session_summaries).toBe(preview.plan.counts.summaries);
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
		expect(await who.json()).toMatchObject({
			user: { username: "alice" },
			credential: { harness: "hermes-agent", keyKind: "connector" },
		});
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
		const { issueSession } = await import("./organization-store");
		const pendingSession = await issueSession(alice.user.id, "cli");
		await organizationWrite([
			statement("UPDATE auth_sessions SET refresh_retry_json = ? WHERE id = ?", ["[1]", pendingSession.sessionId]),
		]);
		const plan = await call(`/api/org/users/${alice.user.id}/deactivate`, "POST", { mode: "keep" });
		expect(plan.status).toBe(200);
		const job = await call(`/api/org/users/${alice.user.id}/deactivate`, "POST", { mode: "keep", dryRun: false });
		expect(job.status).toBe(202);
		expect(
			await organizationQuery(
				statement("SELECT refresh_retry_json FROM auth_sessions WHERE id = ?", [pendingSession.sessionId], "get"),
			),
		).toEqual({ refresh_retry_json: "[]" });
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

test("effective access reports only the target user's direct and group classification audiences", async () => {
	const root = await claim();
	const { organizationWrite } = await import("./organization-store");
	await organizationWrite([
		statement("INSERT INTO groups(id,name) VALUES ('grp_access','Access')"),
		statement("INSERT INTO group_members(group_id,user_id,role) VALUES ('grp_access',?,'member')", [root.user.id]),
		statement(
			"INSERT INTO classifications(id,name) VALUES ('cls_direct','Direct'),('cls_group','Group'),('cls_hidden','Hidden')",
		),
		statement(
			"INSERT INTO classification_audience(classification_id,principal_kind,principal_id) VALUES ('cls_direct','user',?),('cls_group','group','grp_access')",
			[root.user.id],
		),
	]);
	const response = await call(`/api/org/access/${root.user.id}`);
	expect(response.status).toBe(200);
	const result = await response.json();
	expect(result.readableClassifications.map((item: { id: string }) => item.id).sort()).toEqual([
		"cls_direct",
		"cls_group",
	]);
	expect(result.readableClassifications.every((item: { why: string }) => item.why.length > 0)).toBe(true);
	await organizationWrite([statement("DELETE FROM group_members WHERE group_id='grp_access'")]);
	const revoked = await (await call(`/api/org/access/${root.user.id}`)).json();
	expect(revoked.readableClassifications.map((item: { id: string }) => item.id)).toEqual(["cls_direct"]);
});

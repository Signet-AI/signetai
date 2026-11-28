import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { closeDbAccessor, initDbAccessor, getDbAccessor } from "./db-accessor";
import { closeDbOwner } from "./db-owner-runtime";
import { registerOrganizationRoutes } from "./routes/organization-routes";
import { parseAuthConfig } from "./auth/config";
import { createIdentityMiddleware } from "./auth/identity-middleware";
import { ensureSetupToken, organizationWrite, organizationQuery, statement } from "./auth/organization-store";
import { createApiKey, type CreatedApiKey } from "./auth/api-keys";
import { generateSecret } from "./auth/tokens";

let dir = "";
let app: Hono;
let token = "";
let userId = "";
let groupId = "";
let legacyKeys: CreatedApiKey[] = [];
const oldPath = process.env.SIGNET_PATH;
async function call(path: string, method = "GET", body?: unknown, credential = token) {
	return app.request(path, {
		method,
		headers: { "content-type": "application/json", ...(credential ? { authorization: `Bearer ${credential}` } : {}) },
		...(body === undefined ? {} : { body: JSON.stringify(body) }),
	});
}
beforeEach(async () => {
	dir = mkdtempSync(join(tmpdir(), "organization-upgrade-"));
	process.env.SIGNET_PATH = dir;
	initDbAccessor((await import("@signet/core")).resolveWorkspaceLayout(dir).database, { agentsDir: dir });
	const accessor = getDbAccessor();
	legacyKeys = [0, 1, 2].map((index) =>
		createApiKey(accessor, {
			name: `Legacy ${index}`,
			role: "agent",
			permissions: ["recall", "remember"],
			...(index === 0 ? { agentId: "old-personal", scope: { agent: "old-personal" } } : {}),
		}),
	);
	const config = parseAuthConfig({ mode: "team" }, dir);
	app = new Hono();
	app.use("*", createIdentityMiddleware(config, generateSecret()));
	registerOrganizationRoutes(app, config, dir);
	app.get("/private", (c) => c.json({ userId: c.get("principal")?.userId ?? null }));
	const claimed = await call(
		"/api/org/claim",
		"POST",
		{
			setupToken: await ensureSetupToken(),
			organizationName: "Legacy team",
			admin: { username: "operator", displayName: "Operator", password: "fixture password" },
		},
		"",
	);
	expect(claimed.status).toBe(200);
	token =
		claimed.headers
			.getSetCookie()
			.find((cookie) => cookie.startsWith("signet_session="))
			?.split(";")[0]
			?.slice("signet_session=".length) ?? "";
	userId = (await (await call("/api/auth/whoami")).json()).user.id;
	groupId = (await (await call("/api/org/groups", "POST", { name: "Engineering" })).json()).id;
	await organizationWrite([
		statement("UPDATE api_keys SET legacy=1"),
		statement(
			"INSERT INTO agents(id,name,kind,created_at,updated_at) VALUES ('old-personal','Old personal','legacy',?,?),('old-team','Old team','legacy',?,?)",
			Array(4).fill(new Date().toISOString()),
		),
	]);
	(await import("./organization-upgrade")).startOrganizationUpgradeRuntime();
});
afterEach(async () => {
	await (await import("./organization-upgrade")).stopOrganizationUpgradeRuntime();
	await closeDbOwner();
	await closeDbAccessor();
	rmSync(dir, { recursive: true, force: true });
	if (oldPath === undefined) delete process.env.SIGNET_PATH;
	else process.env.SIGNET_PATH = oldPath;
});
function input() {
	return {
		mappings: [
			{ agentId: "old-personal", kind: "personal", ownerUserId: userId },
			{ agentId: "old-team", kind: "team", ownerGroupId: groupId },
		],
		keys: [],
		legacyKeyDeadline: "2030-01-01T00:00:00.000Z",
	};
}
test("upgrade preview is durable, reversible and has no ownership side effects until exact confirmation", async () => {
	expect((await call("/api/org/agents/old-personal/map", "POST", { kind: "organization" })).status).toBe(403);
	const response = await call("/api/org/upgrade/preview", "POST", input());
	expect(response.status).toBe(201);
	const draft = await response.json();
	expect(draft.phase).toBe("draft");
	expect(draft.preview.agents.map((row: { agentId: string }) => row.agentId)).toEqual(["old-personal", "old-team"]);
	expect((await (await call("/api/org/agents/legacy")).json()).agents).toHaveLength(2);
	const revised = await (
		await call(`/api/org/upgrade/${draft.id}`, "PUT", {
			revision: draft.revision,
			plan: {
				...input(),
				mappings: input().mappings.map((row) =>
					row.agentId === "old-personal" ? { agentId: row.agentId, kind: "organization" } : row,
				),
			},
		})
	).json();
	expect(revised.revision).not.toBe(draft.revision);
	expect((await call(`/api/org/upgrade/${draft.id}/confirm`, "POST", { revision: draft.revision })).status).toBe(409);
	const restored = await (
		await call(`/api/org/upgrade/${draft.id}`, "PUT", { revision: revised.revision, plan: input() })
	).json();
	expect(restored.preview).toEqual(draft.preview);
	await closeDbOwner();
	const recovered = await (await call(`/api/org/upgrade/${draft.id}`)).json();
	expect(recovered.revision).toBe(restored.revision);
	expect(recovered.preview).toEqual(draft.preview);
	expect((await call(`/api/org/upgrade/${draft.id}/cancel`, "POST", { revision: restored.revision })).status).toBe(200);
	expect((await (await call("/api/org/agents/legacy")).json()).agents).toHaveLength(2);
	expect((await call(`/api/org/upgrade/${draft.id}/confirm`, "POST", { revision: restored.revision })).status).toBe(
		409,
	);
	const audit = await (await call("/api/org/audit?action=organization.upgrade_cancelled")).json();
	expect(audit.events).toHaveLength(1);
});

test("upgrade routes deny members and narrowed credentials without exposing job internals", async () => {
	const draft = await (await call("/api/org/upgrade/preview", "POST", input())).json();
	const key = await (
		await call("/api/auth/api-keys", "POST", {
			name: "Narrowed upgrade administrator",
			agentId: "old-personal",
			permissions: ["admin"],
			expiresAt: new Date(Date.now() + 3600_000).toISOString(),
		})
	).json();
	for (const path of ["/api/org/upgrade", `/api/org/upgrade/${draft.id}`, "/api/org/upgrade/nonexistent"])
		expect((await call(path, "GET", undefined, key.secret)).status).toBe(403);
	expect(
		(await call(`/api/org/upgrade/${draft.id}/confirm`, "POST", { revision: draft.revision }, key.secret)).status,
	).toBe(403);
	const invitation = await (await call("/api/org/invites", "POST", { role: "member", groupIds: [] })).json();
	const accepted = await call(
		"/api/auth/invites/accept",
		"POST",
		{
			token: new URL(invitation.inviteUrl).pathname.split("/").pop(),
			username: "member",
			displayName: "Member",
			password: "fixture member password",
		},
		"",
	);
	const memberToken =
		accepted.headers
			.getSetCookie()
			.find((cookie) => cookie.startsWith("signet_session="))
			?.split(";")[0]
			?.slice("signet_session=".length) ?? "";
	expect((await call("/api/org/upgrade", "GET", undefined, memberToken)).status).toBe(403);
	const detailed = await (await call(`/api/org/jobs/${draft.id}`)).json();
	expect(detailed).toEqual(draft);
	expect(JSON.stringify(detailed)).not.toContain("fingerprint");
	expect(JSON.stringify(detailed)).not.toContain("credentialId");
	expect((await call(`/api/org/jobs/${draft.id}`, "GET", undefined, key.secret)).status).toBe(404);
	expect((await call("/api/org/jobs/nonexistent", "GET", undefined, key.secret)).status).toBe(404);
	const list = await (await call("/api/org/jobs", "GET", undefined, key.secret)).json();
	expect(list.jobs.some((job: { id: string }) => job.id === draft.id)).toBe(false);
	expect((await (await call("/api/org/agents/legacy")).json()).agents).toHaveLength(2);
});

test("confirmed upgrade applies exactly the saved plan and preserves evidence and legacy key grace", async () => {
	const assign = legacyKeys[0];
	const revoke = legacyKeys[1];
	const unassigned = legacyKeys[2];
	if (!assign || !revoke || !unassigned) throw new Error("Missing fixture keys");
	await organizationWrite([
		statement(
			"INSERT INTO memories(id,agent_id,content,type,memory_kind,created_at,updated_at) VALUES('legacy-evidence','old-personal','Existing evidence','fact','episodic','2020','2020')",
		),
	]);
	const before = await organizationQuery(statement("SELECT * FROM memories WHERE id='legacy-evidence'", [], "get"));
	expect((await call("/private", "GET", undefined, unassigned.key)).status).toBe(200);
	const draft = await (
		await call("/api/org/upgrade/preview", "POST", {
			...input(),
			keys: [
				{ id: assign.id, action: "assign", userId },
				{ id: revoke.id, action: "revoke" },
			],
		})
	).json();
	const confirmed = await call(`/api/org/upgrade/${draft.id}/confirm`, "POST", { revision: draft.revision });
	expect(confirmed.status).toBe(202);
	let final = await confirmed.json();
	for (let attempt = 0; attempt < 100 && final.status === "running"; attempt++) {
		await Bun.sleep(20);
		final = await (await call(`/api/org/upgrade/${draft.id}`)).json();
	}
	expect(final.status, JSON.stringify(final)).toBe("complete");
	expect(final.appliedPlan).toEqual(draft.preview);
	expect(await organizationQuery(statement("SELECT * FROM memories WHERE id='legacy-evidence'", [], "get"))).toEqual(
		before,
	);
	const roster = (await (await call("/api/agents")).json()).agents;
	expect(roster.find((agent: { id: string }) => agent.id === "old-personal")).toMatchObject({
		kind: "personal",
		ownerUserId: userId,
	});
	expect(roster.find((agent: { id: string }) => agent.id === "old-team")).toMatchObject({
		kind: "team",
		ownerGroupId: groupId,
	});
	expect((await call("/private", "GET", undefined, revoke.key)).status).toBe(401);
	expect(await (await call("/private", "GET", undefined, assign.key)).json()).toMatchObject({ userId });
	expect((await call("/private", "GET", undefined, unassigned.key)).status).toBe(200);
	expect((await (await call("/api/org/settings")).json()).legacyKeyDeadline).toBe(input().legacyKeyDeadline);
	await call("/api/org/settings", "PATCH", { legacyKeyDeadline: "2020-01-01T00:00:00.000Z" });
	expect(await (await call("/private", "GET", undefined, unassigned.key)).json()).toMatchObject({
		reason: "legacy_key_expired",
	});
	expect((await call("/private", "GET", undefined, assign.key)).status).toBe(200);
	expect(
		(await call("/api/auth/login", "POST", { username: "operator", password: "fixture password" }, "")).status,
	).toBe(200);
});

test("stale upgrade inventory refuses confirmation without applying any ownership", async () => {
	const draft = await (await call("/api/org/upgrade/preview", "POST", input())).json();
	await organizationWrite([statement("UPDATE agents SET name='Renamed after preview' WHERE id='old-team'")]);
	expect((await call(`/api/org/upgrade/${draft.id}/confirm`, "POST", { revision: draft.revision })).status).toBe(409);
	expect((await (await call("/api/org/agents/legacy")).json()).agents).toHaveLength(2);
	expect((await (await call(`/api/org/upgrade/${draft.id}`)).json()).phase).toBe("draft");
});

test("upgrade resumes its committed batch cursor after owner restart without duplicate mapping audits", async () => {
	const extra = Array.from({ length: 40 }, (_, index) => `restart-${String(index).padStart(2, "0")}`);
	await organizationWrite(
		extra.map((id) =>
			statement("INSERT INTO agents(id,name,kind,created_at,updated_at) VALUES (?,?,'legacy','2020','2020')", [id, id]),
		),
	);
	const draft = await (
		await call("/api/org/upgrade/preview", "POST", {
			...input(),
			mappings: [...input().mappings, ...extra.map((agentId) => ({ agentId, kind: "team", ownerGroupId: groupId }))],
		})
	).json();
	expect((await call(`/api/org/upgrade/${draft.id}/confirm`, "POST", { revision: draft.revision })).status).toBe(202);
	let checkpoint = await (await call(`/api/org/upgrade/${draft.id}`)).json();
	for (let attempt = 0; attempt < 100 && checkpoint.completedSteps === 0; attempt++) {
		await Bun.sleep(5);
		checkpoint = await (await call(`/api/org/upgrade/${draft.id}`)).json();
	}
	expect(checkpoint.completedSteps).toBeGreaterThan(0);
	expect(checkpoint.status).toBe("running");
	await (await import("./organization-upgrade")).stopOrganizationUpgradeRuntime();
	await closeDbOwner();
	const recovered = await (await call(`/api/org/upgrade/${draft.id}`)).json();
	expect(recovered.completedSteps).toBeGreaterThanOrEqual(checkpoint.completedSteps);
	expect(recovered.status).toBe("running");
	(await import("./organization-upgrade")).startOrganizationUpgradeRuntime();
	let completed = recovered;
	for (let attempt = 0; attempt < 100 && completed.status === "running"; attempt++) {
		await Bun.sleep(10);
		completed = await (await call(`/api/org/upgrade/${draft.id}`)).json();
	}
	expect(completed.status, JSON.stringify(completed)).toBe("complete");
	expect(completed.appliedPlan).toEqual(draft.preview);
	const audit = await (await call("/api/org/audit?action=agent.mapped&limit=100")).json();
	expect(audit.events).toHaveLength(42);
	expect(new Set(audit.events.map((event: { target_id: string }) => event.target_id)).size).toBe(42);
});

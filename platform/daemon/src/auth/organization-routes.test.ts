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
	admin = result.accessToken;
	return result;
}
beforeEach(async () => {
	dir = mkdtempSync(join(tmpdir(), "org-routes-"));
	initDbAccessor(join(dir, "data.db"), { agentsDir: dir });
	setup = (await ensureSetupToken()) ?? "";
	admin = "";
	app = new Hono();
	app.use("*", createIdentityMiddleware(config, generateSecret()));
	registerOrganizationRoutes(app, config);
	app.post("/write", (c) => c.json({ written: true }));
});
afterEach(async () => {
	await (await import("../db-owner-runtime")).closeDbOwner();
	Bun.gc(true);
	await closeDbAccessor();
	rmSync(dir, { recursive: true, force: true });
});
describe("organization HTTP flows", () => {
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
		const who = await call("/api/auth/whoami", "GET", undefined, key.secret);
		expect(who.status).toBe(200);
		expect(await who.json()).toMatchObject({ user: { username: "alice" }, credential: { harness: "hermes-agent" } });
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
		expect((await call("/api/auth/refresh", "POST", { refreshToken: session.refreshToken }, "")).status).toBe(401);
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

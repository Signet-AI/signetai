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

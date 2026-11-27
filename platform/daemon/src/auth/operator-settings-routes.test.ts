import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { closeDbAccessor, initDbAccessor } from "../db-accessor";
import { registerOrganizationRoutes } from "../routes/organization-routes";
import { parseAuthConfig } from "./config";
import { createIdentityMiddleware } from "./identity-middleware";
import { ensureSetupToken } from "./organization-store";
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
describe("constrained operator settings", () => {
	test("administrator settings round-trip through a strict projection and audited owner", async () => {
		writeFileSync(join(dir, "agent.yaml"), "configVersion: 1\nauth:\n  mode: team\nembedding:\n  provider: none\n");
		await claim();
		expect((await call("/api/org/operator/settings")).status).toBe(200);
		const inference = {
			provider: "openai-compatible",
			model: "fixture-model",
			endpoint: "http://127.0.0.1:1234/v1",
			credentialRef: null,
			allowRemote: false,
		};
		expect((await call("/api/org/operator/settings", "PATCH", { section: "inference", value: inference })).status).toBe(
			200,
		);
		const embedding = { provider: "none", model: "", dimensions: 768, endpoint: null, credentialRef: null };
		expect((await call("/api/org/operator/settings", "PATCH", { section: "embedding", value: embedding })).status).toBe(
			200,
		);
		expect(
			(
				await call("/api/org/operator/settings", "PATCH", {
					section: "instructions",
					value: "Use reproducible examples.",
				})
			).status,
		).toBe(200);
		expect(
			(
				await call("/api/org/operator/settings", "PATCH", {
					section: "sourcesDefaults",
					value: { agentId: "default", classificationId: null },
				})
			).status,
		).toBe(200);
		expect((await call("/api/org/operator/settings", "PATCH", { section: "complete", value: true })).status).toBe(200);
		const result = await (await call("/api/org/operator/settings")).json();
		expect(result).toEqual({
			inference,
			embedding,
			instructions: "Use reproducible examples.",
			sourcesDefaults: { agentId: "default", classificationId: null },
			complete: true,
		});
		expect(readFileSync(join(dir, "AGENTS.md"), "utf8")).toBe("Use reproducible examples.");
		expect(JSON.stringify(result)).not.toContain("auth");
		const audit = await (await call("/api/org/audit?action=operator.settings_updated")).json();
		expect(audit.events).toHaveLength(5);
		expect(JSON.stringify(audit)).not.toContain("Use reproducible examples.");
		await (await import("../db-owner-runtime")).closeDbOwner();
		expect(await (await call("/api/org/operator/settings")).json()).toEqual(result);
	});
	test("members, compliance and agent keys cannot read or change instance settings", async () => {
		writeFileSync(join(dir, "agent.yaml"), "embedding:\n  provider: none\n");
		await claim();
		const alice = await member("operator-settings-alice");
		const key = await (
			await call(
				"/api/auth/api-keys",
				"POST",
				{
					name: "agent settings denied",
					permissions: ["recall"],
					expiresAt: new Date(Date.now() + 60000).toISOString(),
				},
				alice.token,
			)
		).json();
		for (const token of [alice.token, key.secret])
			for (const method of ["GET", "PATCH"])
				expect(
					(
						await call(
							"/api/org/operator/settings",
							method,
							method === "PATCH" ? { section: "instructions", value: "Never written" } : undefined,
							token,
						)
					).status,
				).toBe(403);
		expect((await call(`/api/org/users/${alice.userId}`, "PATCH", { compliance: true })).status).toBe(200);
		for (const method of ["GET", "PATCH"])
			expect(
				(
					await call(
						"/api/org/operator/settings",
						method,
						method === "PATCH" ? { section: "complete", value: true } : undefined,
						alice.token,
					)
				).status,
			).toBe(403);
		const adminKey = await (
			await call("/api/auth/api-keys", "POST", {
				name: "admin settings key denied",
				permissions: ["admin"],
				expiresAt: new Date(Date.now() + 60000).toISOString(),
			})
		).json();
		expect((await call("/api/org/operator/settings", "GET", undefined, adminKey.secret)).status).toBe(403);
		expect(readFileSync(join(dir, "agent.yaml"), "utf8")).toBe("embedding:\n  provider: none\n");
	});
	test("secret references are verified without returning or writing secret values", async () => {
		writeFileSync(join(dir, "agent.yaml"), "embedding:\n  provider: none\n");
		await claim();
		const secrets = await import("../secrets");
		const check = spyOn(secrets, "hasSecret").mockResolvedValue(true);
		try {
			const value = {
				provider: "openai",
				model: "fixture-model",
				endpoint: null,
				credentialRef: "SIGNET_OPERATOR_TEST",
				allowRemote: true,
			};
			const saved = await call("/api/org/operator/settings", "PATCH", { section: "inference", value });
			expect(saved.status).toBe(200);
			expect((await saved.json()).inference).toEqual(value);
			expect(check).toHaveBeenCalledWith("SIGNET_OPERATOR_TEST");
			const config = readFileSync(join(dir, "agent.yaml"), "utf8");
			expect(config).toContain("credentialRef: SIGNET_OPERATOR_TEST");
			expect(config).not.toContain("apiKey:");
			check.mockResolvedValue(false);
			expect((await call("/api/org/operator/settings", "PATCH", { section: "inference", value })).status).toBe(400);
			expect(readFileSync(join(dir, "agent.yaml"), "utf8")).toBe(config);
		} finally {
			check.mockRestore();
		}
	});
	test("unlisted settings, inline secrets, credential URLs and oversized instructions are rejected before publication", async () => {
		writeFileSync(join(dir, "agent.yaml"), "embedding:\n  provider: none\n");
		await claim();
		const original = readFileSync(join(dir, "agent.yaml"), "utf8");
		const base = {
			provider: "openai-compatible",
			model: "fixture",
			endpoint: "http://127.0.0.1:1234/v1",
			credentialRef: null,
			allowRemote: false,
		};
		for (const body of [
			{ section: "auth", value: { mode: "local" } },
			{ section: "inference", value: { ...base, apiKey: "never-stored" } },
			{ section: "inference", value: { ...base, credentialRef: "sk-not-a-secret-reference" } },
			{ section: "inference", value: { ...base, endpoint: "https://user:password@example.com/v1" } },
			{ section: "inference", value: { ...base, endpoint: "https://example.com/v1?key=never-stored" } },
			{ section: "inference", value: { ...base, endpoint: "https://example.com/v1" } },
			{
				section: "embedding",
				value: {
					provider: "openai",
					model: "x",
					dimensions: 1536,
					endpoint: "https://api.openai.com/v1",
					credentialRef: "raw-secret",
				},
			},
			{ section: "instructions", value: "x".repeat(65537) },
			{ section: "complete", value: true, userId: "another" },
		])
			expect((await call("/api/org/operator/settings", "PATCH", body)).status).toBe(400);
		expect(readFileSync(join(dir, "agent.yaml"), "utf8")).toBe(original);
	});
});

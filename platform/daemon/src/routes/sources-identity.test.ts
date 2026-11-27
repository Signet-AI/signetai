import { afterEach, beforeEach, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addObsidianSource, addImportedSource, loadSourcesConfig } from "@signet/core";
import { Hono } from "hono";
import { bindPrincipalAccess } from "../auth/agent-access";
import { readOrganization } from "../auth/organization-store";
import { localPrincipal, type Principal } from "../auth/principal";
import { closeDbAccessor, initDbAccessor } from "../db-accessor";
import { clearSourceIndexProgressForTests } from "../source-index-progress";
import { registerSourcesRoutes } from "./sources-routes";
import { registerImportRoutes } from "./import-routes";
import { resolveScopedAgentId } from "./utils";

let dir = "";
let vault = "";
let oldPath: string | undefined;
let oldAgent: string | undefined;
beforeEach(async () => {
	dir = mkdtempSync(join(tmpdir(), "signet-source-identity-"));
	vault = join(dir, "vault");
	mkdirSync(vault);
	oldPath = process.env.SIGNET_PATH;
	oldAgent = process.env.SIGNET_AGENT_ID;
	process.env.SIGNET_PATH = dir;
	process.env.SIGNET_AGENT_ID = "daemon-agent";
	await closeDbAccessor();
	initDbAccessor(join(dir, "test.db"));
});
afterEach(async () => {
	clearSourceIndexProgressForTests();
	await closeDbAccessor();
	if (oldPath === undefined) Reflect.deleteProperty(process.env, "SIGNET_PATH");
	else process.env.SIGNET_PATH = oldPath;
	if (oldAgent === undefined) Reflect.deleteProperty(process.env, "SIGNET_AGENT_ID");
	else process.env.SIGNET_AGENT_ID = oldAgent;
	rmSync(dir, { recursive: true, force: true });
});
function app(role: "admin" | "member", admitted = true): Hono {
	const principal: Principal = {
		...localPrincipal(),
		kind: "user",
		userId: "alice",
		role,
		credential: { kind: "session", id: "alice-session" },
	};
	bindPrincipalAccess(principal, {
		agentModel: "personal",
		personalAgentsSelfService: true,
		organizationAgentId: "default",
		personalAgentId: "alice-agent",
		defaultReadAgentId: "alice-agent",
		agents: [{ id: "alice-agent", kind: "personal", owner_user_id: "alice", owner_group_id: null, archived_at: null }],
	});
	const instance = new Hono();
	instance.use("*", async (c, next) => {
		c.set("principal", principal);
		c.set("organization", { ...(await readOrganization()), claimed_at: new Date().toISOString() });
		if (admitted) c.set("author", { userId: "alice", credential: "session:alice-session" });
		await next();
	});
	registerSourcesRoutes(instance, {
		agentsDir: dir,
		startBridge: () => ({
			syncExisting: async () => 0,
			getLastSyncResult: () => ({ status: "complete", scanned: 0, indexed: 0, pausedSources: [] }),
			cancel: () => {},
			close: async () => {},
		}),
		purgeNativeSource: async () => 0,
	});
	return instance;
}
function legacySource() {
	const added = addObsidianSource({ root: vault }, dir);
	if (!added.ok) throw new Error(added.error);
	return added.source;
}
it("hides legacy source reads from organization members", async () => {
	const source = legacySource();
	const member = app("member");
	const listed = await member.request("/api/sources");
	expect(await listed.json()).toMatchObject({ sources: [] });
	for (const suffix of ["health", "snapshot"])
		expect((await member.request(`/api/sources/${encodeURIComponent(source.id)}/${suffix}`)).status).toBe(404);
	expect((await (await app("admin").request("/api/sources")).json()).sources).toHaveLength(1);
});
it("denies member deletion of legacy sources without identity", async () => {
	const source = legacySource();
	expect(
		(await app("member").request(`/api/sources/${encodeURIComponent(source.id)}`, { method: "DELETE" })).status,
	).toBe(403);
	expect(loadSourcesConfig(dir).sources).toHaveLength(1);
});
it("denies member resync of legacy sources without identity", async () => {
	legacySource();
	expect(
		(
			await app("member").request("/api/sources/obsidian", {
				method: "POST",
				body: JSON.stringify({ root: vault }),
				headers: { "content-type": "application/json" },
			})
		).status,
	).toBe(403);
});
it("admin re-add adopts legacy source identity", async () => {
	legacySource();
	const response = await app("admin").request("/api/sources/obsidian", {
		method: "POST",
		body: JSON.stringify({ root: vault }),
		headers: { "content-type": "application/json" },
	});
	expect(response.status).toBe(202);
	expect(loadSourcesConfig(dir).sources[0]?.writeIdentity).toEqual({
		agentId: "alice-agent",
		authorUserId: "alice",
		authorCredential: "session:alice-session",
	});
});
it("redacts source identity from list and health responses", async () => {
	const added = addObsidianSource(
		{
			root: vault,
			writeIdentity: { agentId: "alice-agent", authorUserId: "alice", authorCredential: "session:private-credential" },
		},
		dir,
	);
	if (!added.ok) throw new Error(added.error);
	for (const path of ["/api/sources", `/api/sources/${encodeURIComponent(added.source.id)}/health`]) {
		const response = await app("admin").request(path);
		expect(response.status).toBe(200);
		const text = await response.text();
		expect(text).not.toContain("writeIdentity");
		expect(text).not.toContain("authorCredential");
		expect(text).not.toContain("private-credential");
	}
});
it("source reads use principal agent reach", async () => {
	const added = addImportedSource(
		{
			fileName: "alice.md",
			contentHash: "a".repeat(64),
			format: "markdown",
			agentId: "alice-agent",
			writeIdentity: { agentId: "alice-agent", authorUserId: "alice", authorCredential: "session:alice-session" },
		},
		dir,
	);
	if (!added.ok) throw new Error(added.error);
	const instance = app("member");
	expect((await instance.request(`/api/sources/${encodeURIComponent(added.source.id)}/health`)).status).toBe(200);
	const response = await instance.request("/api/sources");
	expect(await response.text()).toContain(added.source.id);
});
it("rejects source writes without admitted author", async () => {
	const response = await app("admin", false).request("/api/sources/obsidian", {
		method: "POST",
		body: JSON.stringify({ root: vault }),
		headers: { "content-type": "application/json" },
	});
	expect(response.status).toBe(403);
	expect(loadSourcesConfig(dir).sources).toHaveLength(0);
});
it("keeps the shared resolver default independent of daemon configuration", async () => {
	const instance = new Hono();
	instance.get("/", (c) => c.json(resolveScopedAgentId(c, undefined)));
	expect(await (await instance.request("/")).json()).toEqual({ agentId: "default" });
});

it("rejects document imports without admitted author before admission", async () => {
	const instance = app("admin", false);
	let admissions = 0;
	registerImportRoutes(instance, {
		durableImportAdmission: {
			admit: async () => {
				admissions++;
				throw new Error("unexpected admission");
			},
			begin: async () => {},
			complete: async () => {},
		},
	});
	const form = new FormData();
	form.append("files", new File(["# Evidence"], "note.md"));
	expect((await instance.request("/api/sources/import", { method: "POST", body: form })).status).toBe(403);
	expect(admissions).toBe(0);
});
it("redacts identity from source creation and deletion responses", async () => {
	const instance = app("admin");
	const response = await instance.request("/api/sources/obsidian", {
		method: "POST",
		body: JSON.stringify({ root: vault }),
		headers: { "content-type": "application/json" },
	});
	expect(response.status).toBe(202);
	expect(await response.text()).not.toContain("writeIdentity");
	const source = loadSourcesConfig(dir).sources[0];
	if (!source) throw new Error("source missing");
	const removed = await instance.request(`/api/sources/${encodeURIComponent(source.id)}`, { method: "DELETE" });
	expect([200, 202]).toContain(removed.status);
	expect(await removed.text()).not.toContain("writeIdentity");
});

it("document imports persist their admitted source identity", async () => {
	const instance = app("member");
	registerImportRoutes(instance, {
		durableImportAdmission: {
			admit: async ({ fileName, bytes }) => ({
				key: fileName,
				originalPath: join(dir, fileName),
				sha256: "test",
				size: bytes.byteLength,
			}),
			begin: async () => {},
			complete: async () => {},
		},
	});
	const form = new FormData();
	form.append("files", new File(["# Evidence\n\nImported evidence."], "note.md"));
	expect((await instance.request("/api/sources/import", { method: "POST", body: form })).status).toBe(201);
	expect(loadSourcesConfig(dir).sources[0]?.writeIdentity).toEqual({
		agentId: "alice-agent",
		authorUserId: "alice",
		authorCredential: "session:alice-session",
	});
});

it("rejects organization source reads without an admitted principal", async () => {
	const instance = new Hono();
	instance.use("*", async (c, next) => {
		c.set("organization", { ...(await readOrganization()), claimed_at: new Date().toISOString() });
		await next();
	});
	registerSourcesRoutes(instance, { agentsDir: dir });
	expect((await instance.request("/api/sources")).status).toBe(401);
});

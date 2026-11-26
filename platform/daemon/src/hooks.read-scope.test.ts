import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ReadScope, compartmentFor } from "@signet/core";
import { Hono } from "hono";
import { getSyncDbAccessor } from "../legacy-sync/db-accessor-sync";
import { bindPrincipalAccess, principalAccess } from "./auth/agent-access";
import type {} from "./auth/identity-middleware";
import type { OrganizationRow } from "./auth/organization-store";
import { type Principal, localPrincipal, rolePermissions } from "./auth/principal";

const previousSignetPath = process.env.SIGNET_PATH;
const agentsDir = mkdtempSync(join(tmpdir(), "signet-hooks-read-scope-"));
const memoryDbPath = join(agentsDir, "memory", "memories.db");
process.env.SIGNET_PATH = agentsDir;
mkdirSync(join(agentsDir, "memory"), { recursive: true });

const { closeDbAccessor, initDbAccessor } = await import("./db-accessor");
const { handlePreCompaction, handleSessionStart, handleUserPromptSubmit } = await import("./hooks");
const { loadMemoryConfig } = await import("./memory-config");
const { resolveHookReadScope } = await import("./hook-read-scope");
const { registerHooksRoutes } = await import("./routes/hooks-routes");

let hr = 0;
const outside = (): ReadScope => ({ reach: { kind: "own", agentId: "default" }, compartments: [], projects: null });
const inside = (): ReadScope => ({ ...outside(), compartments: [hr] });
const at = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60_000).toISOString();

function write(sql: string, ...args: (string | number | null)[]): void {
	getSyncDbAccessor().withWriteTx((db) => {
		db.prepare(sql).run(...args);
	});
}

function memory(id: string, content: string, minutesAgo: number, compartment: number | null, pinned = 0): void {
	write(
		`INSERT INTO memories (id, content, type, importance, pinned, project, agent_id, visibility, compartment_id, created_at, updated_at, updated_by)
		 VALUES (?, ?, 'fact', 0.9, ?, '/repo', 'default', 'global', ?, ?, ?, 'test')`,
		id,
		content,
		pinned,
		compartment,
		at(minutesAgo),
		at(minutesAgo),
	);
}

function transcript(sessionKey: string, content: string, minutesAgo: number, compartment: number | null): void {
	write(
		`INSERT INTO session_transcripts (session_key, content, harness, project, agent_id, compartment_id, created_at, updated_at, completed_at)
		 VALUES (?, ?, 'codex', '/repo', 'default', ?, ?, ?, ?)`,
		sessionKey,
		content,
		compartment,
		at(minutesAgo),
		at(minutesAgo),
		at(minutesAgo),
	);
}

function entity(id: string, name: string, type: string, compartment: number | null): void {
	write(
		`INSERT INTO entities (id, name, canonical_name, entity_type, agent_id, mentions, pinned, compartment_id, created_at, updated_at)
		 VALUES (?, ?, ?, ?, 'default', 10, 1, ?, ?, ?)`,
		id,
		name,
		name.toLowerCase(),
		type,
		compartment,
		at(30),
		at(30),
	);
}

function head(revision: number, entries: readonly { id: string; text: string; compartment: number | null }[]): void {
	const content = entries.map((entry) => `- ${entry.text}`).join("\n");
	const revisionId = `rev-${revision}`;
	write(
		`INSERT INTO memory_head_revisions (id, agent_id, revision, content, content_hash, rendered_token_count, pass_id, base_revision, base_hash, created_at)
		 VALUES (?, 'default', ?, ?, ?, 1, 'fixture-pass', ?, '', ?)`,
		revisionId,
		revision,
		content,
		`hash-${revision}`,
		revision - 1,
		at(1),
	);
	for (const [ordinal, entry] of entries.entries()) {
		write(
			`INSERT INTO memories(id,content,type,memory_kind,agent_id,compartment_id,created_at,updated_at,updated_by) VALUES (?,?,'fact','episodic','default',?,?,?,'fixture') ON CONFLICT(id) DO NOTHING`,
			`support-${entry.id}`,
			entry.text,
			entry.compartment,
			at(60),
			at(60),
		);
		write(
			`INSERT INTO memory_head_entries (entry_id, agent_id, canonical_text, entry_hash, status, first_revision, last_revision, compartment_id, created_at, updated_at)
			 VALUES (?, 'default', ?, ?, 'active', ?, ?, ?, ?, ?)
			 ON CONFLICT(agent_id, entry_id) DO UPDATE SET last_revision=excluded.last_revision`,
			entry.id,
			entry.text,
			entry.id,
			revision,
			revision,
			entry.compartment,
			at(1),
			at(1),
		);
		write(
			`INSERT INTO memory_head_revision_entries (agent_id, revision, entry_id, ordinal, operation, provenance_json, compartment_id)
			 VALUES ('default', ?, ?, ?, 'add', ?, ?)`,
			revision,
			entry.id,
			ordinal,
			JSON.stringify([{ source_ref: `memory:support-${entry.id}`, quote: entry.text }]),
			entry.compartment,
		);
	}
	write(
		`INSERT INTO memory_md_heads (agent_id, content, content_hash, revision, revision_id, updated_at, is_current)
		 VALUES ('default', ?, ?, ?, ?, ?, 1)
		 ON CONFLICT(agent_id) DO UPDATE SET content=excluded.content, content_hash=excluded.content_hash, revision=excluded.revision, revision_id=excluded.revision_id, is_current=1`,
		content,
		`hash-${revision}`,
		revision,
		revisionId,
		at(1),
	);
}

function seedVisible(): void {
	memory("visible-atlas", "Atlas launch is planned for spring.", 60, null);
	entity("ent-atlas", "Atlas", "project", null);
	transcript("visible-session", "Atlas planning planning call about launch launch.", 50, null);
	write(
		`INSERT INTO session_checkpoints (id, session_key, harness, project, project_normalized, trigger, digest, prompt_count, agent_id, created_at)
		 VALUES ('cp-visible', 'visible-session', 'codex', '/repo', '/repo', 'periodic', 'Visible recovery digest.', 1, 'default', ?)`,
		at(40),
	);
	head(1, [{ id: "visible-head", text: "Visible head entry.", compartment: null }]);
}

function seedHidden(): void {
	memory("hidden-atlas", "HRSECRET Atlas salary review.", 5, hr, 1);
	memory("hidden-zephyr", "Zephyr HRSECRET compensation plan.", 4, hr, 1);
	entity("ent-zephyr", "Zephyr", "person", hr);
	transcript("hidden-session", "HRSECRET payroll payroll ledger ledger launch launch.", 3, hr);
	write(
		`INSERT INTO session_checkpoints (id, session_key, harness, project, project_normalized, trigger, digest, prompt_count, agent_id, compartment_id, created_at)
		 VALUES ('cp-hidden', 'hidden-session', 'codex', '/repo', '/repo', 'periodic', 'HRSECRET recovery digest.', 1, 'default', ?, ?)`,
		hr,
		at(2),
	);
	head(2, [
		{ id: "visible-head", text: "Visible head entry.", compartment: null },
		{ id: "hidden-head", text: "HRSECRET head entry.", compartment: hr },
	]);
}

function promptDeps() {
	return {
		fetchEmbedding: async () => null,
		loadMemoryConfig: (dir: string) => {
			const cfg = loadMemoryConfig(dir);
			return { ...cfg, embedding: { ...cfg.embedding, promptSubmitTimeoutMs: 20_000 } };
		},
	};
}

async function sessionStart(sessionKey: string, scope: ReadScope): Promise<string> {
	const result = await handleSessionStart(
		{
			author: { userId: null, credential: "local" },
			harness: "codex",
			sessionKey,
			project: "/repo",
			parentSessionKey: "hidden-session",
		},
		scope,
	);
	return result.inject.replaceAll(sessionKey, "<session>");
}

async function prompt(sessionKey: string, userMessage: string, scope: ReadScope) {
	return await handleUserPromptSubmit(
		{ author: { userId: null, credential: "local" }, harness: "codex", sessionKey, userMessage },
		promptDeps(),
		{
			readScope: scope,
		},
	);
}

const organization: OrganizationRow = {
	id: 1,
	name: "Acme",
	claimed_at: "2026-01-01T00:00:00.000Z",
	claimed_by: null,
	setup_token_hash: null,
	agent_model: "single",
	personal_agents_self_service: 1,
	password_login: 1,
	require_sso: 0,
	session_ttl_seconds: 604800,
	refresh_ttl_seconds: 2592000,
	access_ttl_seconds: 3600,
	connector_key_ttl_seconds: 2592000,
	legacy_key_deadline: null,
	oidc_json: null,
	audit_retention_days: 365,
	public_url: null,
};

function user(userId: string): Principal {
	const principal: Principal = {
		kind: "user",
		userId,
		role: "member",
		permissions: rolePermissions("member"),
		compliance: false,
		groupIds: [],
		credential: { kind: "session", id: `ses_${userId}` },
		sessionId: `ses_${userId}`,
		deviceId: null,
		harness: null,
		boundAgentId: null,
		allowedProjects: null,
	};
	bindPrincipalAccess(principal, {
		agentModel: "single",
		personalAgentsSelfService: true,
		organizationAgentId: "default",
		personalAgentId: null,
		defaultReadAgentId: null,
		agents: [
			{ id: "default", kind: "organization", owner_user_id: null, owner_group_id: null, archived_at: null },
			{ id: `${userId}-personal`, kind: "personal", owner_user_id: userId, owner_group_id: null, archived_at: null },
		],
	});
	return principal;
}

function organizationApp(principal: Principal | null, org: OrganizationRow | null): Hono {
	const app = new Hono();
	app.use(async (c, next) => {
		c.set("organization", org);
		if (principal) {
			c.set("principal", principal);
			c.set("author", { userId: principal.userId, credential: principal.credential.id });
		}
		await next();
	});
	app.get("/scope/:agent", async (c) =>
		c.json(await resolveHookReadScope(c, c.req.param("agent"), { useDefaultReadAgent: c.req.query("mixed") === "1" })),
	);
	registerHooksRoutes(app);
	return app;
}

describe("hook injection read scope", () => {
	let beforeSessionStart = "";
	let beforePrompt: Awaited<ReturnType<typeof prompt>> | null = null;

	beforeAll(async () => {
		initDbAccessor(memoryDbPath, { agentsDir });
		hr =
			getSyncDbAccessor().withWriteTx((db) => {
				db.prepare(
					"INSERT INTO classifications (id, name, created_at, updated_at) VALUES ('cls_hr', 'HR', datetime('now'), datetime('now'))",
				).run();
				db.prepare(
					"INSERT INTO classification_audience (classification_id, principal_kind, principal_id) VALUES ('cls_hr', 'user', 'usr_alice')",
				).run();
				return compartmentFor(db, ["cls_hr"]);
			}) ?? 0;
		seedVisible();
		beforeSessionStart = await sessionStart("start-before", outside());
		beforePrompt = await prompt("prompt-before", "Tell me about Atlas", outside());
		seedHidden();
	});

	afterAll(async () => {
		await closeDbAccessor();
		if (previousSignetPath === undefined) Reflect.deleteProperty(process.env, "SIGNET_PATH");
		else process.env.SIGNET_PATH = previousSignetPath;
		rmSync(agentsDir, { recursive: true, force: true });
	});

	it("keeps session-start injection identical for a reader outside the audience", async () => {
		const after = await sessionStart("start-after", outside());
		expect(after).not.toContain("HRSECRET");
		expect(after).toContain("Visible head entry.");
		expect(after).toContain("Visible recovery digest.");
		expect(after).toBe(beforeSessionStart);
	});

	it("injects classified session-start material for an audience member", async () => {
		const audience = await sessionStart("start-audience", inside());
		expect(audience).toContain("HRSECRET head entry.");
		expect(audience).toContain("HRSECRET recovery digest.");
		expect(audience).toContain("HRSECRET payroll");
	});

	it("keeps prompt-submit recall identical and ignores hidden entities outside the audience", async () => {
		const after = await prompt("prompt-after", "Tell me about Atlas", outside());
		expect(after.inject).not.toContain("HRSECRET");
		expect(after.inject).toBe(beforePrompt?.inject ?? "missing");
		expect(after.memoryCount).toBe(beforePrompt?.memoryCount ?? -1);
		const hiddenEntity = await prompt("prompt-zephyr-outside", "What about Zephyr?", outside());
		expect(hiddenEntity.inject).toBe("");
		expect(hiddenEntity.memoryCount).toBe(0);
	});

	it("recalls classified entities and memories for an audience member", async () => {
		const audience = await prompt("prompt-zephyr-inside", "What about Zephyr?", inside());
		expect(audience.inject).toContain("Zephyr HRSECRET compensation plan.");
	});

	it("uses the default read agent rather than a redirected personal write agent", async () => {
		const principal = user("usr_alice");
		const access = principalAccess(principal);
		if (!access) throw new Error("Missing test principal access");
		bindPrincipalAccess(principal, { ...access, agentModel: "personal", personalAgentId: "usr_alice-personal" });
		const app = organizationApp(principal, { ...organization, agent_model: "personal" });
		const response = await app.request("/scope/usr_alice-personal?mixed=1");
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({ reach: { kind: "all" } });
	});

	it("scopes pre-compaction recent memories", async () => {
		const outsidePrompt = (
			await handlePreCompaction(
				{ author: { userId: null, credential: "local" }, harness: "codex", sessionKey: "compact-outside" },
				outside(),
			)
		).summaryPrompt;
		expect(outsidePrompt).toContain("Atlas launch is planned for spring.");
		expect(outsidePrompt).not.toContain("HRSECRET");
		expect(
			(
				await handlePreCompaction(
					{ author: { userId: null, credential: "local" }, harness: "codex", sessionKey: "compact-inside" },
					inside(),
				)
			).summaryPrompt,
		).toContain("HRSECRET");
	});

	it("resolves the hook read scope from the authenticated principal", async () => {
		const read = async (app: Hono, agent: string) => await (await app.request(`/scope/${agent}`)).json();
		expect(await read(organizationApp(user("usr_alice"), organization), "default")).toEqual({
			reach: { kind: "all" },
			compartments: [hr],
			projects: null,
		});
		expect(await read(organizationApp(user("usr_alice"), organization), "usr_alice-personal")).toMatchObject({
			reach: { kind: "own", agentId: "usr_alice-personal" },
			compartments: [hr],
		});
		expect(await read(organizationApp(user("usr_bob"), organization), "default")).toMatchObject({
			reach: { kind: "all" },
			compartments: [],
		});
		expect(await read(organizationApp(localPrincipal(), null), "default")).toEqual({
			reach: { kind: "shared", agentId: "default" },
			compartments: "all",
			projects: null,
		});
		expect(await read(organizationApp(null, null), "default")).toMatchObject({ compartments: [] });
	});

	it("applies the principal's scope at the session-start route boundary", async () => {
		const start = async (principal: Principal, sessionKey: string) => {
			const response = await organizationApp(principal, organization).request("/api/hooks/session-start", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ harness: "codex", sessionKey, project: "/repo" }),
			});
			expect(response.status).toBe(200);
			const body: unknown = await response.json();
			return typeof body === "object" && body !== null ? String(Reflect.get(body, "inject")) : "";
		};
		expect(await start(user("usr_bob"), "route-bob")).not.toContain("HRSECRET");
		expect(await start(user("usr_alice"), "route-alice")).toContain("HRSECRET");
	});
});

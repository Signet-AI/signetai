import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Hono } from "hono";

const previousSignetPath = process.env.SIGNET_PATH;
const NOW = "2026-07-06T00:00:00.000Z";
let agentsDir: string;
let appFactory: typeof import("hono").Hono;
let registerMemoryRoutes: typeof import("./memory-routes").registerMemoryRoutes;
let initDbAccessor: typeof import("../db-accessor").initDbAccessor;
let closeDbAccessor: typeof import("../db-accessor").closeDbAccessor;
let getDbAccessor: typeof import("../db-accessor").getDbAccessor;
let invalidateAgentScopeCache: typeof import("../agent-id").invalidateAgentScopeCache;
let createAuthMiddleware: typeof import("../auth").createAuthMiddleware;
let createToken: typeof import("../auth").createToken;
let state: typeof import("./state.js");

interface MemoryListBody {
	readonly memories: ReadonlyArray<{ readonly id: string; readonly agent_id: string }>;
	readonly stats: { readonly total: number; readonly withEmbeddings: number; readonly critical: number };
	readonly error?: string;
}

function writeAuthConfig(mode: "local" | "team"): void {
	writeFileSync(join(agentsDir, "agent.yaml"), `embedding:\n  provider: none\nauth:\n  mode: ${mode}\n`);
}

async function makeApp(mode: "local" | "team"): Promise<Hono> {
	writeAuthConfig(mode);
	state.reloadAuthState(agentsDir);
	const app = new appFactory();
	if (mode === "team") {
		if (!state.authSecret) throw new Error("expected auth secret in team mode");
		app.use("*", createAuthMiddleware(state.authConfig, state.authSecret));
	}
	registerMemoryRoutes(app, { fetchEmbedding: async () => null });
	return app;
}

function teamToken(scope: { agent?: string; project?: string }): string {
	if (!state.authSecret) throw new Error("expected auth secret");
	return createToken(state.authSecret, { sub: "memory-list-test", role: "operator", scope }, 60);
}

function seedAgent(id: string, readPolicy: "isolated" | "shared" | "group", policyGroup: string | null = null): void {
	getDbAccessor().withWriteTx((db) => {
		db.prepare(
			`INSERT INTO agents (id, name, read_policy, policy_group, created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, ?)`,
		).run(id, id, readPolicy, policyGroup, NOW, NOW);
	});
}

function seedMemory(
	id: string,
	agentId: string,
	options: {
		readonly visibility?: string;
		readonly type?: string;
		readonly importance?: number;
		readonly embedded?: boolean;
		readonly contentHash?: string;
	} = {},
): void {
	getDbAccessor().withWriteTx((db) => {
		db.prepare(
			`INSERT INTO memories (id, type, content, content_hash, importance, created_at, updated_at, updated_by, agent_id, visibility)
			 VALUES (?, ?, ?, ?, ?, ?, ?, 'test', ?, ?)`,
		).run(
			id,
			options.type ?? "fact",
			`content for ${id}`,
			options.contentHash ?? null,
			options.importance ?? 0.5,
			NOW,
			NOW,
			agentId,
			options.visibility ?? "global",
		);
		if (options.embedded) {
			db.prepare(
				`INSERT INTO embeddings (id, content_hash, vector, dimensions, source_type, source_id, chunk_text, created_at, agent_id)
				 VALUES (?, ?, ?, 1, 'memory', ?, 'chunk', ?, ?)`,
			).run(`${id}-emb`, `${id}-hash`, new Uint8Array(4), id, NOW, agentId);
		}
	});
}

async function list(app: Hono, query: string, headers: Record<string, string> = {}) {
	const res = await app.request(`http://localhost/api/memories${query}`, { headers });
	return { status: res.status, body: (await res.json()) as MemoryListBody };
}

function ids(body: MemoryListBody): string[] {
	return body.memories.map((memory) => memory.id).sort();
}

beforeAll(async () => {
	agentsDir = mkdtempSync(join(tmpdir(), "signet-memory-list-scope-"));
	mkdirSync(join(agentsDir, "memory"), { recursive: true });
	mkdirSync(join(agentsDir, ".daemon"), { recursive: true });
	writeFileSync(join(agentsDir, ".daemon", "auth-secret"), "test-secret-key-32-bytes-min!!!!");
	process.env.SIGNET_PATH = agentsDir;
	writeAuthConfig("local");

	const hono = await import("hono");
	appFactory = hono.Hono;
	({ initDbAccessor, closeDbAccessor, getDbAccessor } = await import("../db-accessor"));
	({ invalidateAgentScopeCache } = await import("../agent-id"));
	({ registerMemoryRoutes } = await import("./memory-routes"));
	({ createAuthMiddleware, createToken } = await import("../auth"));
	state = await import("./state.js");
	initDbAccessor(join(agentsDir, "memory", "memories.db"));
});

beforeEach(() => {
	getDbAccessor().withWriteTx((db) => {
		db.prepare("DELETE FROM embeddings").run();
		db.prepare("DELETE FROM memories").run();
		db.prepare("DELETE FROM agents").run();
	});
	invalidateAgentScopeCache();
	seedAgent("alpha", "isolated");
	seedAgent("beta", "isolated");
	seedAgent("gamma", "shared");
	seedAgent("team-a", "group", "crew");
	seedAgent("team-b", "group", "crew");
	seedMemory("alpha-global", "alpha", { importance: 0.95, embedded: true });
	seedMemory("alpha-private", "alpha", { visibility: "private", type: "decision" });
	seedMemory("beta-global", "beta", { importance: 0.95, embedded: true });
	seedMemory("beta-private", "beta", { visibility: "private" });
	seedMemory("team-b-global", "team-b");
	seedMemory("alpha-archived", "alpha", { visibility: "archived" });
});

afterAll(async () => {
	writeAuthConfig("local");
	state.reloadAuthState(agentsDir);
	await closeDbAccessor();
	if (previousSignetPath === undefined) Reflect.deleteProperty(process.env, "SIGNET_PATH");
	else process.env.SIGNET_PATH = previousSignetPath;
	rmSync(agentsDir, { recursive: true, force: true });
});

describe("GET /api/memories agent scope", () => {
	it("lists only an isolated agent's own memories and scopes stats to match", async () => {
		const app = await makeApp("local");
		const { status, body } = await list(app, "?agentId=alpha");

		expect(status).toBe(200);
		expect(ids(body)).toEqual(["alpha-global", "alpha-private"]);
		expect(body.memories.every((memory) => memory.agent_id === "alpha")).toBe(true);
		expect(body.stats).toEqual({ total: 2, withEmbeddings: 1, critical: 1 });
	});

	it("applies shared and group read policies like recall", async () => {
		const app = await makeApp("local");

		const shared = await list(app, "?agentId=gamma");
		expect(ids(shared.body)).toEqual(["alpha-global", "beta-global", "team-b-global"]);
		expect(shared.body.stats).toEqual({ total: 3, withEmbeddings: 2, critical: 2 });

		const group = await list(app, "?agentId=team-a");
		expect(ids(group.body)).toEqual(["team-b-global"]);
		expect(group.body.memories[0]?.agent_id).toBe("team-b");
	});

	it("counts a memory that shares a same-agent embedding by content hash as embedded", async () => {
		seedMemory("alpha-copy", "alpha", { contentHash: "alpha-global-hash" });
		seedMemory("beta-copy", "beta", { contentHash: "alpha-global-hash" });
		const app = await makeApp("local");

		const alpha = await list(app, "?agentId=alpha");
		expect(alpha.body.stats).toMatchObject({ total: 3, withEmbeddings: 2 });

		const beta = await list(app, "?agentId=beta");
		expect(beta.body.stats).toMatchObject({ total: 3, withEmbeddings: 1 });
	});

	it("resolves the agent from the agent header", async () => {
		const app = await makeApp("local");
		const { body } = await list(app, "", { "x-signet-agent-id": "beta" });

		expect(ids(body)).toEqual(["beta-global", "beta-private"]);
	});

	it("filters by type within the agent scope", async () => {
		const app = await makeApp("local");
		const { body } = await list(app, "?agentId=alpha&type=decision");

		expect(ids(body)).toEqual(["alpha-private"]);
		expect(body.stats.total).toBe(1);
	});

	it("rejects a scoped credential reading another agent and defaults to its own agent", async () => {
		const app = await makeApp("team");
		const headers = { authorization: `Bearer ${teamToken({ agent: "alpha" })}` };

		const denied = await list(app, "?agentId=beta", headers);
		expect(denied.status).toBe(403);
		expect(denied.body.memories).toBeUndefined();

		const own = await list(app, "", headers);
		expect(own.status).toBe(200);
		expect(ids(own.body)).toEqual(["alpha-global", "alpha-private"]);
	});
});

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
	readonly memories: ReadonlyArray<{ readonly id: string; readonly agent_id: string; readonly content: string }>;
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
		readonly content?: string;
	} = {},
): void {
	getDbAccessor().withWriteTx((db) => {
		db.prepare(
			`INSERT INTO memories (id, type, content, content_hash, importance, created_at, updated_at, updated_by, agent_id, visibility)
			 VALUES (?, ?, ?, ?, ?, ?, ?, 'test', ?, ?)`,
		).run(
			id,
			options.type ?? "fact",
			options.content ?? `content for ${id}`,
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
		db.prepare("DELETE FROM memory_history").run();
		db.prepare("DELETE FROM document_memories").run();
		db.prepare("DELETE FROM documents").run();
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

	it("redacts stored credentials in listed content without rewriting the row", async () => {
		const stored = "Deploy with sk-proj-Abcdefghijklmnopqrstuvwxyz0123456789 before noon.";
		seedMemory("alpha-credential", "alpha", { content: stored });
		const app = await makeApp("local");

		const { body } = await list(app, "?agentId=alpha");
		const listed = body.memories.find((memory) => memory.id === "alpha-credential");
		expect(listed?.content).toBe("Deploy with [redacted credential] before noon.");
		const row = getDbAccessor().withReadDb(
			(db) => db.prepare("SELECT content FROM memories WHERE id = ?").get("alpha-credential") as { content: string },
		);
		expect(row.content).toBe(stored);
	});

	it("lists as the shared default agent when no agent is given", async () => {
		seedAgent("default", "shared");
		seedMemory("default-private", "default", { visibility: "private" });
		const app = await makeApp("local");

		const { body } = await list(app, "");
		expect(ids(body)).toEqual(["alpha-global", "beta-global", "default-private", "team-b-global"]);
		expect(body.stats).toEqual({ total: 4, withEmbeddings: 2, critical: 2 });

		const page = await list(app, "?type=fact&limit=2&offset=3");
		expect(page.body.memories).toHaveLength(1);
		expect(page.body.stats.total).toBe(4);
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

async function get(app: Hono, path: string, headers: Record<string, string> = {}) {
	const res = await app.request(`http://localhost${path}`, { headers });
	return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

function rowIds(rows: unknown): string[] {
	return (rows as ReadonlyArray<{ readonly id: string }>).map((row) => row.id).sort();
}

function touchRecent(ids: readonly string[]): void {
	const now = new Date().toISOString();
	getDbAccessor().withWriteTx((db) => {
		for (const id of ids) {
			db.prepare("UPDATE memories SET created_at = ?, access_count = 3 WHERE id = ?").run(now, id);
			db.prepare(
				`INSERT INTO memory_history (id, memory_id, event, old_content, new_content, changed_by, reason, created_at)
				 VALUES (?, ?, 'REVIEW_NEEDED', 'old secret text', 'new text', 'test', 'check', ?)`,
			).run(`history-${id}`, id, now);
		}
	});
}

describe("GET /api/memories all-agents view", () => {
	it("lists every agent's live memories in local mode when asked explicitly", async () => {
		const app = await makeApp("local");
		const { status, body } = await list(app, "?agentId=all");

		expect(status).toBe(200);
		expect(ids(body)).toEqual(["alpha-global", "alpha-private", "beta-global", "beta-private", "team-b-global"]);
	});

	it("refuses an all-agents view without admin permission", async () => {
		const app = await makeApp("team");
		const headers = { authorization: `Bearer ${teamToken({ agent: "alpha" })}` };

		expect((await list(app, "?agentId=all", headers)).status).toBe(403);
	});

	it("falls back to the daemon's configured agent like memory writes do", async () => {
		const previous = process.env.SIGNET_AGENT_ID;
		process.env.SIGNET_AGENT_ID = "beta";
		try {
			const app = await makeApp("local");
			expect(ids((await list(app, "")).body)).toEqual(["beta-global", "beta-private"]);
		} finally {
			if (previous === undefined) Reflect.deleteProperty(process.env, "SIGNET_AGENT_ID");
			else process.env.SIGNET_AGENT_ID = previous;
		}
	});
});

describe("GET /memory/search agent scope", () => {
	it("searches only what the agent can read and skips deleted rows", async () => {
		getDbAccessor().withWriteTx((db) => {
			db.prepare("UPDATE memories SET is_deleted = 1 WHERE id = 'beta-global'").run();
		});
		const app = await makeApp("local");

		const alpha = await get(app, "/memory/search?q=content&agentId=alpha");
		expect(alpha.status).toBe(200);
		expect(rowIds(alpha.body.results)).toEqual(["alpha-global", "alpha-private"]);

		const gamma = await get(app, "/memory/search?q=content&agentId=gamma");
		expect(rowIds(gamma.body.results)).toEqual(["alpha-global", "team-b-global"]);

		const all = await get(app, "/memory/search?q=content&agentId=all");
		expect(rowIds(all.body.results)).toEqual(["alpha-global", "alpha-private", "beta-private", "team-b-global"]);
	});

	it("scopes filter-only searches, the LIKE fallback, and distinct authors", async () => {
		const app = await makeApp("local");

		const filtered = await get(app, "/memory/search?type=fact&agentId=beta");
		expect(rowIds(filtered.body.results)).toEqual(["beta-global", "beta-private"]);

		const fallback = await get(app, `/memory/search?q=${encodeURIComponent("for beta-")}&agentId=beta`);
		expect(fallback.status).toBe(200);
		expect(rowIds(fallback.body.results)).toEqual(["beta-global", "beta-private"]);

		getDbAccessor().withWriteTx((db) => {
			db.prepare("UPDATE memories SET who = agent_id").run();
		});
		const authors = await get(app, "/memory/search?distinct=who&agentId=alpha");
		expect(authors.body.values).toEqual(["alpha"]);
	});
});

describe("memory read routes apply agent scope in local mode", () => {
	it("scopes most-used, timeline, and review-queue to the requesting agent", async () => {
		touchRecent(["alpha-global", "alpha-private", "beta-global", "beta-private"]);
		const app = await makeApp("local");

		const mostUsed = await get(app, "/api/memories/most-used?agentId=alpha");
		expect(rowIds(mostUsed.body.memories)).toEqual(["alpha-global", "alpha-private"]);

		const timeline = await get(app, "/api/memory/timeline?agentId=alpha");
		expect(timeline.status).toBe(200);
		expect(timeline.body.totalMemories).toBe(2);
		expect(timeline.body.totalHistoryEvents).toBe(2);

		const reviewQueue = await get(app, "/api/memory/review-queue?agentId=beta");
		expect(
			(reviewQueue.body.items as ReadonlyArray<{ readonly memory_id: string }>).map((item) => item.memory_id).sort(),
		).toEqual(["beta-global", "beta-private"]);
	});

	it("hides another agent's memory, history, and lineage by id", async () => {
		touchRecent(["beta-private"]);
		const app = await makeApp("local");

		expect((await get(app, "/api/memory/beta-private?agentId=alpha")).status).toBe(404);
		expect((await get(app, "/api/memory/beta-private/history?agentId=alpha")).status).toBe(404);
		expect((await get(app, "/api/memory/beta-private/lineage?agentId=alpha")).body.count).toBe(0);

		expect((await get(app, "/api/memory/beta-private?agentId=beta")).body.id).toBe("beta-private");
		expect((await get(app, "/api/memory/beta-private/history?agentId=beta")).body.count).toBe(1);
		expect((await get(app, "/api/memory/beta-private/lineage?agentId=beta")).body.count).toBe(1);
	});

	it("scopes and redacts the embeddings list", async () => {
		seedMemory("alpha-key", "alpha", {
			embedded: true,
			content: "Use sk-proj-Abcdefghijklmnopqrstuvwxyz0123456789 for staging.",
		});
		const app = await makeApp("local");

		const { body } = await get(app, "/api/embeddings?agentId=alpha");
		const embeddings = body.embeddings as ReadonlyArray<{ readonly id: string; readonly content: string }>;
		expect(embeddings.map((row) => row.id).sort()).toEqual(["alpha-global", "alpha-key"]);
		expect(body.total).toBe(2);
		expect(embeddings.find((row) => row.id === "alpha-key")?.content).toBe("Use [redacted credential] for staging.");
	});

	it("refuses a similarity seed the agent cannot read", async () => {
		const app = await makeApp("local");

		const res = await get(app, "/memory/similar?id=beta-global&agentId=alpha");
		expect(res.status).toBe(404);
	});
});

describe("memory read routes enforce token agent scope", () => {
	it("rejects a scoped credential asking for another agent on every read route", async () => {
		const app = await makeApp("team");
		const headers = { authorization: `Bearer ${teamToken({ agent: "alpha" })}` };
		const paths = [
			"/memory/search?q=content&agentId=beta",
			"/api/memories/most-used?agentId=beta",
			"/api/memories/curator-slices?agentId=beta",
			"/api/memory/timeline?agentId=beta",
			"/api/memory/review-queue?agentId=beta",
			"/api/memory/beta-private?agentId=beta",
			"/api/memory/beta-private/history?agentId=beta",
			"/api/memory/beta-private/lineage?agentId=beta",
			"/api/memory/search?q=content&agentId=beta",
			"/memory/similar?id=beta-global&agentId=beta",
			"/api/embeddings?agentId=beta",
			"/api/documents/doc-b/chunks?agentId=beta",
		];
		for (const path of paths) {
			expect({ path, status: (await get(app, path, headers)).status }).toEqual({ path, status: 403 });
		}
	});

	it("serves the explicit search route instead of treating it as a memory id", async () => {
		const app = await makeApp("local");
		const res = await get(app, "/api/memory/search?q=content&agentId=alpha");

		expect(res.status).not.toBe(404);
		expect(Array.isArray(res.body.results)).toBe(true);
	});

	it("limits the workspace embedding projection to admin credentials", async () => {
		const app = await makeApp("team");
		const headers = { authorization: `Bearer ${teamToken({ agent: "alpha" })}` };

		expect((await get(app, "/api/embeddings/projection", headers)).status).toBe(403);
	});
});

async function recall(app: Hono, body: Record<string, unknown>, headers: Record<string, string> = {}) {
	const res = await app.request("http://localhost/api/memory/recall", {
		method: "POST",
		headers: { "content-type": "application/json", ...headers },
		body: JSON.stringify({ query: "content", limit: 10, ...body }),
	});
	return { status: res.status, body: (await res.json()) as { results?: ReadonlyArray<{ id: string }> } };
}

describe("POST /api/memory/recall token agent scope", () => {
	it("rejects a scoped credential recalling another agent", async () => {
		const app = await makeApp("team");
		const headers = { authorization: `Bearer ${teamToken({ agent: "alpha" })}` };

		expect((await recall(app, { agentId: "beta" }, headers)).status).toBe(403);
	});

	it("recalls as the credential's agent when the body names none", async () => {
		const app = await makeApp("team");
		const headers = { authorization: `Bearer ${teamToken({ agent: "alpha" })}` };

		const own = await recall(app, {}, headers);
		expect(own.status).toBe(200);
		expect(rowIds(own.body.results)).toEqual(["alpha-global", "alpha-private"]);
	});
});

describe("GET /api/documents/:id/chunks memory scope", () => {
	it("returns only chunk memories the reading agent can see, redacted", async () => {
		seedMemory("beta-chunk", "beta", {
			visibility: "private",
			content: "Rotate sk-proj-Abcdefghijklmnopqrstuvwxyz0123456789 monthly.",
		});
		getDbAccessor().withWriteTx((db) => {
			db.prepare(
				`INSERT INTO documents (id, source_type, status, created_at, updated_at, agent_id)
				 VALUES ('doc-b', 'text', 'done', ?, ?, 'beta')`,
			).run(NOW, NOW);
			db.prepare(
				"INSERT INTO document_memories (document_id, memory_id, chunk_index) VALUES ('doc-b', 'beta-chunk', 0)",
			).run();
		});
		const app = await makeApp("local");

		const alpha = await get(app, "/api/documents/doc-b/chunks?agentId=alpha");
		expect(alpha.body.count).toBe(0);

		const beta = await get(app, "/api/documents/doc-b/chunks?agentId=beta");
		expect(beta.body.chunks).toEqual([
			expect.objectContaining({ id: "beta-chunk", content: "Rotate [redacted credential] monthly." }),
		]);
	});
});

describe("POST /api/memory/remember token agent", () => {
	it("writes as the credential's agent when the body names none, and refuses another agent", async () => {
		const app = await makeApp("team");
		const headers = { authorization: `Bearer ${teamToken({ agent: "alpha" })}`, "content-type": "application/json" };
		const remember = (body: Record<string, unknown>) =>
			app.request("http://localhost/api/memory/remember", { method: "POST", headers, body: JSON.stringify(body) });

		const own = await remember({ content: "Alpha prefers tabs over spaces." });
		expect(own.status).toBe(200);
		const { id } = (await own.json()) as { id: string };
		const row = getDbAccessor().withReadDb(
			(db) => db.prepare("SELECT agent_id FROM memories WHERE id = ?").get(id) as { agent_id: string },
		);
		expect(row.agent_id).toBe("alpha");

		expect((await remember({ content: "Beta note", agentId: "beta" })).status).toBe(403);
	});
});

describe("memory list result size", () => {
	it("reports a page larger than the owner result limit instead of an empty success", async () => {
		seedMemory("alpha-huge", "alpha", { content: "x".repeat(1_200_000), type: "transcript-dump" });
		const app = await makeApp("local");

		const { status, body } = await list(app, "?agentId=alpha&type=transcript-dump&limit=1");
		expect(status).toBe(413);
		expect(body.error).toBe("Result is too large; request a smaller limit");
	});
});

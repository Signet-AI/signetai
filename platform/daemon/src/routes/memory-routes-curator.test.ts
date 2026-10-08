import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { closeDbAccessor, getDbAccessor, initDbAccessor } from "../db-accessor";
import { createMcpServer } from "../mcp/tools";

const previousSignetPath = process.env.SIGNET_PATH;
const agentsDir = mkdtempSync(join(tmpdir(), "signet-memory-routes-"));
const dbPath = join(agentsDir, "memory", "memories.db");
let registerMemoryRoutes: ((app: Hono) => void) | undefined;

process.env.SIGNET_PATH = agentsDir;
mkdirSync(join(agentsDir, "memory"), { recursive: true });
mkdirSync(join(agentsDir, ".daemon"), { recursive: true });
writeFileSync(join(agentsDir, "agent.yaml"), "embedding:\n  provider: none\n");

beforeAll(async () => {
	registerMemoryRoutes = (await import("./memory-routes")).registerMemoryRoutes;
});

function ensureMemorySupersessionColumns(): void {
	getDbAccessor().withWriteTx((db) => {
		const names = new Set(
			(db.prepare("PRAGMA table_info(memories)").all() as Array<{ name: unknown }>)
				.map((col) => col.name)
				.filter((name): name is string => typeof name === "string"),
		);
		if (!names.has("superseded_by")) db.exec("ALTER TABLE memories ADD COLUMN superseded_by TEXT");
		if (!names.has("superseded_at")) db.exec("ALTER TABLE memories ADD COLUMN superseded_at TEXT");
		if (!names.has("superseded_reason")) db.exec("ALTER TABLE memories ADD COLUMN superseded_reason TEXT");
	});
}

beforeEach(async () => {
	await closeDbAccessor();
	for (const file of readdirSync(join(agentsDir, "memory"))) {
		if (file.startsWith("memories.db")) rmSync(join(join(agentsDir, "memory"), file), { force: true });
	}
	initDbAccessor(dbPath, { agentsDir });
	ensureMemorySupersessionColumns();
});

afterAll(async () => {
	await closeDbAccessor();
	if (previousSignetPath === undefined) {
		Reflect.deleteProperty(process.env, "SIGNET_PATH");
	} else {
		process.env.SIGNET_PATH = previousSignetPath;
	}
	rmSync(agentsDir, { recursive: true, force: true });
});

function makeApp(): Hono {
	if (!registerMemoryRoutes) throw new Error("memory routes were not loaded");
	const app = new Hono();
	registerMemoryRoutes(app, { fetchEmbedding: async () => undefined });
	return app;
}

function seedMemory(
	id: string,
	content: string,
	options: { readonly agentId?: string; readonly project?: string | null; readonly visibility?: string } = {},
): void {
	const now = "2026-07-06T00:00:00.000Z";
	getDbAccessor().withWriteTx((db) => {
		db.prepare(
			`INSERT INTO memories (id, type, content, confidence, importance, tags, created_at, updated_at, updated_by, agent_id, project, visibility)
			 VALUES (?, 'fact', ?, 1, 0.5, '[]', ?, ?, 'test', ?, ?, ?)`,
		).run(id, content, now, now, options.agentId ?? "default", options.project ?? null, options.visibility ?? "global");
	});
}

function seedSessionMemory(input: {
	readonly id: string;
	readonly sessionKey: string;
	readonly memoryId: string;
	readonly agentId?: string;
	readonly wasInjected?: number;
	readonly preference?: string | null;
	readonly relevanceScore?: number | null;
}): void {
	getDbAccessor().withWriteTx((db) => {
		db.prepare(
			`INSERT INTO session_memories (
				id, session_key, agent_id, memory_id, source, effective_score, final_score, rank,
				was_injected, fts_hit_count, agent_preference, agent_relevance_score, created_at
			) VALUES (?, ?, ?, ?, 'ka_traversal', 0.8, 0.8, 1, ?, 0, ?, ?, ?)`,
		).run(
			input.id,
			input.sessionKey,
			input.agentId ?? "curator",
			input.memoryId,
			input.wasInjected ?? 1,
			input.preference ?? null,
			input.relevanceScore ?? null,
			"2026-07-06T00:00:00.000Z",
		);
	});
}

describe("memory curator routes", () => {
	it("redacts a stored credential in the MCP projection without rewriting the memory row", async () => {
		const secret = "sk-proj-Abcdefghijklmnopqrstuvwxyz0123456789";
		const stored = `Deploy with ${secret} before noon.`;
		seedMemory("mem-credential", stored);
		const app = makeApp();
		const originalFetch = globalThis.fetch;
		globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
			const url = new URL(input instanceof Request ? input.url : input.toString());
			return app.request(`${url.pathname}${url.search}`, init);
		}) as typeof fetch;
		try {
			const server = await createMcpServer({ daemonUrl: "http://localhost:3850" });
			const tools = (
				server as unknown as {
					readonly _registeredTools: Record<string, { handler: (args: Record<string, unknown>) => Promise<unknown> }>;
				}
			)._registeredTools;
			const result = (await tools.memory_get?.handler({ id: "mem-credential" })) as {
				content: Array<{ text: string }>;
			};
			const text = result.content[0]?.text ?? "";
			expect(text).toContain("Deploy with [redacted credential] before noon.");
			expect(text).not.toContain(secret);
		} finally {
			globalThis.fetch = originalFetch;
		}
		const row = getDbAccessor().withReadDb(
			(db) => db.prepare("SELECT content FROM memories WHERE id = ?").get("mem-credential") as { content: string },
		);
		expect(row.content).toBe(stored);
	});

	it("tombstones a memory once and reports repeat calls as idempotent", async () => {
		seedMemory("mem-delete", "delete this noisy memory");
		const app = makeApp();

		const first = await app.request("/api/memories/mem-delete/tombstone", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ reason: "noisy recall", changed_by: "curator" }),
		});
		expect(first.status).toBe(200);
		expect(await first.json()).toMatchObject({ id: "mem-delete", status: "tombstoned", idempotent: false });

		const second = await app.request("/api/memories/mem-delete/tombstone", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ reason: "noisy recall", changed_by: "curator" }),
		});
		expect(second.status).toBe(200);
		expect(await second.json()).toMatchObject({ id: "mem-delete", status: "tombstoned", idempotent: true });

		const row = getDbAccessor().withReadDb(
			(db) =>
				db.prepare("SELECT is_deleted, version FROM memories WHERE id = ?").get("mem-delete") as {
					is_deleted: number;
					version: number;
				},
		);
		const history = getDbAccessor().withReadDb(
			(db) =>
				db
					.prepare("SELECT COUNT(*) AS count FROM memory_history WHERE memory_id = ? AND event = 'deleted'")
					.get("mem-delete") as { count: number },
		);
		expect(row).toEqual({ is_deleted: 1, version: 2 });
		expect(history.count).toBe(1);
	});

	it("supersedes a memory once and reports repeat calls as idempotent", async () => {
		seedMemory("mem-old", "old preference");
		seedMemory("mem-new", "new preference");
		const app = makeApp();

		const first = await app.request("/api/memories/mem-old/supersede", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ superseded_by: "mem-new", reason: "newer evidence", changed_by: "curator" }),
		});
		expect(first.status).toBe(200);
		expect(await first.json()).toMatchObject({
			id: "mem-old",
			status: "superseded",
			superseded_by: "mem-new",
			idempotent: false,
		});

		const second = await app.request("/api/memories/mem-old/supersede", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ superseded_by: "mem-new", reason: "newer evidence", changed_by: "curator" }),
		});
		expect(second.status).toBe(200);
		expect(await second.json()).toMatchObject({
			id: "mem-old",
			status: "superseded",
			superseded_by: "mem-new",
			idempotent: true,
		});

		const row = getDbAccessor().withReadDb(
			(db) =>
				db.prepare("SELECT superseded_by, version FROM memories WHERE id = ?").get("mem-old") as {
					superseded_by: string | null;
					version: number;
				},
		);
		const history = getDbAccessor().withReadDb(
			(db) =>
				db
					.prepare("SELECT COUNT(*) AS count FROM memory_history WHERE memory_id = ? AND event = 'superseded'")
					.get("mem-old") as { count: number },
		);
		expect(row).toEqual({ superseded_by: "mem-new", version: 2 });
		expect(history.count).toBe(1);
	});

	it("rejects superseding across memory scopes", async () => {
		seedMemory("mem-old", "old preference", { agentId: "agent-a", project: "/repo/a" });
		seedMemory("mem-new", "new preference", { agentId: "agent-b", project: "/repo/b" });
		const app = makeApp();

		const res = await app.request("/api/memories/mem-old/supersede", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ superseded_by: "mem-new", reason: "newer evidence", changed_by: "curator" }),
		});
		expect(res.status).toBe(409);
		expect(await res.json()).toMatchObject({ id: "mem-old", status: "scope_mismatch" });
	});

	it("returns curator slices from session feedback", async () => {
		seedMemory("mem-stale", "injected repeatedly but never used");
		seedMemory("mem-contradicted", "contradicted memory");
		seedMemory("mem-used", "useful memory");
		seedSessionMemory({ id: "sm-stale-1", sessionKey: "session-a", memoryId: "mem-stale" });
		seedSessionMemory({ id: "sm-stale-2", sessionKey: "session-b", memoryId: "mem-stale", relevanceScore: 0.2 });
		seedSessionMemory({
			id: "sm-contradicted",
			sessionKey: "session-c",
			memoryId: "mem-contradicted",
			preference: "CONTRADICTED",
		});
		seedSessionMemory({ id: "sm-used", sessionKey: "session-d", memoryId: "mem-used", preference: "USED" });
		const app = makeApp();

		const res = await app.request("/api/memories/curator-slices?agentId=curator&minSessions=2&limit=5");
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			readonly agentId: string;
			readonly injectedNeverUsed: ReadonlyArray<{ readonly id: string; readonly sessions: number }>;
			readonly contradicted: ReadonlyArray<{ readonly id: string; readonly contradicted_count: number }>;
			readonly highUsed: ReadonlyArray<{ readonly id: string; readonly used_count: number }>;
		};

		expect(body.agentId).toBe("curator");
		expect(body.injectedNeverUsed).toEqual([
			{ id: "mem-stale", content: "injected repeatedly but never used", sessions: 2 },
		]);
		expect(body.contradicted).toEqual([
			{ id: "mem-contradicted", content: "contradicted memory", contradicted_count: 1 },
		]);
		expect(body.highUsed).toEqual([{ id: "mem-used", content: "useful memory", used_count: 1 }]);
	});
	it("marks the supersedes target superseded atomically with the new memory", async () => {
		seedMemory("mem-v1", "original claim");
		const app = makeApp();

		const res = await app.request("/api/memory/remember", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				content: "replacement claim",
				supersedes: "mem-v1",
				reason: "newer evidence",
			}),
		});
		expect(res.status).toBe(200);
		const body = (await res.json()) as { id: string; superseded: string };
		expect(typeof body.id).toBe("string");
		expect(body.superseded).toBe("superseded");

		const oldRow = getDbAccessor().withReadDb(
			(db) =>
				db.prepare("SELECT superseded_by, version FROM memories WHERE id = ?").get("mem-v1") as {
					superseded_by: string | null;
					version: number;
				},
		);
		expect(oldRow.superseded_by).toBe(body.id);
		expect(oldRow.version).toBe(2);
	});

	it("fails the whole remember when the supersedes target is missing", async () => {
		const app = makeApp();
		const res = await app.request("/api/memory/remember", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ content: "orphan claim", supersedes: "does-not-exist" }),
		});
		expect(res.status).toBe(400);
		expect((await res.json()) as { error: string }).toMatchObject({
			error: "supersedes target rejected: not_found",
		});
		const count = getDbAccessor().withReadDb(
			(db) =>
				db.prepare("SELECT COUNT(*) AS count FROM memories WHERE content = 'orphan claim'").get() as { count: number },
		);
		expect(count.count).toBe(0);
	});

	it("rejects supersedes combined with oversized chunked content", async () => {
		seedMemory("mem-chunked", "to be superseded");
		const app = makeApp();
		const res = await app.request("/api/memory/remember", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				content: "x".repeat(2000),
				supersedes: "mem-chunked",
			}),
		});
		expect(res.status).toBe(400);
		expect((await res.json()) as { error: string }).toMatchObject({
			error: "supersedes cannot be combined with oversized content (auto-chunking)",
		});
		const chunkCount = getDbAccessor().withReadDb(
			(db) =>
				db.prepare("SELECT COUNT(*) AS count FROM memories WHERE source_type = 'chunk'").get() as { count: number },
		);
		expect(chunkCount.count).toBe(0);
		expect(
			getDbAccessor().withReadDb(
				(db) =>
					db.prepare("SELECT superseded_by FROM memories WHERE id = 'mem-chunked'").get("mem-chunked") as {
						superseded_by: string | null;
					},
			),
		).toEqual({ superseded_by: null });
	});

	it("walks superseded_by lineage from any row in the chain, oldest first", async () => {
		seedMemory("mem-gen1", "genesis claim");
		const app = makeApp();
		const v2 = await app.request("/api/memory/remember", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ content: "second claim", supersedes: "mem-gen1" }),
		});
		const v2Body = (await v2.json()) as { id: string };
		const v3 = await app.request("/api/memory/remember", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ content: "third claim", supersedes: v2Body.id }),
		});
		const v3Body = (await v3.json()) as { id: string };
		for (const start of ["mem-gen1", v2Body.id, v3Body.id]) {
			const res = await app.request(`/api/memory/${start}/lineage`);
			expect(res.status).toBe(200);
			const body = (await res.json()) as {
				count: number;
				lineage: Array<{ id: string; supersededBy: string | null }>;
			};
			expect(body.count).toBe(3);
			expect(body.lineage.map((row) => row.id)).toEqual(["mem-gen1", v2Body.id, v3Body.id]);
			expect(body.lineage[0]?.supersededBy).toBe(v2Body.id);
			expect(body.lineage[2]?.supersededBy).toBeNull();
		}
	});

	it("refuses to re-supersede a mid-chain memory with a different successor (no fork)", async () => {
		seedMemory("mem-a", "genesis");
		const app = makeApp();
		const r1 = await app.request("/api/memory/remember", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ content: "b", supersedes: "mem-a" }),
		});
		expect(r1.status).toBe(200);
		const v2Id = ((await r1.json()) as { id: string }).id;
		const r2 = await app.request("/api/memory/remember", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ content: "c", supersedes: "mem-a" }),
		});
		expect(r2.status).toBe(400);
		const aRow = getDbAccessor().withReadDb(
			(db) =>
				db.prepare("SELECT superseded_by FROM memories WHERE id = 'mem-a'").get("mem-a") as {
					superseded_by: string | null;
				},
		);
		expect(aRow.superseded_by).toBe(v2Id);
		const cCount = getDbAccessor().withReadDb(
			(db) => db.prepare("SELECT COUNT(*) AS c FROM memories WHERE content = 'c'").get() as { c: number },
		);
		expect(cCount.c).toBe(0);
		const v2Row = getDbAccessor().withReadDb(
			(db) =>
				db.prepare("SELECT superseded_by FROM memories WHERE id = ?").get(v2Id) as {
					superseded_by: string | null;
				},
		);
		expect(v2Row.superseded_by).toBeNull();
	});
});

describe("legacy memory search", () => {
	it("finds saved content when the query has surrounding whitespace", async () => {
		seedMemory("mem-first", "I prefer short answers.");
		const res = await makeApp().request(`/memory/search?${new URLSearchParams({ q: "I prefer short answers. " })}`);
		expect(res.status).toBe(200);
		const body = (await res.json()) as { results: Array<{ id: string }> };
		expect(body.results.map((row) => row.id)).toEqual(["mem-first"]);
	});
});

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { closeDbAccessor, getDbAccessor, initDbAccessor } from "../db-accessor";

const previousSignetPath = process.env.SIGNET_PATH;
const agentsDir = mkdtempSync(join(tmpdir(), "signet-memory-routes-"));
const dbPath = join(agentsDir, "memory", "memories.db");
let registerMemoryRoutes: ((app: Hono) => void) | undefined;

process.env.SIGNET_PATH = agentsDir;
mkdirSync(join(agentsDir, "memory"), { recursive: true });

beforeAll(async () => {
	// Static import would capture AGENTS_DIR before this test installs its temp SIGNET_PATH.
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

beforeEach(() => {
	closeDbAccessor();
	rmSync(dbPath, { force: true });
	rmSync(`${dbPath}-wal`, { force: true });
	rmSync(`${dbPath}-shm`, { force: true });
	initDbAccessor(dbPath, { agentsDir });
	ensureMemorySupersessionColumns();
});

afterAll(() => {
	closeDbAccessor();
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
	registerMemoryRoutes(app);
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
});

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WriteDb } from "./db-accessor";

const workspace = join(tmpdir(), `signet-agent-removal-${Date.now()}`);
mkdirSync(join(workspace, "memory"), { recursive: true });
process.env.SIGNET_PATH = workspace;

let closeDb: (() => Promise<void>) | undefined;
let app: InstanceType<typeof import("hono").Hono>;
let write: <T>(fn: (db: WriteDb) => T) => Promise<T>;

const NOW = "2026-10-01T00:00:00.000Z";

beforeAll(async () => {
	const { Hono } = await import("hono");
	const db = await import("./db-accessor");
	await db.closeDbAccessor();
	db.initDbAccessor(join(workspace, "memory", "memories.db"));
	closeDb = db.closeDbAccessor;
	write = (fn) => db.runWriteTxAsync(db.getDbAccessor(), fn);
	const { registerMiscRoutes } = await import("./routes/misc-routes");
	app = new Hono();
	registerMiscRoutes(app);
});

afterAll(async () => {
	await closeDb?.();
	rmSync(workspace, { recursive: true, force: true });
});

function seedAgent(db: WriteDb, agent: string): void {
	db.prepare(
		"INSERT INTO agents (id, name, read_policy, policy_group, created_at, updated_at) VALUES (?, ?, 'isolated', NULL, ?, ?)",
	).run(agent, agent, NOW, NOW);
	for (const n of [1, 2]) {
		const memoryId = `${agent}-mem-${n}`;
		db.prepare(
			"INSERT INTO memories (id, content, agent_id, visibility, created_at, updated_at) VALUES (?, ?, ?, 'global', ?, ?)",
		).run(memoryId, `${agent} fact ${n}`, agent, NOW, NOW);
		db.prepare(
			`INSERT INTO embeddings (id, content_hash, vector, dimensions, source_type, source_id, chunk_text, created_at, agent_id)
			 VALUES (?, ?, ?, 1, 'memory', ?, 'chunk', ?, ?)`,
		).run(`${memoryId}-emb`, `${memoryId}-hash`, new Uint8Array(4), memoryId, NOW, agent);
		db.prepare("INSERT INTO memory_hints (id, memory_id, agent_id, hint, created_at) VALUES (?, ?, ?, 'hint', ?)").run(
			`${memoryId}-hint`,
			memoryId,
			agent,
			NOW,
		);
		db.prepare(
			"INSERT INTO memory_history (id, memory_id, event, old_content, new_content, changed_by, created_at) VALUES (?, ?, 'created', NULL, ?, 'test', ?)",
		).run(`${memoryId}-hist`, memoryId, `${agent} fact ${n}`, NOW);
		db.prepare(
			"INSERT INTO memory_jobs (id, memory_id, job_type, status, created_at, updated_at) VALUES (?, ?, 'extract', 'pending', ?, ?)",
		).run(`${memoryId}-job`, memoryId, NOW, NOW);
	}
	for (const name of ["alpha", "beta"]) {
		db.prepare(
			"INSERT INTO entities (id, name, entity_type, agent_id, mentions, status, created_at, updated_at) VALUES (?, ?, 'concept', ?, 2, 'active', ?, ?)",
		).run(`${agent}-${name}`, `${agent} ${name}`, agent, NOW, NOW);
	}
	db.prepare("INSERT INTO memory_entity_mentions (memory_id, entity_id) VALUES (?, ?)").run(
		`${agent}-mem-1`,
		`${agent}-alpha`,
	);
	db.prepare(
		"INSERT INTO entity_aspects (id, entity_id, agent_id, name, canonical_name, status, created_at, updated_at) VALUES (?, ?, ?, 'traits', 'traits', 'active', ?, ?)",
	).run(`${agent}-aspect`, `${agent}-alpha`, agent, NOW, NOW);
	db.prepare(
		`INSERT INTO entity_attributes (id, aspect_id, agent_id, memory_id, kind, content, normalized_content, status, created_at, updated_at)
		 VALUES (?, ?, ?, ?, 'attribute', 'likes tea', 'likes tea', 'active', ?, ?)`,
	).run(`${agent}-attr`, `${agent}-aspect`, agent, `${agent}-mem-1`, NOW, NOW);
	db.prepare(
		`INSERT INTO entity_dependencies (id, source_entity_id, target_entity_id, agent_id, dependency_type, reason, status, created_at, updated_at)
		 VALUES (?, ?, ?, ?, 'related_to', 'seeded', 'active', ?, ?)`,
	).run(`${agent}-dep`, `${agent}-alpha`, `${agent}-beta`, agent, NOW, NOW);
	db.prepare(
		"INSERT INTO entity_aliases (id, entity_id, agent_id, alias, canonical_alias, created_at, updated_at) VALUES (?, ?, ?, 'a', 'a', ?, ?)",
	).run(`${agent}-alias`, `${agent}-alpha`, agent, NOW, NOW);
	db.prepare(
		`INSERT INTO epistemic_assertions (id, subject_entity_id, agent_id, predicate, content, normalized_content, asserted_at, created_at, updated_at)
		 VALUES (?, ?, ?, 'claims', 'x', 'x', ?, ?, ?)`,
	).run(`${agent}-assertion`, `${agent}-alpha`, agent, NOW, NOW, NOW);
	db.prepare(
		"INSERT INTO relations (id, source_entity_id, target_entity_id, relation_type, created_at) VALUES (?, ?, ?, 'knows', ?)",
	).run(`${agent}-rel`, `${agent}-alpha`, `${agent}-beta`, NOW);
	db.prepare(
		"INSERT INTO session_transcripts (session_key, agent_id, content, created_at) VALUES (?, ?, 'transcript', ?)",
	).run(`${agent}-session`, agent, NOW);
	db.prepare(
		"INSERT INTO session_summaries (id, kind, agent_id, content, earliest_at, latest_at, created_at) VALUES (?, 'session', ?, 'summary', ?, ?, ?)",
	).run(`${agent}-summary`, agent, NOW, NOW, NOW);
}

function agentScopedTables(db: WriteDb): string[] {
	const tables = db
		.prepare(
			"SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND sql NOT LIKE 'CREATE VIRTUAL TABLE%'",
		)
		.all() as Array<{ name: string }>;
	return tables
		.map((row) => row.name)
		.filter((name) =>
			(db.prepare(`PRAGMA table_info("${name}")`).all() as Array<{ name: string }>).some(
				(column) => column.name === "agent_id",
			),
		);
}

describe("DELETE /api/agents/:name", () => {
	beforeEach(async () => {
		await write((db) => {
			for (const table of agentScopedTables(db)) db.prepare(`DELETE FROM "${table}"`).run();
			for (const table of ["agents", "memory_history", "memory_jobs", "memory_entity_mentions", "relations"]) {
				db.prepare(`DELETE FROM ${table}`).run();
			}
			seedAgent(db, "doomed");
			seedAgent(db, "keeper");
			db.prepare(
				"INSERT INTO memory_entity_mentions (memory_id, entity_id) VALUES ('doomed-mem-2', 'keeper-beta')",
			).run();
		});
	});

	it("purges every agent-scoped row and records the purge", async () => {
		await write((db) => {
			for (const memory of ["doomed-mem-1", "keeper-mem-1", "keeper-mem-2"]) {
				db.prepare("INSERT INTO memory_entity_mentions (memory_id, entity_id) VALUES (?, 'keeper-beta')").run(memory);
			}
			db.prepare("UPDATE entities SET mentions = 4 WHERE id = 'keeper-beta'").run();
		});
		const response = await app.request("/api/agents/doomed?purge=true", { method: "DELETE" });
		expect(response.status).toBe(200);
		const body = (await response.json()) as { success: boolean; purged: boolean; rows: Record<string, number> };
		expect(body.success).toBe(true);
		expect(body.purged).toBe(true);
		expect(body.rows.memories).toBe(2);
		expect(body.rows.embeddings).toBe(2);
		expect(body.rows.entities).toBe(2);
		expect(body.rows.agents).toBe(1);
		expect(body.rows["memory_history.purged"]).toBe(2);

		await write((db) => {
			for (const table of agentScopedTables(db)) {
				const left = db.prepare(`SELECT COUNT(*) AS n FROM "${table}" WHERE agent_id = 'doomed'`).get() as {
					n: number;
				};
				expect({ table, n: left.n }).toEqual({ table, n: 0 });
			}
			for (const [table, column] of [
				["memory_entity_mentions", "memory_id"],
				["memory_jobs", "memory_id"],
				["memory_hints", "memory_id"],
				["embeddings", "source_id"],
			] as const) {
				const left = db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${column} LIKE 'doomed-%'`).get() as {
					n: number;
				};
				expect({ table, n: left.n }).toEqual({ table, n: 0 });
			}
			expect(
				db.prepare("SELECT COUNT(*) AS n FROM memory_entity_mentions WHERE entity_id LIKE 'doomed-%'").get(),
			).toEqual({ n: 0 });
			expect(db.prepare("SELECT COUNT(*) AS n FROM relations WHERE id = 'doomed-rel'").get()).toEqual({ n: 0 });
			expect(
				db
					.prepare(
						"SELECT memory_id, event, old_content, new_content FROM memory_history WHERE memory_id LIKE 'doomed-%' ORDER BY memory_id",
					)
					.all(),
			).toEqual([
				{ memory_id: "doomed-mem-1", event: "purged", old_content: null, new_content: null },
				{ memory_id: "doomed-mem-2", event: "purged", old_content: null, new_content: null },
			]);
			expect(db.prepare("SELECT mentions FROM entities WHERE id = 'keeper-beta'").get()).toEqual({ mentions: 2 });
			expect(
				db
					.prepare("SELECT memory_id FROM memory_entity_mentions WHERE entity_id = 'keeper-beta' ORDER BY memory_id")
					.all(),
			).toEqual([{ memory_id: "keeper-mem-1" }, { memory_id: "keeper-mem-2" }]);
			expect(db.prepare("SELECT COUNT(*) AS n FROM memories WHERE agent_id = 'keeper'").get()).toEqual({ n: 2 });
			expect(db.prepare("SELECT COUNT(*) AS n FROM embeddings WHERE agent_id = 'keeper'").get()).toEqual({ n: 2 });
			expect(db.prepare("SELECT COUNT(*) AS n FROM entities WHERE agent_id = 'keeper'").get()).toEqual({ n: 2 });
			expect(db.prepare("SELECT COUNT(*) AS n FROM relations WHERE id = 'keeper-rel'").get()).toEqual({ n: 1 });
			expect(db.prepare("SELECT COUNT(*) AS n FROM memory_history WHERE memory_id LIKE 'keeper-%'").get()).toEqual({
				n: 2,
			});
		});
	});

	it("archives memories and ontology rows together and records the archive", async () => {
		const response = await app.request("/api/agents/doomed", { method: "DELETE" });
		expect(response.status).toBe(200);
		const body = (await response.json()) as { success: boolean; purged: boolean; rows: Record<string, number> };
		expect(body).toMatchObject({ success: true, purged: false, mode: "archive" });
		expect(body.rows.memories).toBe(2);
		expect(body.rows.entities).toBe(2);
		expect(body.rows["memory_history.archived"]).toBe(2);

		await write((db) => {
			expect(db.prepare("SELECT COUNT(*) AS n FROM agents WHERE id = 'doomed'").get()).toEqual({ n: 0 });
			expect(db.prepare("SELECT DISTINCT visibility FROM memories WHERE agent_id = 'doomed'").all()).toEqual([
				{ visibility: "archived" },
			]);
			for (const table of ["entities", "entity_aspects", "entity_attributes", "entity_dependencies"]) {
				expect({
					table,
					statuses: db.prepare(`SELECT DISTINCT status FROM ${table} WHERE agent_id = 'doomed'`).all(),
				}).toEqual({ table, statuses: [{ status: "archived" }] });
			}
			expect(
				db
					.prepare(
						"SELECT memory_id, event FROM memory_history WHERE memory_id LIKE 'doomed-%' AND event = 'archived' ORDER BY memory_id",
					)
					.all(),
			).toEqual([
				{ memory_id: "doomed-mem-1", event: "archived" },
				{ memory_id: "doomed-mem-2", event: "archived" },
			]);
			expect(db.prepare("SELECT DISTINCT visibility FROM memories WHERE agent_id = 'keeper'").all()).toEqual([
				{ visibility: "global" },
			]);
		});
	});

	it("returns 404 for an unknown agent and refuses the default agent", async () => {
		expect((await app.request("/api/agents/missing?purge=true", { method: "DELETE" })).status).toBe(404);
		expect((await app.request("/api/agents/default?purge=true", { method: "DELETE" })).status).toBe(400);
	});
});

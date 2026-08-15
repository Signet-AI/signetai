import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDbAccessor, getDbAccessor, initDbAccessor } from "./db-accessor";
import { getEntityHealth, getPinnedEntities } from "./knowledge-graph";
import { applyOntologyOperation } from "./ontology-proposals";
import { applyFtsOverlapFeedback, decayAspectWeights } from "./pipeline/aspect-feedback";
import { resolveFocalEntities } from "./pipeline/graph-traversal";

function makeDbPath(): string {
	const dir = join(tmpdir(), `signet-ka6-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(dir, { recursive: true });
	return join(dir, "memories.db");
}

function insertEntity(id: string, name: string, entityType: string, agentId = "default"): void {
	const now = new Date().toISOString();
	getDbAccessor().withWriteTx((db) => {
		const cols = db.prepare("PRAGMA table_info(entities)").all() as Array<Record<string, unknown>>;
		const names = new Set(cols.flatMap((col) => (typeof col.name === "string" ? [col.name] : [])));
		if (!names.has("pinned")) {
			db.exec("ALTER TABLE entities ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0");
		}
		if (!names.has("pinned_at")) {
			db.exec("ALTER TABLE entities ADD COLUMN pinned_at TEXT");
		}
		db.prepare(
			`INSERT INTO entities
			 (id, name, entity_type, canonical_name, mentions, agent_id, created_at, updated_at)
			 VALUES (?, ?, ?, ?, 1, ?, ?, ?)`,
		).run(id, name, entityType, name.toLowerCase(), agentId, now, now);
	});
}

function insertMemory(id: string, content: string): void {
	const now = new Date().toISOString();
	getDbAccessor().withWriteTx((db) => {
		db.prepare(
			`INSERT INTO memories
			 (id, content, type, updated_by, created_at, updated_at, is_deleted)
			 VALUES (?, ?, 'fact', 'test', ?, ?, 0)`,
		).run(id, content, now, now);
	});
}

describe("knowledge feedback", () => {
	let dbPath = "";

	afterEach(() => {
		closeDbAccessor();
		if (dbPath) {
			const dir = join(dbPath, "..");
			if (existsSync(dir)) {
				rmSync(dir, { recursive: true, force: true });
			}
		}
		dbPath = "";
	});

	test("pinning updates entity state and focal resolution unions pinned entities", async () => {
		dbPath = makeDbPath();
		initDbAccessor(dbPath);

		insertEntity("entity-pinned", "Pinned Project", "project");
		insertEntity("entity-project", "other-project", "project");

		await applyOntologyOperation(getDbAccessor(), {
			agentId: "default",
			actor: "test",
			operation: "pin_entity",
			payload: { id: "entity-pinned" },
		});

		const pinned = await getPinnedEntities(getDbAccessor(), "default");
		expect(pinned).toHaveLength(1);
		expect(pinned[0]?.id).toBe("entity-pinned");

		const resolved = getDbAccessor().withReadDb((db) =>
			resolveFocalEntities(db, "default", {
				project: "/tmp/other-project",
			}),
		);
		expect(resolved.pinnedEntityIds).toEqual(["entity-pinned"]);
		expect(resolved.entityIds).toContain("entity-pinned");
		expect(resolved.entityIds).toContain("entity-project");
		expect(resolved.source).toBe("project");

		await applyOntologyOperation(getDbAccessor(), {
			agentId: "default",
			actor: "test",
			operation: "unpin_entity",
			payload: { id: "entity-pinned" },
		});
		expect(await getPinnedEntities(getDbAccessor(), "default")).toHaveLength(0);
	});

	test("focal source falls back to session_key even when project is present but unresolved", async () => {
		dbPath = makeDbPath();
		initDbAccessor(dbPath);

		insertEntity("entity-pinned", "Pinned Project", "project");
		await applyOntologyOperation(getDbAccessor(), {
			agentId: "default",
			actor: "test",
			operation: "pin_entity",
			payload: { id: "entity-pinned" },
		});

		const resolved = getDbAccessor().withReadDb((db) =>
			resolveFocalEntities(db, "default", {
				project: "/tmp/no-match-here",
				sessionKey: "session-1",
			}),
		);

		expect(resolved.source).toBe("session_key");
		expect(resolved.entityIds).toEqual(["entity-pinned"]);
	});

	test("entity health is empty after predictor comparison table retirement", async () => {
		dbPath = makeDbPath();
		initDbAccessor(dbPath);

		getDbAccessor().withWriteTx((db) => {
			db.exec("DROP TABLE IF EXISTS predictor_comparisons");
		});

		expect(await getEntityHealth(getDbAccessor(), "default")).toEqual([]);
	});

	test("fts overlap feedback raises aspect weights and decay respects the floor", () => {
		dbPath = makeDbPath();
		initDbAccessor(dbPath);

		insertEntity("entity-1", "Alpha", "project");
		insertMemory("memory-1", "remember alpha");
		getDbAccessor().withWriteTx((db) => {
			const now = new Date().toISOString();
			db.prepare(
				`INSERT INTO entity_aspects
				 (id, entity_id, agent_id, name, canonical_name, weight, created_at, updated_at)
				 VALUES ('aspect-1', 'entity-1', 'default', 'core', 'core', 0.5, ?, ?)`,
			).run(now, now);
			db.prepare(
				`INSERT INTO entity_attributes
				 (id, aspect_id, agent_id, memory_id, kind, content, normalized_content,
				  confidence, importance, status, created_at, updated_at)
				 VALUES (?, ?, ?, ?, 'attribute', ?, ?, 1, 0.5, 'active', ?, ?)`,
			).run("attr-1", "aspect-1", "default", "memory-1", "remember alpha", "remember alpha", now, now);
			db.prepare(
				`INSERT INTO session_memories
				 (id, session_key, memory_id, source, effective_score, final_score, rank,
				  was_injected, fts_hit_count, created_at)
				 VALUES (?, 'session-1', 'memory-1', 'ka_traversal', 0.8, 0.8, 1, 1, 2, ?)`,
			).run("sm-1", now);
		});

		const feedback = applyFtsOverlapFeedback(getDbAccessor(), "session-1", "default", {
			delta: 0.02,
			minWeight: 0.1,
			maxWeight: 1.0,
		});
		expect(feedback.aspectsUpdated).toBe(1);
		expect(feedback.totalFtsConfirmations).toBe(2);

		const afterFeedback = getDbAccessor().withReadDb(
			(db) =>
				db.prepare("SELECT weight FROM entity_aspects WHERE id = ?").get("aspect-1") as
					| Record<string, unknown>
					| undefined,
		);
		expect(afterFeedback?.weight).toBe(0.54);

		getDbAccessor().withWriteTx((db) => {
			db.prepare("UPDATE entity_aspects SET weight = 0.11, updated_at = datetime('now', '-30 days') WHERE id = ?").run(
				"aspect-1",
			);
		});
		const decayed = decayAspectWeights(getDbAccessor(), "default", {
			decayRate: 0.05,
			minWeight: 0.1,
			staleDays: 14,
		});
		expect(decayed).toBe(1);

		const afterDecay = getDbAccessor().withReadDb(
			(db) =>
				db.prepare("SELECT weight FROM entity_aspects WHERE id = ?").get("aspect-1") as
					| Record<string, unknown>
					| undefined,
		);
		expect(afterDecay?.weight).toBe(0.1);
	});
});

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDbAccessor, getDbAccessor, initDbAccessor } from "./db-accessor";
import {
	getEntityHealth,
	getPinnedEntities,
	pinEntity,
	propagateMemoryStatus,
	unpinEntity,
	upsertAspect,
} from "./knowledge-graph";
import { applyFtsOverlapFeedback, decayAspectWeights } from "./pipeline/aspect-feedback";
import { resolveFocalEntities } from "./pipeline/graph-traversal";

function makeDbPath(): string {
	const dir = join(
		tmpdir(),
		`signet-ka6-${Date.now()}-${Math.random().toString(36).slice(2)}`,
	);
	mkdirSync(dir, { recursive: true });
	return join(dir, "memories.db");
}

function insertEntity(
	id: string,
	name: string,
	entityType: string,
	agentId = "default",
): void {
	const now = new Date().toISOString();
	getDbAccessor().withWriteTx((db) => {
		const cols = db
			.prepare("PRAGMA table_info(entities)")
			.all() as Array<Record<string, unknown>>;
		const names = new Set(
			cols.flatMap((col) =>
				typeof col.name === "string" ? [col.name] : [],
			),
		);
		if (!names.has("pinned")) {
			db.exec(
				"ALTER TABLE entities ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0",
			);
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

	test("pinning updates entity state and focal resolution unions pinned entities", () => {
		dbPath = makeDbPath();
		initDbAccessor(dbPath);

		insertEntity("entity-pinned", "Pinned Project", "project");
		insertEntity("entity-project", "other-project", "project");

		pinEntity(getDbAccessor(), "entity-pinned", "default");

		const pinned = getPinnedEntities(getDbAccessor(), "default");
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

		unpinEntity(getDbAccessor(), "entity-pinned", "default");
		expect(getPinnedEntities(getDbAccessor(), "default")).toHaveLength(0);
	});

	test("focal source falls back to session_key even when project is present but unresolved", () => {
		dbPath = makeDbPath();
		initDbAccessor(dbPath);

		insertEntity("entity-pinned", "Pinned Project", "project");
		pinEntity(getDbAccessor(), "entity-pinned", "default");

		const resolved = getDbAccessor().withReadDb((db) =>
			resolveFocalEntities(db, "default", {
				project: "/tmp/no-match-here",
				sessionKey: "session-1",
			}),
		);

		expect(resolved.source).toBe("session_key");
		expect(resolved.entityIds).toEqual(["entity-pinned"]);
	});

	test("fts overlap feedback raises aspect weights and decay respects the floor", () => {
		dbPath = makeDbPath();
		initDbAccessor(dbPath);

		insertEntity("entity-1", "Alpha", "project");
		insertMemory("memory-1", "remember alpha");
		const aspect = upsertAspect(getDbAccessor(), {
			entityId: "entity-1",
			agentId: "default",
			name: "core",
			weight: 0.5,
		});

		getDbAccessor().withWriteTx((db) => {
			const now = new Date().toISOString();
			db.prepare(
				`INSERT INTO entity_attributes
				 (id, aspect_id, agent_id, memory_id, kind, content, normalized_content,
				  confidence, importance, status, created_at, updated_at)
				 VALUES (?, ?, ?, ?, 'attribute', ?, ?, 1, 0.5, 'active', ?, ?)`,
			).run(
				"attr-1",
				aspect.id,
				"default",
				"memory-1",
				"remember alpha",
				"remember alpha",
				now,
				now,
			);
			db.prepare(
				`INSERT INTO session_memories
				 (id, session_key, memory_id, source, effective_score, final_score, rank,
				  was_injected, fts_hit_count, created_at)
				 VALUES (?, 'session-1', 'memory-1', 'ka_traversal', 0.8, 0.8, 1, 1, 2, ?)`,
			).run("sm-1", now);
		});

		const feedback = applyFtsOverlapFeedback(
			getDbAccessor(),
			"session-1",
			"default",
			{
				delta: 0.02,
				minWeight: 0.1,
				maxWeight: 1.0,
			},
		);
		expect(feedback.aspectsUpdated).toBe(1);
		expect(feedback.totalFtsConfirmations).toBe(2);

		const afterFeedback = getDbAccessor().withReadDb((db) =>
			db.prepare("SELECT weight FROM entity_aspects WHERE id = ?").get(aspect.id) as
				| Record<string, unknown>
				| undefined,
		);
		expect(afterFeedback?.weight).toBe(0.54);

		getDbAccessor().withWriteTx((db) => {
			db.prepare(
				"UPDATE entity_aspects SET weight = 0.11, updated_at = datetime('now', '-30 days') WHERE id = ?",
			).run(aspect.id);
		});
		const decayed = decayAspectWeights(getDbAccessor(), "default", {
			decayRate: 0.05,
			minWeight: 0.1,
			staleDays: 14,
		});
		expect(decayed).toBe(1);

		const afterDecay = getDbAccessor().withReadDb((db) =>
			db.prepare("SELECT weight FROM entity_aspects WHERE id = ?").get(aspect.id) as
				| Record<string, unknown>
				| undefined,
		);
		expect(afterDecay?.weight).toBe(0.1);
	});

	test("entity health aggregates predictor comparisons and propagation supersedes orphaned attributes", () => {
		dbPath = makeDbPath();
		initDbAccessor(dbPath);

		insertEntity("entity-1", "Alpha", "project");
		insertMemory("memory-1", "first");
		const aspect = upsertAspect(getDbAccessor(), {
			entityId: "entity-1",
			agentId: "default",
			name: "delivery",
		});

		getDbAccessor().withWriteTx((db) => {
			const now = new Date().toISOString();
			db.prepare(
				`INSERT INTO entity_attributes
				 (id, aspect_id, agent_id, memory_id, kind, content, normalized_content,
				  confidence, importance, status, created_at, updated_at)
				 VALUES (?, ?, ?, ?, 'attribute', ?, ?, 1, 0.5, 'active', ?, ?)`,
			).run(
				"attr-1",
				aspect.id,
				"default",
				"memory-1",
				"first",
				"first",
				now,
				now,
			);

			const insertComparison = db.prepare(
				`INSERT INTO predictor_comparisons
				 (id, session_key, agent_id, predictor_ndcg, baseline_ndcg, predictor_won,
				  margin, alpha, focal_entity_id, focal_entity_name, candidate_count,
				  traversal_count, constraint_count, created_at)
				 VALUES (?, ?, 'default', 0.8, 0.6, ?, ?, 0.1, 'entity-1', 'Alpha', 10, 3, 1, ?)`,
			);
			insertComparison.run(
				"cmp-1",
				"session-a",
				0,
				-0.1,
				"2026-03-01T00:00:00.000Z",
			);
			insertComparison.run(
				"cmp-2",
				"session-b",
				1,
				0.2,
				"2026-03-02T00:00:00.000Z",
			);
			insertComparison.run(
				"cmp-3",
				"session-c",
				1,
				0.3,
				"2026-03-03T00:00:00.000Z",
			);

			db.prepare("UPDATE memories SET is_deleted = 1 WHERE id = 'memory-1'").run();
		});

		const health = getEntityHealth(getDbAccessor(), "default");
		expect(health).toHaveLength(1);
		expect(health[0]?.comparisonCount).toBe(3);
		expect(health[0]?.trend).toBe("improving");
		expect(health[0]?.winRate).toBeCloseTo(2 / 3);

		const propagated = propagateMemoryStatus(getDbAccessor(), "default");
		expect(propagated).toBe(1);

		const attribute = getDbAccessor().withReadDb((db) =>
			db.prepare("SELECT status FROM entity_attributes WHERE id = 'attr-1'").get() as
				| Record<string, unknown>
				| undefined,
		);
		expect(attribute?.status).toBe("superseded");
	});
});

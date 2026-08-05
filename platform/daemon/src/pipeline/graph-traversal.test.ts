/**
 * Regression test for #1118: traverseKnowledgeGraph was fully synchronous and
 * blocked the daemon event loop for the whole walk (~1.7s per session start on
 * a 102k-memory graph), serializing concurrent session starts and tripping the
 * pressure gate. The walk must yield to the event loop between batches.
 */

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { ReadDb } from "../db-accessor";
import { invalidateTraversalCache, traverseKnowledgeGraph } from "./graph-traversal";

const CONFIG = {
	maxAspectsPerEntity: 10,
	maxAttributesPerAspect: 20,
	maxDependencyHops: 10,
	minDependencyStrength: 0.3,
	maxBranching: 4,
	maxTraversalPaths: 50,
	minConfidence: 0.5,
	timeoutMs: 5000,
} as const;

function seedGraph(db: Database): void {
	db.exec(`
		CREATE TABLE entities (id TEXT PRIMARY KEY, name TEXT, agent_id TEXT);
		CREATE TABLE entity_aspects (id TEXT PRIMARY KEY, entity_id TEXT, agent_id TEXT, weight REAL, canonical_name TEXT);
		CREATE TABLE entity_attributes (aspect_id TEXT, memory_id TEXT, agent_id TEXT, status TEXT, kind TEXT, content TEXT, importance REAL);
		CREATE TABLE entity_dependencies (id TEXT PRIMARY KEY, source_entity_id TEXT, target_entity_id TEXT, agent_id TEXT, confidence REAL, strength REAL);
		CREATE TABLE memories (id TEXT PRIMARY KEY, importance REAL, is_deleted INTEGER);
		CREATE TABLE memory_entity_mentions (memory_id TEXT, entity_id TEXT, confidence REAL);
		CREATE INDEX idx_entity_aspects_entity ON entity_aspects (entity_id);
		CREATE INDEX idx_entity_attributes_aspect ON entity_attributes (aspect_id);
		CREATE INDEX idx_entity_dependencies_source ON entity_dependencies (source_entity_id);
	`);
	db.exec(`INSERT INTO entities VALUES ('e1', 'Alpha', 'default'), ('e2', 'Beta', 'default')`);
	db.exec(
		`INSERT INTO entity_aspects VALUES ('a1', 'e1', 'default', 1.0, 'preference'), ('a2', 'e2', 'default', 1.0, 'fact')`,
	);
	db.exec(`INSERT INTO memories VALUES ('m1', 0.8, 0), ('m2', 0.6, 0), ('m3', 0.5, 0)`);
	db.exec(`INSERT INTO entity_attributes VALUES
		('a1', 'm1', 'default', 'active', 'fact', 'alpha fact', 0.9),
		('a1', 'm2', 'default', 'active', 'fact', 'alpha fact 2', 0.7),
		('a2', 'm3', 'default', 'active', 'fact', 'beta fact', 0.6)`);
	db.exec(`INSERT INTO entity_dependencies VALUES ('d1', 'e1', 'e2', 'default', 0.9, 0.8)`);
	db.exec(`INSERT INTO memory_entity_mentions VALUES ('m1', 'e1', 0.9)`);
}

describe("traverseKnowledgeGraph event-loop yields (#1118)", () => {
	let db: Database;

	beforeEach(() => {
		db = new Database(":memory:");
		seedGraph(db);
		invalidateTraversalCache();
	});

	afterEach(() => {
		db.close();
		invalidateTraversalCache();
	});

	test("yields to the event loop during the walk instead of blocking it", async () => {
		let loopBreaths = 0;
		let done = false;
		const breathe = (): void => {
			if (done) return;
			loopBreaths++;
			setImmediate(breathe);
		};
		setImmediate(breathe);

		const result = await traverseKnowledgeGraph(["e1"], db as unknown as ReadDb, "default", CONFIG);
		done = true;

		// The old synchronous walk resolved without a single macrotask
		// opportunity — loopBreaths would be 0 and this test would fail.
		expect(loopBreaths).toBeGreaterThan(0);
		// Result identity: the seeded graph still resolves through both phases.
		expect(result.memoryIds.has("m1")).toBe(true);
		expect(result.memoryIds.has("m3")).toBe(true);
		expect(result.entityCount).toBe(2);
	});

	test("concurrent traversals interleave instead of serializing", async () => {
		let loopBreaths = 0;
		let done = false;
		const breathe = (): void => {
			if (done) return;
			loopBreaths++;
			setImmediate(breathe);
		};
		setImmediate(breathe);

		const [first, second] = await Promise.all([
			traverseKnowledgeGraph(["e1"], db as unknown as ReadDb, "default", CONFIG),
			traverseKnowledgeGraph(["e2"], db as unknown as ReadDb, "default", CONFIG),
		]);
		done = true;

		expect(first.memoryIds.size).toBeGreaterThan(0);
		expect(second.memoryIds.has("m3")).toBe(true);
		expect(loopBreaths).toBeGreaterThan(0);
	});
});

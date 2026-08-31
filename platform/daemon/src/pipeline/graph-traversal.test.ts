/**
 * Regression test for #1118: traverseKnowledgeGraph was fully synchronous and
 * blocked the daemon event loop for the whole walk (~1.7s per session start on
 * a 102k-memory graph), serializing concurrent session starts and tripping the
 * pressure gate. The walk must yield to the event loop between batches.
 */

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { ReadDb } from "../db-accessor";
import type { DbOwnerClient } from "../db-owner-client";
import type { DbOwnerRequest } from "../db-owner-protocol";
import {
	invalidateTraversalCache,
	resolveFocalEntitiesViaOwner,
	traverseKnowledgeGraph,
	traverseKnowledgeGraphViaOwner,
} from "./graph-traversal";

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
	CREATE TABLE entities (id TEXT PRIMARY KEY, name TEXT, agent_id TEXT, canonical_name TEXT, mentions INTEGER DEFAULT 0);
		CREATE TABLE entity_aspects (id TEXT PRIMARY KEY, entity_id TEXT, agent_id TEXT, weight REAL, canonical_name TEXT);
		CREATE TABLE entity_attributes (aspect_id TEXT, memory_id TEXT, agent_id TEXT, status TEXT, kind TEXT, content TEXT, importance REAL);
		CREATE TABLE entity_dependencies (id TEXT PRIMARY KEY, source_entity_id TEXT, target_entity_id TEXT, agent_id TEXT, confidence REAL, strength REAL);
		CREATE TABLE memories (id TEXT PRIMARY KEY, importance REAL, is_deleted INTEGER);
		CREATE TABLE memory_entity_mentions (memory_id TEXT, entity_id TEXT, confidence REAL);
		CREATE INDEX idx_entity_aspects_entity ON entity_aspects (entity_id);
		CREATE INDEX idx_entity_attributes_aspect ON entity_attributes (aspect_id);
		CREATE INDEX idx_entity_dependencies_source ON entity_dependencies (source_entity_id);
	`);
	db.exec(
		`INSERT INTO entities (id, name, agent_id, canonical_name, mentions) VALUES
			('e1', 'Alpha', 'default', 'alpha', 2),
			('e2', 'Beta', 'default', 'beta', 1),
			('e3', 'Other', 'other', 'other', 1)`,
	);
	db.exec(
		`INSERT INTO entity_aspects VALUES
			('a1', 'e1', 'default', 1.0, 'preference'),
			('a2', 'e2', 'default', 1.0, 'fact'),
			('a3', 'e3', 'other', 1.0, 'fact')`,
	);
	db.exec(`INSERT INTO memories VALUES
		('m1', 0.8, 0),
		('m2', 0.6, 0),
		('m3', 0.5, 0),
		('m-other', 0.9, 0)`);
	db.exec(`INSERT INTO entity_attributes VALUES
		('a1', 'm1', 'default', 'active', 'fact', 'alpha fact', 0.9),
		('a1', 'm2', 'default', 'active', 'fact', 'alpha fact 2', 0.7),
		('a2', 'm3', 'default', 'active', 'fact', 'beta fact', 0.6),
		('a3', 'm-other', 'other', 'active', 'fact', 'other fact', 0.95)`);
	db.exec(`INSERT INTO entity_dependencies VALUES ('d1', 'e1', 'e2', 'default', 0.9, 0.8)`);
	db.exec(`INSERT INTO memory_entity_mentions VALUES ('m1', 'e1', 0.9)`);
}

function createTestOwner(db: Database, operations: string[]): DbOwnerClient {
	return {
		submit<Result>(request: DbOwnerRequest, options: { readonly operation: string }) {
			if (request.kind !== "query") throw new Error("test owner only supports query requests");
			operations.push(options.operation);
			const params = request.statement.params ?? [];
			if (params.some((param) => typeof param === "object")) throw new Error("unexpected test owner byte parameter");
			const statement = db.prepare(request.statement.sql);
			const value =
				request.statement.result === "get"
					? statement.get(...params)
					: request.statement.result === "all"
						? statement.all(...params)
						: statement.run(...params);
			return { result: Promise.resolve(value as Result) } as never;
		},
	} as unknown as DbOwnerClient;
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

	test("does not retain a read connection across traversal yields (#1348)", async () => {
		let activeReads = 0;
		let maxActiveReads = 0;
		let activeAtYield = 0;
		const read = <T>(fn: (readDb: ReadDb) => T): T => {
			activeReads++;
			maxActiveReads = Math.max(maxActiveReads, activeReads);
			try {
				const result = fn(db as unknown as ReadDb);
				setImmediate(() => {
					activeAtYield = Math.max(activeAtYield, activeReads);
				});
				return result;
			} finally {
				activeReads--;
			}
		};

		const result = await traverseKnowledgeGraph(["e1"], read, "default", CONFIG);
		await new Promise<void>((resolve) => setImmediate(resolve));

		expect(result.memoryIds.has("m1")).toBe(true);
		expect(result.memoryIds.has("m-other")).toBe(false);
		expect(maxActiveReads).toBe(1);
		expect(activeAtYield).toBe(0);
		expect(activeReads).toBe(0);
	});

	test("releases the read connection when a traversal query fails (#1348)", async () => {
		let activeReads = 0;
		const failingDb: ReadDb = {
			prepare(sql: string) {
				if (sql.includes("entity_dependencies")) throw new Error("injected traversal failure");
				return db.prepare(sql) as unknown as ReturnType<ReadDb["prepare"]>;
			},
		};
		const read = <T>(fn: (readDb: ReadDb) => T): T => {
			activeReads++;
			try {
				return fn(failingDb);
			} finally {
				activeReads--;
			}
		};

		const result = await traverseKnowledgeGraph(["e1"], read, "default", CONFIG);

		expect(result.memoryIds.size).toBe(0);
		expect(result.constraints).toEqual([]);
		expect(result.error).toEqual({ code: null, message: "injected traversal failure" });
		expect(activeReads).toBe(0);
	});

	test("routes focal resolution and traversal through the DB owner adapter", async () => {
		const operations: string[] = [];
		const owner = createTestOwner(db, operations);
		const focal = await resolveFocalEntitiesViaOwner(owner, "default", {
			checkpointEntityIds: ["e1"],
			includePinned: false,
		});
		const result = await traverseKnowledgeGraphViaOwner(focal.entityIds, owner, "default", CONFIG);

		expect(focal).toEqual({
			entityIds: ["e1"],
			entityNames: ["Alpha"],
			pinnedEntityIds: [],
			source: "checkpoint",
		});
		expect(result.memoryIds.has("m1")).toBe(true);
		expect(result.memoryIds.has("m3")).toBe(true);
		expect(operations.every((operation) => operation.startsWith("session-start.graph-"))).toBe(true);
	});

	test("falls back to LIKE when the owner FTS index has no matching row", async () => {
		db.exec("CREATE VIRTUAL TABLE entities_fts USING fts5(name)");
		const owner = createTestOwner(db, []);

		const focal = await resolveFocalEntitiesViaOwner(owner, "default", {
			queryTokens: ["alpha"],
			includePinned: false,
		});

		expect(focal).toEqual({
			entityIds: ["e1"],
			entityNames: ["Alpha"],
			pinnedEntityIds: [],
			source: "query",
		});
	});

	test("does not disclose a cross-agent checkpoint entity name", async () => {
		const owner = createTestOwner(db, []);

		const focal = await resolveFocalEntitiesViaOwner(owner, "default", {
			checkpointEntityIds: ["e3"],
			includePinned: false,
		});

		expect(focal.entityIds).toEqual(["e3"]);
		expect(focal.entityNames).toEqual([]);
	});
});

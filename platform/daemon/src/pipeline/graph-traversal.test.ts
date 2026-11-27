import { migrationFixtureDb } from "../test-support/migration-fixture-db";
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { ensureCompartmentShards } from "../../../core/src/compartment-shards";
import { runMigrations } from "../../../core/src/migrations";
import type { ReadDb } from "../db-accessor";
import type { DbOwnerClient } from "../db-owner-client";
import type { DbOwnerRequest } from "../db-owner-protocol";
import type { ReadScope } from "../read-scope";
import {
	invalidateTraversalCache,
	resolveFocalEntities,
	resolveFocalEntitiesViaOwner,
	traverseKnowledgeGraph,
	traverseKnowledgeGraphViaOwner,
} from "./graph-traversal";

const LOCAL: ReadScope = { reach: { kind: "own", agentId: "default" }, compartments: "all", projects: null };

const CONFIG = {
	readScope: LOCAL,
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
		CREATE TABLE memories (id TEXT PRIMARY KEY, importance REAL, is_deleted INTEGER, agent_id TEXT DEFAULT 'default', visibility TEXT DEFAULT 'global');
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
	db.exec(`INSERT INTO memories (id, importance, is_deleted, agent_id) VALUES
		('m1', 0.8, 0, 'default'),
		('m2', 0.6, 0, 'default'),
		('m3', 0.5, 0, 'default'),
		('m-other', 0.9, 0, 'other')`);
	db.exec(`INSERT INTO entity_attributes VALUES
		('a1', 'm1', 'default', 'active', 'fact', 'alpha fact', 0.9),
		('a1', 'm2', 'default', 'active', 'fact', 'alpha fact 2', 0.7),
		('a2', 'm3', 'default', 'active', 'fact', 'beta fact', 0.6),
		('a3', 'm-other', 'other', 'active', 'fact', 'other fact', 0.95)`);
	db.exec(`INSERT INTO entity_dependencies VALUES ('d1', 'e1', 'e2', 'default', 0.9, 0.8)`);
	db.exec(`INSERT INTO memory_entity_mentions VALUES ('m1', 'e1', 0.9)`);
}

function createTestOwner(db: Database, operations: string[], deadlines: number[] = []): DbOwnerClient {
	return {
		submit<Result>(request: DbOwnerRequest, options: { readonly operation: string; readonly deadlineMs: number }) {
			if (request.kind !== "query") throw new Error("test owner only supports query requests");
			operations.push(options.operation);
			deadlines.push(options.deadlineMs);
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

		const result = await traverseKnowledgeGraph(["e1"], db, "default", CONFIG);
		done = true;
		expect(loopBreaths).toBeGreaterThan(0);
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
			traverseKnowledgeGraph(["e1"], db, "default", CONFIG),
			traverseKnowledgeGraph(["e2"], db, "default", CONFIG),
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
				const result = fn(db);
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
			readScope: LOCAL,
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

	test("passes the traversal deadline budget to every owner query", async () => {
		const deadlines: number[] = [];
		const owner = createTestOwner(db, [], deadlines);
		const deadlineAt = Date.now() + 500;
		const focal = await resolveFocalEntitiesViaOwner(owner, "default", {
			checkpointEntityIds: ["e1"],
			includePinned: false,
			deadlineAt,
			readScope: LOCAL,
		});
		const result = await traverseKnowledgeGraphViaOwner(["e1"], owner, "default", {
			...CONFIG,
			timeoutMs: 500,
			deadlineAt,
		});

		expect(focal.entityIds).toEqual(["e1"]);
		expect(result.memoryIds.has("m1")).toBe(true);
		expect(deadlines.length).toBeGreaterThan(0);
		expect(deadlines.every((deadline) => deadline > 0 && deadline <= 500)).toBe(true);
	});

	test("reports an owner deadline as a partial timeout instead of an operational failure", async () => {
		const owner = createTestOwner(db, []);
		const originalSubmit = owner.submit.bind(owner);
		owner.submit = (request, options) => {
			if (options.operation === "session-start.graph-traversal.table-check") {
				const error = Object.assign(new Error("owner traversal deadline exceeded"), {
					code: "DB_OWNER_DEADLINE",
				});
				throw error;
			}
			return originalSubmit(request, options);
		};

		const result = await traverseKnowledgeGraphViaOwner(["e1"], owner, "default", CONFIG);

		expect(result.timedOut).toBe(true);
		expect(result.error).toBeUndefined();
		expect(result.memoryIds.size).toBe(0);
	});

	test("falls back to LIKE when the owner FTS index has no matching row", async () => {
		db.exec("CREATE VIRTUAL TABLE entities_fts USING fts5(name)");
		const owner = createTestOwner(db, []);

		const focal = await resolveFocalEntitiesViaOwner(owner, "default", {
			queryTokens: ["alpha"],
			includePinned: false,
			readScope: LOCAL,
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
			readScope: LOCAL,
		});

		expect(focal.entityIds).toEqual([]);
		expect(focal.entityNames).toEqual([]);
	});
});

describe("graph traversal read scope", () => {
	let db: Database;
	const now = "2026-11-25T00:00:00.000Z";
	const org: ReadScope = { reach: { kind: "all" }, compartments: [], projects: null };

	beforeEach(() => {
		db = new Database(":memory:");
		runMigrations(db as unknown as Parameters<typeof runMigrations>[0]);
		for (const id of ["alice", "bob"]) {
			db.prepare("INSERT OR IGNORE INTO agents (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)").run(
				id,
				id,
				now,
				now,
			);
		}
		db.prepare("INSERT INTO compartments (id, key, created_at) VALUES (1, 'cls_hr', ?)").run(now);
		ensureCompartmentShards(db as unknown as Parameters<typeof ensureCompartmentShards>[0], 1, 0);
		invalidateTraversalCache();
	});

	afterEach(() => {
		db.close();
		invalidateTraversalCache();
	});

	function entity(id: string, name: string, agent: string, compartment: number | null, pinned = 0): void {
		db.prepare(
			`INSERT INTO entities (id, name, canonical_name, entity_type, mentions, agent_id, compartment_id, pinned, pinned_at, created_at, updated_at)
			 VALUES (?, ?, ?, 'project', 1, ?, ?, ?, ?, ?, ?)`,
		).run(id, name, name.toLowerCase(), agent, compartment, pinned, pinned ? now : null, now, now);
	}

	function aspect(id: string, entityId: string, agent: string, compartment: number | null): void {
		db.prepare(
			`INSERT INTO entity_aspects (id, entity_id, agent_id, name, canonical_name, weight, compartment_id, created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, 1.0, ?, ?, ?)`,
		).run(id, entityId, agent, id, id, compartment, now, now);
	}

	function memory(id: string, agent: string, compartment: number | null): void {
		db.prepare(
			`INSERT OR IGNORE INTO memories (id, content, type, agent_id, compartment_id, importance, is_deleted, created_at, updated_at, updated_by)
			 VALUES (?, ?, 'fact', ?, ?, 0.5, 0, ?, ?, 'test')`,
		).run(id, `memory ${id}`, agent, compartment, now, now);
	}

	function attribute(
		id: string,
		aspectId: string,
		agent: string,
		memoryId: string | null,
		compartment: number | null,
		kind = "fact",
		importance = 0.5,
	): void {
		db.prepare(
			`INSERT INTO entity_attributes (id, aspect_id, agent_id, memory_id, kind, content, normalized_content, importance, status, compartment_id, created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)`,
		).run(id, aspectId, agent, memoryId, kind, `content ${id}`, `content ${id}`, importance, compartment, now, now);
	}

	function dependency(id: string, source: string, target: string, agent: string, compartment: number | null): void {
		db.prepare(
			`INSERT INTO entity_dependencies (id, source_entity_id, target_entity_id, agent_id, dependency_type, strength, confidence, compartment_id, created_at, updated_at)
			 VALUES (?, ?, ?, ?, 'uses', 0.9, 0.9, ?, ?, ?)`,
		).run(id, source, target, agent, compartment, now, now);
	}

	function mention(memoryId: string, entityId: string): void {
		db.prepare("INSERT INTO memory_entity_mentions (memory_id, entity_id, confidence) VALUES (?, ?, 0.9)").run(
			memoryId,
			entityId,
		);
	}

	function seedVisible(): void {
		entity("e-alpha", "Alpha", "alice", null);
		aspect("a-alpha", "e-alpha", "alice", null);
		memory("m-visible", "alice", null);
		attribute("at-visible", "a-alpha", "alice", "m-visible", null, "fact", 0.9);
		attribute("at-rule", "a-alpha", "alice", null, null, "constraint", 0.8);
		entity("e-beta", "Beta", "alice", null);
		aspect("a-beta", "e-beta", "alice", null);
		memory("m-beta", "alice", null);
		attribute("at-beta", "a-beta", "alice", "m-beta", null);
		dependency("d-visible", "e-alpha", "e-beta", "alice", null);
	}

	function seedHidden(): void {
		memory("m-hidden", "alice", 1);
		attribute("at-hidden-memory", "a-alpha", "alice", "m-hidden", null, "fact", 0.95);
		memory("m-hidden-attr", "alice", null);
		attribute("at-hidden", "a-alpha", "alice", "m-hidden-attr", 1, "fact", 0.99);
		attribute("at-hidden-rule", "a-alpha", "alice", null, 1, "constraint", 0.99);
		aspect("a-hidden", "e-alpha", "alice", 1);
		memory("m-hidden-aspect", "alice", null);
		attribute("at-under-hidden-aspect", "a-hidden", "alice", "m-hidden-aspect", null, "fact", 0.99);
		entity("e-gamma", "Gamma", "alice", 1);
		aspect("a-gamma", "e-gamma", "alice", null);
		memory("m-gamma", "alice", null);
		attribute("at-gamma", "a-gamma", "alice", "m-gamma", null);
		dependency("d-to-hidden", "e-alpha", "e-gamma", "alice", null);
		entity("e-delta", "Delta", "alice", null);
		aspect("a-delta", "e-delta", "alice", null);
		memory("m-delta", "alice", null);
		attribute("at-delta", "a-delta", "alice", "m-delta", null);
		dependency("d-hidden", "e-alpha", "e-delta", "alice", 1);
		mention("m-hidden", "e-alpha");
		memory("m-hidden-mention", "alice", null);
		mention("m-hidden-mention", "e-gamma");
	}

	function snapshot(result: Awaited<ReturnType<typeof traverseKnowledgeGraph>>) {
		return {
			memoryIds: [...result.memoryIds].sort(),
			scores: [...result.memoryScores.entries()].sort(),
			paths: [...result.memoryPaths.entries()].sort(),
			constraints: result.constraints,
			entityCount: result.entityCount,
			aspects: [...result.activeAspectIds].sort(),
			error: result.error,
		};
	}

	async function traverse(ids: string[], agentId: string, scope: ReadScope) {
		const config = { ...CONFIG, readScope: scope };
		const sync = snapshot(await traverseKnowledgeGraph(ids, db, agentId, config));
		const owned = snapshot(await traverseKnowledgeGraphViaOwner(ids, createTestOwner(db, []), agentId, config));
		expect(owned).toEqual(sync);
		return sync;
	}

	test("returns identical traversals whether hidden graph rows exist", async () => {
		seedVisible();
		const before = await traverse(["e-alpha"], "alice", org);
		expect(before.memoryIds).toEqual(["m-beta", "m-visible"]);
		expect(before.constraints.map((row) => row.content)).toEqual(["content at-rule"]);
		seedHidden();
		expect(await traverse(["e-alpha"], "alice", org)).toEqual(before);
	});

	test("keeps focal LIKE cutoffs identical when hidden mentions bump the global counter", async () => {
		db.exec(`DROP TRIGGER IF EXISTS entities_fts_ai; DROP TRIGGER IF EXISTS entities_fts_ad; DROP TRIGGER IF EXISTS entities_fts_au;
			DROP TRIGGER IF EXISTS entities_fts__c1_ai; DROP TRIGGER IF EXISTS entities_fts__c1_ad; DROP TRIGGER IF EXISTS entities_fts__c1_au;
			DROP TABLE entities_fts; DROP TABLE entities_fts__c1`);
		for (let index = 0; index < 21; index += 1) {
			const suffix = String(index).padStart(2, "0");
			entity(`e-orbit-${suffix}`, `Orbit ${suffix}`, "alice", null);
			memory(`m-orbit-${suffix}`, "alice", null);
			mention(`m-orbit-${suffix}`, `e-orbit-${suffix}`);
		}
		const outsider: ReadScope = { reach: { kind: "own", agentId: "alice" }, compartments: [], projects: null };
		const audience: ReadScope = { ...outsider, compartments: [1] };
		const owner = createTestOwner(db, []);
		const focal = async (scope: ReadScope, signals: { project?: string; queryTokens?: string[] }) => {
			const input = { ...signals, includePinned: false, readScope: scope };
			const sync = resolveFocalEntities(db, "alice", input);
			expect(await resolveFocalEntitiesViaOwner(owner, "alice", input)).toEqual(sync);
			return sync.entityIds;
		};
		const ids = (from: number, to: number) =>
			Array.from({ length: to - from }, (_, index) => `e-orbit-${String(from + index).padStart(2, "0")}`);
		const project = { project: "/work/orbit" };
		const query = { queryTokens: ["orbit"] };
		expect(await focal(outsider, project)).toEqual(ids(0, 5));
		expect(await focal(outsider, query)).toEqual(ids(0, 20));
		memory("m-hidden-orbit", "alice", 1);
		mention("m-hidden-orbit", "e-orbit-20");
		db.prepare("UPDATE entities SET mentions = mentions + 1 WHERE id = 'e-orbit-20'").run();
		expect(await focal(outsider, project)).toEqual(ids(0, 5));
		expect(await focal(outsider, query)).toEqual(ids(0, 20));
		expect(await focal(audience, project)).toEqual(["e-orbit-20", ...ids(0, 4)]);
		expect(await focal(audience, query)).toEqual(["e-orbit-20", ...ids(0, 19)]);
	});

	test("ranks focal LIKE candidates by readable mentions instead of a stale counter", async () => {
		for (const suffix of ["a", "b", "c", "d", "e", "f"]) entity(`e-lane-${suffix}`, `Lane ${suffix}`, "alice", null);
		db.prepare("UPDATE entities SET mentions = 50 WHERE id = 'e-lane-a'").run();
		memory("m-lane-f", "alice", null);
		mention("m-lane-f", "e-lane-f");
		const local: ReadScope = { reach: { kind: "own", agentId: "alice" }, compartments: "all", projects: null };
		const input = { project: "/work/lane", includePinned: false, readScope: local };
		const sync = resolveFocalEntities(db, "alice", input);
		expect(sync.entityIds).toEqual(["e-lane-f", "e-lane-a", "e-lane-b", "e-lane-c", "e-lane-d"]);
		expect(await resolveFocalEntitiesViaOwner(createTestOwner(db, []), "alice", input)).toEqual(sync);
		const all: ReadScope = { reach: { kind: "all" }, compartments: "all", projects: null };
		expect(resolveFocalEntities(db, "alice", { ...input, readScope: all }).entityIds).toEqual([
			"e-lane-a",
			"e-lane-b",
			"e-lane-c",
			"e-lane-d",
			"e-lane-e",
		]);
	});

	test("fails closed when a caller omits the read scope", async () => {
		seedVisible();
		const focal = Reflect.apply(resolveFocalEntities, undefined, [db, "alice", { checkpointEntityIds: ["e-alpha"] }]);
		expect(focal.entityIds).toEqual([]);
		const owned = await Reflect.apply(resolveFocalEntitiesViaOwner, undefined, [
			createTestOwner(db, []),
			"alice",
			{ checkpointEntityIds: ["e-alpha"] },
		]);
		expect(owned.entityIds).toEqual([]);
		const unscoped = { ...CONFIG, readScope: undefined };
		const traversal = await Reflect.apply(traverseKnowledgeGraph, undefined, [["e-alpha"], db, "alice", unscoped]);
		expect(traversal.memoryIds.size).toBe(0);
		const ownedTraversal = await Reflect.apply(traverseKnowledgeGraphViaOwner, undefined, [
			["e-alpha"],
			createTestOwner(db, []),
			"alice",
			unscoped,
		]);
		expect(ownedTraversal.memoryIds.size).toBe(0);
	});

	test("organization reach traverses every active agent without agent equality", async () => {
		entity("e-bob", "Bobby", "bob", null);
		aspect("a-bob", "e-bob", "bob", null);
		memory("m-bob", "bob", null);
		attribute("at-bob", "a-bob", "bob", "m-bob", null);
		expect((await traverse(["e-bob"], "alice", org)).memoryIds).toEqual(["m-bob"]);
	});

	test("project-restricted traversal fails closed on project-less graph rows", async () => {
		seedVisible();
		const result = await traverse(["e-alpha"], "alice", { ...org, projects: ["atlas"] });
		expect(result.memoryIds).toEqual([]);
		expect(result.constraints).toEqual([]);
	});

	test("focal resolution reads readable shards and treats hidden entities as absent", async () => {
		seedVisible();
		entity("e-hidden", "Hiddenproj", "alice", 1, 1);
		entity("e-shard", "Shardproj", "alice", 1);
		const owner = createTestOwner(db, []);
		const hidden = await resolveFocalEntitiesViaOwner(owner, "alice", {
			checkpointEntityIds: ["e-hidden", "e-alpha"],
			readScope: org,
		});
		expect(hidden).toEqual({
			entityIds: ["e-alpha"],
			entityNames: ["Alpha"],
			pinnedEntityIds: [],
			source: "checkpoint",
		});
		const syncHidden = resolveFocalEntities(db, "alice", {
			checkpointEntityIds: ["e-hidden", "e-alpha"],
			readScope: org,
		});
		expect(syncHidden).toEqual(hidden);
		const readable = { ...org, compartments: [1] };
		const query = await resolveFocalEntitiesViaOwner(owner, "alice", {
			queryTokens: ["shardproj"],
			includePinned: false,
			readScope: readable,
		});
		expect(query.entityIds).toEqual(["e-shard"]);
		expect(
			resolveFocalEntities(db, "alice", {
				queryTokens: ["shardproj"],
				includePinned: false,
				readScope: readable,
			}).entityIds,
		).toEqual(["e-shard"]);
		const pinned = await resolveFocalEntitiesViaOwner(owner, "bob", { readScope: readable });
		expect(pinned.pinnedEntityIds).toEqual(["e-hidden"]);
	});
});

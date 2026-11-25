import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { runMigrations } from "../../../core/src/migrations";
import { ensureCompartmentShards } from "../../../core/src/compartment-shards";
import type { ReadDb } from "../db-accessor";
import type { DbOwnerClient } from "../db-owner-client";
import type { DbOwnerRequest } from "../db-owner-protocol";
import type { ReadScope } from "../read-scope";
import { getGraphBoostIds, getGraphBoostIdsViaOwner } from "./graph-search";

function asReadDb(db: Database): ReadDb {
	return db as unknown as ReadDb;
}

describe("graph-search", () => {
	let db: Database;

	beforeEach(() => {
		db = new Database(":memory:");
		runMigrations(db as unknown as Parameters<typeof runMigrations>[0]);
	});

	afterEach(() => {
		db.close();
	});

	function seedEntityWithMemory(entityId: string, name: string, memoryId: string, mentions = 1): void {
		const now = new Date().toISOString();
		db.prepare(
			`INSERT OR IGNORE INTO entities (id, name, canonical_name, entity_type, mentions, created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?)`,
		).run(entityId, name, name.toLowerCase(), "extracted", mentions, now, now);

		db.prepare(
			`INSERT OR IGNORE INTO memories (id, content, type, is_deleted, created_at, updated_at, updated_by)
			 VALUES (?, ?, ?, 0, ?, ?, ?)`,
		).run(memoryId, `Memory about ${name}`, "fact", now, now, "test");

		db.prepare(
			`INSERT OR IGNORE INTO memory_entity_mentions (memory_id, entity_id)
			 VALUES (?, ?)`,
		).run(memoryId, entityId);
	}

	it("returns linked memory IDs for matching entity", () => {
		seedEntityWithMemory("ent-1", "TypeScript", "mem-ts");

		const result = getGraphBoostIds("typescript guide", asReadDb(db), 5000);

		expect(result.timedOut).toBe(false);
		expect(result.entityHits).toBe(1);
		expect(result.graphLinkedIds.has("mem-ts")).toBe(true);
	});

	it("includes one-hop neighbor memories", () => {
		const now = new Date().toISOString();
		seedEntityWithMemory("ent-react", "React", "mem-react");
		seedEntityWithMemory("ent-jsx", "JSX", "mem-jsx");
		db.prepare(
			`INSERT INTO relations (id, source_entity_id, target_entity_id, relation_type, strength, mentions, confidence, created_at)
			 VALUES (?, ?, ?, ?, 1.0, 1, 0.9, ?)`,
		).run("rel-1", "ent-react", "ent-jsx", "uses", now);

		const result = getGraphBoostIds("react", asReadDb(db), 5000);

		expect(result.graphLinkedIds.has("mem-react")).toBe(true);
		expect(result.graphLinkedIds.has("mem-jsx")).toBe(true);
	});

	it("returns timedOut with empty set for zero timeout", () => {
		seedEntityWithMemory("ent-1", "Python", "mem-py");

		const result = getGraphBoostIds("python", asReadDb(db), 0);
		expect(typeof result.timedOut).toBe("boolean");
	});

	it("returns empty set when no entities match", () => {
		const result = getGraphBoostIds("nonexistent thing", asReadDb(db), 5000);

		expect(result.graphLinkedIds.size).toBe(0);
		expect(result.entityHits).toBe(0);
		expect(result.timedOut).toBe(false);
	});

	it("excludes deleted memories from results", () => {
		const now = new Date().toISOString();
		db.prepare(
			`INSERT INTO entities (id, name, canonical_name, entity_type, mentions, created_at, updated_at)
			 VALUES (?, ?, ?, ?, 1, ?, ?)`,
		).run("ent-del", "Deleted", "deleted", "extracted", now, now);

		db.prepare(
			`INSERT INTO memories (id, content, type, is_deleted, deleted_at, created_at, updated_at, updated_by)
			 VALUES (?, ?, ?, 1, ?, ?, ?, ?)`,
		).run("mem-del", "Deleted memory", "fact", now, now, now, "test");

		db.prepare(
			`INSERT INTO memory_entity_mentions (memory_id, entity_id)
			 VALUES (?, ?)`,
		).run("mem-del", "ent-del");

		const result = getGraphBoostIds("deleted", asReadDb(db), 5000);

		expect(result.graphLinkedIds.size).toBe(0);
	});
});

function scopedOwner(db: Database): DbOwnerClient {
	return {
		submit<Result>(request: DbOwnerRequest) {
			if (request.kind !== "query") throw new Error("test owner only supports query requests");
			const params = request.statement.params ?? [];
			const value = db.prepare(request.statement.sql).all(...params);
			return { result: Promise.resolve(value as Result) } as never;
		},
	} as unknown as DbOwnerClient;
}

describe("graph-search read scope", () => {
	let db: Database;
	const org: ReadScope = { reach: { kind: "all" }, compartments: [], projects: null };
	const now = "2026-11-25T00:00:00.000Z";

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
	});

	afterEach(() => {
		db.close();
	});

	function entity(id: string, name: string, agent: string, compartment: number | null): void {
		db.prepare(
			`INSERT INTO entities (id, name, canonical_name, entity_type, mentions, agent_id, compartment_id, created_at, updated_at)
			 VALUES (?, ?, ?, 'extracted', 1, ?, ?, ?, ?)`,
		).run(id, name, name.toLowerCase(), agent, compartment, now, now);
	}

	function memory(id: string, agent: string, compartment: number | null, entityId: string): void {
		db.prepare(
			`INSERT OR IGNORE INTO memories (id, content, type, agent_id, compartment_id, is_deleted, created_at, updated_at, updated_by)
			 VALUES (?, ?, 'fact', ?, ?, 0, ?, ?, 'test')`,
		).run(id, `memory ${id}`, agent, compartment, now, now);
		db.prepare("INSERT INTO memory_entity_mentions (memory_id, entity_id) VALUES (?, ?)").run(id, entityId);
	}

	async function both(query: string, agentId: string, scope: ReadScope): Promise<string[][]> {
		const sync = [...getGraphBoostIds(query, asReadDb(db), 5000, agentId, scope).graphLinkedIds].sort();
		const owned = [
			...(await getGraphBoostIdsViaOwner(query, scopedOwner(db), 5000, agentId, scope)).graphLinkedIds,
		].sort();
		return [sync, owned];
	}

	it("lets organization reach read entities of every active agent", async () => {
		entity("ent-k8s", "Kubernetes", "bob", null);
		memory("mem-bob", "bob", null, "ent-k8s");
		expect(await both("kubernetes", "alice", org)).toEqual([["mem-bob"], ["mem-bob"]]);
	});

	it("returns identical results whether hidden entities, mentions and neighbors exist", async () => {
		entity("ent-k8s", "Kubernetes", "alice", null);
		memory("mem-visible", "alice", null, "ent-k8s");
		const before = await both("kubernetes", "alice", org);
		expect(before).toEqual([["mem-visible"], ["mem-visible"]]);
		memory("mem-hidden", "alice", 1, "ent-k8s");
		entity("ent-secret", "Kubernetes Secret", "alice", 1);
		memory("mem-through-hidden", "alice", null, "ent-secret");
		db.prepare(
			`INSERT INTO relations (id, source_entity_id, target_entity_id, relation_type, strength, mentions, confidence, created_at)
			 VALUES ('rel-hidden', 'ent-k8s', 'ent-secret', 'uses', 1.0, 1, 0.9, ?)`,
		).run(now);
		expect(await both("kubernetes", "alice", org)).toEqual(before);
	});

	it("reads readable compartment FTS shards", async () => {
		entity("ent-zk", "Zookeeper", "alice", 1);
		memory("mem-zk", "alice", null, "ent-zk");
		expect(await both("zookeeper", "alice", org)).toEqual([[], []]);
		expect(await both("zookeeper", "alice", { ...org, compartments: [1] })).toEqual([["mem-zk"], ["mem-zk"]]);
	});

	it("fails closed for project-restricted reads of project-less entities", async () => {
		entity("ent-k8s", "Kubernetes", "alice", null);
		memory("mem-visible", "alice", null, "ent-k8s");
		expect(await both("kubernetes", "alice", { ...org, projects: ["atlas"] })).toEqual([[], []]);
	});

	it("keeps entity reach own for shared memory scopes", async () => {
		entity("ent-k8s", "Kubernetes", "bob", null);
		memory("mem-bob", "bob", null, "ent-k8s");
		const shared: ReadScope = { reach: { kind: "shared", agentId: "alice" }, compartments: "all", projects: null };
		expect(await both("kubernetes", "alice", shared)).toEqual([[], []]);
	});
});

describe("graph-search without an entity FTS index", () => {
	it("falls back to scoped LIKE matching on both paths", async () => {
		const db = new Database(":memory:");
		try {
			runMigrations(db as unknown as Parameters<typeof runMigrations>[0]);
			db.exec(
				"DROP TRIGGER IF EXISTS entities_fts_ai; DROP TRIGGER IF EXISTS entities_fts_ad; DROP TRIGGER IF EXISTS entities_fts_au; DROP TABLE entities_fts",
			);
			const now = "2026-11-25T00:00:00.000Z";
			db.prepare(
				`INSERT INTO entities (id, name, canonical_name, entity_type, mentions, agent_id, created_at, updated_at)
				 VALUES ('ent-like', 'Likeable', 'likeable', 'extracted', 1, 'default', ?, ?)`,
			).run(now, now);
			db.prepare(
				`INSERT INTO memories (id, content, type, agent_id, is_deleted, created_at, updated_at, updated_by)
				 VALUES ('mem-like', 'like memory', 'fact', 'default', 0, ?, ?, 'test')`,
			).run(now, now);
			db.prepare("INSERT INTO memory_entity_mentions (memory_id, entity_id) VALUES ('mem-like', 'ent-like')").run();
			expect([...getGraphBoostIds("likeable", asReadDb(db), 5000).graphLinkedIds]).toEqual(["mem-like"]);
			expect([...(await getGraphBoostIdsViaOwner("likeable", scopedOwner(db), 5000)).graphLinkedIds]).toEqual([
				"mem-like",
			]);
		} finally {
			db.close();
		}
	});
});

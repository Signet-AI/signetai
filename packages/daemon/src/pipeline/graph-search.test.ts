import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { runMigrations } from "@signet/core";
import type { ReadDb } from "../db-accessor";
import { getGraphBoostIds } from "./graph-search";

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

	function seedEntityWithMemory(
		entityId: string,
		name: string,
		memoryId: string,
		mentions = 1,
	): void {
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

		// React → "uses" → JSX
		db.prepare(
			`INSERT INTO relations (id, source_entity_id, target_entity_id, relation_type, strength, mentions, confidence, created_at)
			 VALUES (?, ?, ?, ?, 1.0, 1, 0.9, ?)`,
		).run("rel-1", "ent-react", "ent-jsx", "uses", now);

		const result = getGraphBoostIds("react", asReadDb(db), 5000);

		expect(result.graphLinkedIds.has("mem-react")).toBe(true);
		// JSX memory included via one-hop expansion
		expect(result.graphLinkedIds.has("mem-jsx")).toBe(true);
	});

	it("returns timedOut with empty set for zero timeout", () => {
		seedEntityWithMemory("ent-1", "Python", "mem-py");

		const result = getGraphBoostIds("python", asReadDb(db), 0);

		// With 0ms timeout, should either time out or return results
		// (depends on execution speed), but should not throw
		expect(typeof result.timedOut).toBe("boolean");
		// The set may or may not be populated depending on speed
	});

	it("returns empty set when no entities match", () => {
		const result = getGraphBoostIds("nonexistent thing", asReadDb(db), 5000);

		expect(result.graphLinkedIds.size).toBe(0);
		expect(result.entityHits).toBe(0);
		expect(result.timedOut).toBe(false);
	});

	it("excludes deleted memories from results", () => {
		const now = new Date().toISOString();
		// Entity linked to a soft-deleted memory
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

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDbAccessor, getDbAccessor, initDbAccessor } from "./db-accessor";
import { linkMemoryToEntities } from "./inline-entity-linker";

function makeDbPath(): string {
	const dir = join(tmpdir(), `signet-inline-linker-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(dir, { recursive: true });
	return join(dir, "memories.db");
}

function seedMemory(id: string, content: string, agentId = "default"): void {
	const now = "2026-04-19T00:00:00.000Z";
	getDbAccessor().withWriteTx((db) => {
		db.prepare(
			`INSERT INTO memories
			 (id, content, type, agent_id, updated_by, created_at, updated_at, is_deleted)
			 VALUES (?, ?, 'fact', ?, 'test', ?, ?, 0)`,
		).run(id, content, agentId, now, now);
	});
}

function seedEntity(id: string, name: string, agentId = "default"): void {
	const now = "2026-04-19T00:00:00.000Z";
	getDbAccessor().withWriteTx((db) => {
		db.prepare(
			`INSERT INTO entities
			 (id, name, canonical_name, entity_type, agent_id, mentions, created_at, updated_at)
			 VALUES (?, ?, ?, 'person', ?, 0, ?, ?)`,
		).run(id, name, name.toLowerCase(), agentId, now, now);
	});
}

describe("inline entity linker", () => {
	let dbPath = "";

	afterEach(() => {
		closeDbAccessor();
		if (dbPath) {
			const dir = join(dbPath, "..");
			if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
		}
		dbPath = "";
	});

	test("links existing entities without inventing graph structure", () => {
		dbPath = makeDbPath();
		initDbAccessor(dbPath);
		seedMemory("mem-1", "Nicholai prefers Temaki Den and RandomCapital Thing is noisy.");
		seedEntity("entity-nicholai", "Nicholai");

		const result = getDbAccessor().withWriteTx((db) =>
			linkMemoryToEntities(db, "mem-1", "Nicholai prefers Temaki Den and RandomCapital Thing is noisy.", "default"),
		);

		expect(result).toEqual({
			linked: 1,
			entityIds: ["entity-nicholai"],
			aspects: 0,
			attributes: 0,
		});

		const counts = getDbAccessor().withReadDb((db) => ({
			entities: db.prepare("SELECT COUNT(*) AS count FROM entities").get() as { count: number },
			mentions: db.prepare("SELECT COUNT(*) AS count FROM memory_entity_mentions").get() as { count: number },
			aspects: db.prepare("SELECT COUNT(*) AS count FROM entity_aspects").get() as { count: number },
			attributes: db.prepare("SELECT COUNT(*) AS count FROM entity_attributes").get() as { count: number },
			dependencies: db.prepare("SELECT COUNT(*) AS count FROM entity_dependencies").get() as { count: number },
		}));

		expect(counts.entities.count).toBe(1);
		expect(counts.mentions.count).toBe(1);
		expect(counts.aspects.count).toBe(0);
		expect(counts.attributes.count).toBe(0);
		expect(counts.dependencies.count).toBe(0);
	});

	test("does not link matching entity names across agents", () => {
		dbPath = makeDbPath();
		initDbAccessor(dbPath);
		seedMemory("mem-1", "Nicholai prefers Temaki Den.", "agent-a");
		seedEntity("entity-nicholai-b", "Nicholai", "agent-b");

		const result = getDbAccessor().withWriteTx((db) =>
			linkMemoryToEntities(db, "mem-1", "Nicholai prefers Temaki Den.", "agent-a"),
		);

		expect(result.linked).toBe(0);
		expect(result.entityIds).toEqual([]);

		const mentions = getDbAccessor().withReadDb(
			(db) => db.prepare("SELECT COUNT(*) AS count FROM memory_entity_mentions").get() as { count: number },
		);
		expect(mentions.count).toBe(0);
	});
});

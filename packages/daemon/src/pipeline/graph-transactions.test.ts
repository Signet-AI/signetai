import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { runMigrations } from "@signet/core";
import type { WriteDb } from "../db-accessor";
import {
	txPersistEntities,
	txDecrementEntityMentions,
	txPersistStructured,
} from "./graph-transactions";

function asWriteDb(db: Database): WriteDb {
	return db as unknown as WriteDb;
}

describe("graph-transactions", () => {
	let db: Database;

	beforeEach(() => {
		db = new Database(":memory:");
		runMigrations(db as unknown as Parameters<typeof runMigrations>[0]);
	});

	afterEach(() => {
		db.close();
	});

	describe("txPersistEntities", () => {
		it("persists a single triple as 2 entities + 1 relation + 2 mention links", () => {
			const result = txPersistEntities(asWriteDb(db), {
				entities: [
					{
						source: "Alice",
						relationship: "works_with",
						target: "Bob",
						confidence: 0.9,
					},
				],
				sourceMemoryId: "mem-1",
				extractedAt: new Date().toISOString(),
				agentId: "default",
			});

			expect(result.entitiesInserted).toBe(2);
			expect(result.entitiesUpdated).toBe(0);
			expect(result.relationsInserted).toBe(1);
			expect(result.relationsUpdated).toBe(0);
			expect(result.mentionsLinked).toBe(2);

			const entities = db
				.query("SELECT name, canonical_name, mentions FROM entities ORDER BY name")
				.all() as Array<{ name: string; canonical_name: string; mentions: number }>;
			expect(entities).toHaveLength(2);
			expect(entities[0].name).toBe("Alice");
			expect(entities[0].canonical_name).toBe("alice");
			expect(entities[0].mentions).toBe(1);

			const relations = db
				.query("SELECT relation_type, strength, mentions, confidence FROM relations")
				.all() as Array<{
				relation_type: string;
				strength: number;
				mentions: number;
				confidence: number;
			}>;
			expect(relations).toHaveLength(1);
			expect(relations[0].relation_type).toBe("works_with");
			expect(relations[0].strength).toBe(1.0);
			expect(relations[0].mentions).toBe(1);
			expect(relations[0].confidence).toBe(0.9);

			const mentions = db
				.query("SELECT memory_id, entity_id FROM memory_entity_mentions")
				.all() as Array<{ memory_id: string; entity_id: string }>;
			expect(mentions).toHaveLength(2);
		});

		it("deduplicates entities by canonical_name (case-insensitive)", () => {
			const now = new Date().toISOString();

			const first = txPersistEntities(asWriteDb(db), {
				entities: [
					{ source: "User", relationship: "likes", target: "Cats", confidence: 0.8 },
				],
				sourceMemoryId: "mem-1",
				extractedAt: now,
				agentId: "default",
			});
			expect(first.entitiesInserted).toBe(2);
			expect(first.entitiesUpdated).toBe(0);

			const second = txPersistEntities(asWriteDb(db), {
				entities: [
					{ source: "user", relationship: "likes", target: "cats", confidence: 0.7 },
				],
				sourceMemoryId: "mem-2",
				extractedAt: now,
				agentId: "default",
			});
			// Same canonical names — updates, not inserts
			expect(second.entitiesInserted).toBe(0);
			expect(second.entitiesUpdated).toBe(2);
			expect(second.relationsInserted).toBe(0);
			expect(second.relationsUpdated).toBe(1);

			const entities = db
				.query("SELECT canonical_name, mentions FROM entities ORDER BY canonical_name")
				.all() as Array<{ canonical_name: string; mentions: number }>;
			expect(entities).toHaveLength(2);
			expect(entities[0].canonical_name).toBe("cats");
			expect(entities[0].mentions).toBe(2);
			expect(entities[1].canonical_name).toBe("user");
			expect(entities[1].mentions).toBe(2);
		});

		it("accumulates relation mentions and averages confidence", () => {
			const now = new Date().toISOString();

			txPersistEntities(asWriteDb(db), {
				entities: [
					{ source: "A", relationship: "related_to", target: "B", confidence: 0.8 },
				],
				sourceMemoryId: "mem-1",
				extractedAt: now,
				agentId: "default",
			});

			txPersistEntities(asWriteDb(db), {
				entities: [
					{ source: "A", relationship: "related_to", target: "B", confidence: 0.6 },
				],
				sourceMemoryId: "mem-2",
				extractedAt: now,
				agentId: "default",
			});

			const relations = db
				.query("SELECT mentions, confidence FROM relations")
				.all() as Array<{ mentions: number; confidence: number }>;
			expect(relations).toHaveLength(1);
			expect(relations[0].mentions).toBe(2);
			// Running average: (0.8 * 1 + 0.6) / 2 = 0.7
			expect(relations[0].confidence).toBeCloseTo(0.7);
		});

		it("handles idempotent mention links (same memory+entity pair)", () => {
			const now = new Date().toISOString();

			txPersistEntities(asWriteDb(db), {
				entities: [
					{ source: "X", relationship: "uses", target: "Y", confidence: 0.9 },
				],
				sourceMemoryId: "mem-1",
				extractedAt: now,
				agentId: "default",
			});

			// Same triple, same memory — mention links should not duplicate
			const result = txPersistEntities(asWriteDb(db), {
				entities: [
					{ source: "X", relationship: "uses", target: "Y", confidence: 0.9 },
				],
				sourceMemoryId: "mem-1",
				extractedAt: now,
				agentId: "default",
			});

			// Mentions were ignored (INSERT OR IGNORE)
			expect(result.mentionsLinked).toBe(0);

			const mentions = db
				.query("SELECT * FROM memory_entity_mentions")
				.all();
			expect(mentions).toHaveLength(2);
		});

		it("records reasoned related_to audit history for structured co-occurrences", () => {
			const now = new Date().toISOString();

			txPersistStructured(asWriteDb(db), {
				entities: [
					{ source: "Alpha", relationship: "uses", target: "Bravo", confidence: 0.9 },
					{ source: "Alpha", relationship: "uses", target: "Charlie", confidence: 0.8 },
				],
				aspects: [
					{
						entityName: "Bravo",
						aspect: "role",
						attributes: [{ content: "is part of the same workflow" }],
					},
					{
						entityName: "Charlie",
						aspect: "role",
						attributes: [{ content: "is part of the same workflow" }],
					},
				],
				sourceMemoryId: "mem-audit",
				content: "Alpha uses Bravo and Charlie together in the same workflow.",
				agentId: "default",
				now,
			});

			const dep = db
				.query(
					`SELECT reason
					 FROM entity_dependencies
					 WHERE source_entity_id IN (
					 	SELECT id FROM entities WHERE canonical_name = 'bravo'
					 )
					   AND target_entity_id IN (
					 	SELECT id FROM entities WHERE canonical_name = 'charlie'
					 )
					   AND dependency_type = 'related_to'`,
				)
				.get() as { reason: string } | undefined;
			expect(dep?.reason).toContain("mem-audit");

			const hist = db
				.query(
					`SELECT event, changed_by, reason, metadata
					 FROM entity_dependency_history
					 WHERE changed_by = 'db-trigger'
					 ORDER BY created_at DESC
					 LIMIT 1`,
				)
				.get() as
				| {
						event: string;
						changed_by: string;
						reason: string;
						metadata: string | null;
				  }
				| undefined;
			expect(hist?.event).toBe("created");
			expect(hist?.changed_by).toBe("db-trigger");
			expect(hist?.reason).toContain("mem-audit");
			expect(hist?.metadata).toContain("trg_entity_dependencies_audit_insert");
		});

		it("records delete audit history via DB trigger when dependency is removed", () => {
			const now = new Date().toISOString();

			txPersistStructured(asWriteDb(db), {
				entities: [
					{ source: "Alpha", relationship: "uses", target: "Bravo", confidence: 0.9 },
					{ source: "Alpha", relationship: "uses", target: "Charlie", confidence: 0.8 },
				],
				aspects: [
					{
						entityName: "Bravo",
						aspect: "role",
						attributes: [{ content: "is part of the same workflow" }],
					},
					{
						entityName: "Charlie",
						aspect: "role",
						attributes: [{ content: "is part of the same workflow" }],
					},
				],
				sourceMemoryId: "mem-delete-audit",
				content: "Alpha uses Bravo and Charlie together in the same workflow.",
				agentId: "default",
				now,
			});

			const dep = db
				.query(
					`SELECT id, reason
					 FROM entity_dependencies
					 WHERE source_entity_id IN (
					 	SELECT id FROM entities WHERE canonical_name = 'bravo'
					 )
					   AND target_entity_id IN (
					 	SELECT id FROM entities WHERE canonical_name = 'charlie'
					 )
					   AND dependency_type = 'related_to'`,
				)
				.get() as { id: string; reason: string } | undefined;
			expect(dep).toBeDefined();

			// Delete the dependency — the DB trigger should capture this as a history record.
			db.prepare("DELETE FROM entity_dependencies WHERE id = ?").run(dep!.id);

			expect(
				db.prepare("SELECT id FROM entity_dependencies WHERE id = ?").get(dep!.id),
			).toBeNull();

			const hist = db
				.query(
					`SELECT event, changed_by, reason, metadata
					 FROM entity_dependency_history
					 WHERE dependency_id = ? AND event = 'deleted'
					 ORDER BY rowid DESC
					 LIMIT 1`,
				)
				.get(dep!.id) as
				| { event: string; changed_by: string; reason: string; metadata: string | null }
				| undefined;
			expect(hist?.event).toBe("deleted");
			expect(hist?.changed_by).toBe("db-trigger");
			expect(hist?.metadata).toContain("trg_entity_dependencies_audit_delete");
		});
	});

	describe("txDecrementEntityMentions", () => {
		it("deletes entity with 1 mention after decrement", () => {
			const now = new Date().toISOString();
			db.prepare(
				`INSERT INTO entities (id, name, canonical_name, entity_type, mentions, created_at, updated_at)
				 VALUES (?, ?, ?, ?, 1, ?, ?)`,
			).run("ent-1", "Solo", "solo", "extracted", now, now);

			const result = txDecrementEntityMentions(asWriteDb(db), {
				entityIds: ["ent-1"],
			});

			expect(result.entitiesOrphaned).toBe(1);
			expect(
				db.prepare("SELECT id FROM entities WHERE id = ?").get("ent-1"),
			).toBeNull();
		});

		it("preserves entity with multiple mentions after single decrement", () => {
			const now = new Date().toISOString();
			db.prepare(
				`INSERT INTO entities (id, name, canonical_name, entity_type, mentions, created_at, updated_at)
				 VALUES (?, ?, ?, ?, 3, ?, ?)`,
			).run("ent-2", "Popular", "popular", "extracted", now, now);

			const result = txDecrementEntityMentions(asWriteDb(db), {
				entityIds: ["ent-2"],
			});

			expect(result.entitiesOrphaned).toBe(0);
			const row = db
				.prepare("SELECT mentions FROM entities WHERE id = ?")
				.get("ent-2") as { mentions: number };
			expect(row.mentions).toBe(2);
		});

		it("cleans dangling relations when entity is orphaned", () => {
			const now = new Date().toISOString();
			db.prepare(
				`INSERT INTO entities (id, name, canonical_name, entity_type, mentions, created_at, updated_at)
				 VALUES (?, ?, ?, ?, 1, ?, ?)`,
			).run("ent-a", "Alpha", "alpha", "extracted", now, now);
			db.prepare(
				`INSERT INTO entities (id, name, canonical_name, entity_type, mentions, created_at, updated_at)
				 VALUES (?, ?, ?, ?, 5, ?, ?)`,
			).run("ent-b", "Beta", "beta", "extracted", now, now);

			db.prepare(
				`INSERT INTO relations (id, source_entity_id, target_entity_id, relation_type, strength, mentions, confidence, created_at)
				 VALUES (?, ?, ?, ?, 1.0, 1, 0.8, ?)`,
			).run("rel-1", "ent-a", "ent-b", "links_to", now);

			txDecrementEntityMentions(asWriteDb(db), {
				entityIds: ["ent-a"],
			});

			// Alpha orphaned and deleted
			expect(
				db.prepare("SELECT id FROM entities WHERE id = ?").get("ent-a"),
			).toBeNull();
			// Beta still exists
			expect(
				db.prepare("SELECT id FROM entities WHERE id = ?").get("ent-b"),
			).toBeTruthy();
			// Dangling relation cleaned
			expect(
				db.prepare("SELECT id FROM relations WHERE id = ?").get("rel-1"),
			).toBeNull();
		});

		it("returns zero for empty input", () => {
			const result = txDecrementEntityMentions(asWriteDb(db), {
				entityIds: [],
			});
			expect(result.entitiesOrphaned).toBe(0);
		});
	});
});

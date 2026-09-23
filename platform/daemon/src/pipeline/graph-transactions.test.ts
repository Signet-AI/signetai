import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { runMigrations } from "../../../core/src/migrations";
import type { WriteDb } from "../db-accessor";
import { txDecrementEntityMentions } from "./graph-transactions";

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
			expect(db.prepare("SELECT id FROM entities WHERE id = ?").get("ent-1")).toBeNull();
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
			const row = db.prepare("SELECT mentions FROM entities WHERE id = ?").get("ent-2") as { mentions: number };
			expect(row.mentions).toBe(2);
		});

		it("does not delete another agent's unrelated zero-mention entity", () => {
			const now = new Date().toISOString();
			db.prepare(
				`INSERT INTO entities (id, name, canonical_name, entity_type, agent_id, mentions, created_at, updated_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
			).run("ent-owner", "Owner", "owner", "project", "agent-a", 1, now, now);
			db.prepare(
				`INSERT INTO entities (id, name, canonical_name, entity_type, agent_id, mentions, created_at, updated_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
			).run("ent-other", "Other", "other", "project", "agent-b", 0, now, now);

			const result = txDecrementEntityMentions(asWriteDb(db), { entityIds: ["ent-owner"] });

			expect(result.entitiesOrphaned).toBe(1);
			expect(db.prepare("SELECT id FROM entities WHERE id = ?").get("ent-owner")).toBeNull();
			expect(db.prepare("SELECT id FROM entities WHERE id = ?").get("ent-other")).toBeTruthy();
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
			expect(db.prepare("SELECT id FROM entities WHERE id = ?").get("ent-a")).toBeNull();
			// Beta still exists
			expect(db.prepare("SELECT id FROM entities WHERE id = ?").get("ent-b")).toBeTruthy();
			// Dangling relation cleaned
			expect(db.prepare("SELECT id FROM relations WHERE id = ?").get("rel-1")).toBeNull();
		});

		it("returns zero for empty input", () => {
			const result = txDecrementEntityMentions(asWriteDb(db), {
				entityIds: [],
			});
			expect(result.entitiesOrphaned).toBe(0);
		});
	});
});

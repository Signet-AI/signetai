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

	function insertEntity(id: string, name: string, mentions: number): void {
		const now = new Date().toISOString();
		db.prepare(
			`INSERT INTO entities (id, name, canonical_name, entity_type, mentions, created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?)`,
		).run(id, name, name.toLowerCase(), "extracted", mentions, now, now);
	}

	function mentionsOf(id: string): number | null {
		const row = db.prepare("SELECT mentions FROM entities WHERE id = ?").get(id) as { mentions: number } | null;
		return row?.mentions ?? null;
	}

	describe("txDecrementEntityMentions", () => {
		it("keeps an entity whose mention count reaches zero", () => {
			insertEntity("ent-1", "Solo", 1);

			txDecrementEntityMentions(asWriteDb(db), { entityIds: ["ent-1"] });

			expect(mentionsOf("ent-1")).toBe(0);
		});

		it("decrements an entity with multiple mentions by one", () => {
			insertEntity("ent-2", "Popular", 3);

			txDecrementEntityMentions(asWriteDb(db), { entityIds: ["ent-2"] });

			expect(mentionsOf("ent-2")).toBe(2);
		});

		it("never decrements below zero", () => {
			insertEntity("ent-3", "Empty", 0);

			txDecrementEntityMentions(asWriteDb(db), { entityIds: ["ent-3"] });

			expect(mentionsOf("ent-3")).toBe(0);
		});

		it("keeps relations of an entity whose mention count reaches zero", () => {
			const now = new Date().toISOString();
			insertEntity("ent-a", "Alpha", 1);
			insertEntity("ent-b", "Beta", 5);
			db.prepare(
				`INSERT INTO relations (id, source_entity_id, target_entity_id, relation_type, strength, mentions, confidence, created_at)
				 VALUES (?, ?, ?, ?, 1.0, 1, 0.8, ?)`,
			).run("rel-1", "ent-a", "ent-b", "links_to", now);

			txDecrementEntityMentions(asWriteDb(db), { entityIds: ["ent-a"] });

			expect(mentionsOf("ent-a")).toBe(0);
			expect(db.prepare("SELECT id FROM relations WHERE id = ?").get("rel-1")).toBeTruthy();
		});

		it("does nothing for empty input", () => {
			insertEntity("ent-4", "Untouched", 2);

			txDecrementEntityMentions(asWriteDb(db), { entityIds: [] });

			expect(mentionsOf("ent-4")).toBe(2);
		});
	});
});

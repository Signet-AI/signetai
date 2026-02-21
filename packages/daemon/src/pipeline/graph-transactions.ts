/**
 * Graph entity/relation persistence for the extraction pipeline.
 *
 * Separated from transactions.ts (which handles memory CRUD) to keep
 * both files under the 700 LOC soft cap.
 *
 * All functions expect to run inside a withWriteTx closure.
 */

import type { WriteDb } from "../db-accessor";
import type { ExtractedEntity } from "@signet/core";
import { countChanges } from "../db-helpers";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PersistEntitiesInput {
	readonly entities: readonly ExtractedEntity[];
	readonly sourceMemoryId: string;
	readonly extractedAt: string;
}

export interface PersistEntitiesResult {
	readonly entitiesInserted: number;
	readonly entitiesUpdated: number;
	readonly relationsInserted: number;
	readonly relationsUpdated: number;
	readonly mentionsLinked: number;
}

export interface DecrementInput {
	readonly entityIds: readonly string[];
}

export interface DecrementResult {
	readonly entitiesOrphaned: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function toCanonicalName(raw: string): string {
	return raw.trim().toLowerCase().replace(/\s+/g, " ");
}

interface UpsertEntityResult {
	readonly id: string;
	readonly inserted: boolean;
}

/**
 * Upsert an entity by canonical_name. Returns the entity row id
 * and whether it was a new insert.
 *
 * If an entity with the same canonical_name exists, increment its
 * mentions count and update its timestamp. Otherwise insert a new row.
 * Handles name UNIQUE constraint collisions gracefully.
 */
function upsertEntity(
	db: WriteDb,
	rawName: string,
	entityType: string,
	now: string,
): UpsertEntityResult {
	const canonical = toCanonicalName(rawName);

	const existing = db
		.prepare(
			`SELECT id, mentions FROM entities
			 WHERE canonical_name = ?
			 LIMIT 1`,
		)
		.get(canonical) as { id: string; mentions: number } | undefined;

	if (existing) {
		db.prepare(
			`UPDATE entities
			 SET mentions = mentions + 1, updated_at = ?
			 WHERE id = ?`,
		).run(now, existing.id);
		return { id: existing.id, inserted: false };
	}

	const id = crypto.randomUUID();
	try {
		db.prepare(
			`INSERT INTO entities
			 (id, name, canonical_name, entity_type, mentions, created_at, updated_at)
			 VALUES (?, ?, ?, ?, 1, ?, ?)`,
		).run(id, rawName, canonical, entityType, now, now);
		return { id, inserted: true };
	} catch (e) {
		// name UNIQUE constraint collision — fall back to existing row
		const msg = e instanceof Error ? e.message : String(e);
		if (!msg.includes("UNIQUE constraint")) throw e;

		const fallback = db
			.prepare("SELECT id FROM entities WHERE name = ? LIMIT 1")
			.get(rawName) as { id: string } | undefined;

		if (fallback) {
			db.prepare(
				`UPDATE entities
				 SET mentions = mentions + 1, updated_at = ?,
				     canonical_name = COALESCE(canonical_name, ?)
				 WHERE id = ?`,
			).run(now, canonical, fallback.id);
			return { id: fallback.id, inserted: false };
		}

		throw e;
	}
}

/**
 * Upsert a relation. If (source, target, type) exists, increment
 * mentions and update confidence via running average.
 */
function upsertRelation(
	db: WriteDb,
	sourceEntityId: string,
	targetEntityId: string,
	relationType: string,
	confidence: number,
	now: string,
): boolean {
	const existing = db
		.prepare(
			`SELECT id, mentions, confidence FROM relations
			 WHERE source_entity_id = ? AND target_entity_id = ?
			   AND relation_type = ?
			 LIMIT 1`,
		)
		.get(sourceEntityId, targetEntityId, relationType) as
		| { id: string; mentions: number; confidence: number }
		| undefined;

	if (existing) {
		// Running average: new_avg = (old_avg * n + new_val) / (n + 1)
		const newMentions = existing.mentions + 1;
		const newConfidence =
			(existing.confidence * existing.mentions + confidence) / newMentions;

		db.prepare(
			`UPDATE relations
			 SET mentions = ?, confidence = ?, updated_at = ?
			 WHERE id = ?`,
		).run(newMentions, newConfidence, now, existing.id);
		return false; // not a new insert
	}

	const id = crypto.randomUUID();
	db.prepare(
		`INSERT INTO relations
		 (id, source_entity_id, target_entity_id, relation_type,
		  strength, mentions, confidence, created_at, updated_at)
		 VALUES (?, ?, ?, ?, 1.0, 1, ?, ?, ?)`,
	).run(id, sourceEntityId, targetEntityId, relationType, confidence, now, now);
	return true;
}

// ---------------------------------------------------------------------------
// Exported transaction closures
// ---------------------------------------------------------------------------

/**
 * Persist extracted entity triples into the graph tables.
 *
 * For each triple: upsert source + target entities (deduped by
 * canonical_name), upsert relation, and link mentions to the source
 * memory.
 *
 * Call inside `accessor.withWriteTx(db => txPersistEntities(db, input))`.
 */
export function txPersistEntities(
	db: WriteDb,
	input: PersistEntitiesInput,
): PersistEntitiesResult {
	let entitiesInserted = 0;
	let entitiesUpdated = 0;
	let relationsInserted = 0;
	let relationsUpdated = 0;
	let mentionsLinked = 0;

	const now = input.extractedAt;

	for (const triple of input.entities) {
		const source = upsertEntity(db, triple.source, "extracted", now);
		if (source.inserted) entitiesInserted++;
		else entitiesUpdated++;

		const target = upsertEntity(db, triple.target, "extracted", now);
		if (target.inserted) entitiesInserted++;
		else entitiesUpdated++;

		const isNewRelation = upsertRelation(
			db,
			source.id,
			target.id,
			triple.relationship,
			triple.confidence,
			now,
		);
		if (isNewRelation) relationsInserted++;
		else relationsUpdated++;

		// Link mentions to source memory (INSERT OR IGNORE for idempotency)
		const mentionPairs: Array<{ entityId: string; text: string }> = [
			{ entityId: source.id, text: triple.source },
			{ entityId: target.id, text: triple.target },
		];
		for (const { entityId, text } of mentionPairs) {
			const result = db
				.prepare(
					`INSERT OR IGNORE INTO memory_entity_mentions
					 (memory_id, entity_id, mention_text, confidence, created_at)
					 VALUES (?, ?, ?, ?, ?)`,
				)
				.run(input.sourceMemoryId, entityId, text, triple.confidence, now);
			if (countChanges(result) > 0) mentionsLinked++;
		}
	}

	return { entitiesInserted, entitiesUpdated, relationsInserted, relationsUpdated, mentionsLinked };
}

/**
 * Decrement entity mention counts after memory purge. Entities that
 * drop to 0 mentions are deleted, and dangling relations are cleaned.
 *
 * Call inside `accessor.withWriteTx(db => txDecrementEntityMentions(db, input))`.
 */
export function txDecrementEntityMentions(
	db: WriteDb,
	input: DecrementInput,
): DecrementResult {
	if (input.entityIds.length === 0) return { entitiesOrphaned: 0 };

	// Decrement mentions (floor at 0)
	for (const entityId of input.entityIds) {
		db.prepare(
			`UPDATE entities
			 SET mentions = MAX(0, mentions - 1)
			 WHERE id = ?`,
		).run(entityId);
	}

	// Delete orphaned entities (mentions = 0)
	const orphaned = db
		.prepare(
			"SELECT id FROM entities WHERE mentions = 0",
		)
		.all() as Array<{ id: string }>;

	if (orphaned.length > 0) {
		const placeholders = orphaned.map(() => "?").join(", ");
		const ids = orphaned.map((r) => r.id);

		// Clean dangling relations first
		db.prepare(
			`DELETE FROM relations
			 WHERE source_entity_id IN (${placeholders})
			    OR target_entity_id IN (${placeholders})`,
		).run(...ids, ...ids);

		// Clean any remaining mention links
		db.prepare(
			`DELETE FROM memory_entity_mentions
			 WHERE entity_id IN (${placeholders})`,
		).run(...ids);

		// Delete the entities themselves
		db.prepare(
			`DELETE FROM entities WHERE id IN (${placeholders})`,
		).run(...ids);
	}

	return { entitiesOrphaned: orphaned.length };
}

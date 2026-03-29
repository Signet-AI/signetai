/**
 * Graph entity/relation persistence for the extraction pipeline.
 *
 * Separated from transactions.ts (which handles memory CRUD) to keep
 * both files under the 700 LOC soft cap.
 *
 * All functions expect to run inside a withWriteTx closure.
 */

import type { ExtractedEntity } from "@signet/core";
import type { WriteDb } from "../db-accessor";
import { countChanges } from "../db-helpers";
import { requireDependencyReason } from "../dependency-history";
import { isDecisionContent } from "../inline-entity-linker";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PersistEntitiesInput {
	readonly entities: readonly ExtractedEntity[];
	readonly sourceMemoryId: string;
	readonly extractedAt: string;
	readonly agentId: string;
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
	agentId: string,
	now: string,
): UpsertEntityResult | null {
	const canonical = toCanonicalName(rawName);

	// Skip trivially short names like "50", "0", "cli", "npm"
	if (canonical.length < 4) return null;

	// Look up by canonical_name first, then fall back to name (handles
	// rows where canonical_name was never backfilled and is still NULL).
	const existing = db
		.prepare(
			`SELECT id, mentions, entity_type FROM entities
			 WHERE (canonical_name = ? AND agent_id = ?) OR name = ?
			 LIMIT 1`,
		)
		.get(canonical, agentId, rawName) as { id: string; mentions: number; entity_type: string } | undefined;

	if (existing) {
		db.prepare(
			`UPDATE entities
			 SET mentions = mentions + 1, updated_at = ?
			 WHERE id = ?`,
		).run(now, existing.id);
		// Upgrade entity_type if currently "extracted" and we have a real type
		if (entityType !== "extracted" && existing.entity_type === "extracted") {
			db.prepare(`UPDATE entities SET entity_type = ? WHERE id = ? AND entity_type = 'extracted'`).run(
				entityType,
				existing.id,
			);
		}
		return { id: existing.id, inserted: false };
	}

	const id = crypto.randomUUID();
	try {
		db.prepare(
			`INSERT INTO entities
			 (id, name, canonical_name, entity_type, agent_id, mentions, created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, 1, ?, ?)`,
		).run(id, rawName, canonical, entityType, agentId, now, now);
		return { id, inserted: true };
	} catch (e) {
		// name UNIQUE constraint collision — fall back to existing row.
		// Don't scope by agent_id here: the UNIQUE is on name alone.
		const msg = e instanceof Error ? e.message : String(e);
		if (!msg.includes("UNIQUE constraint")) throw e;

		const fallback = db.prepare("SELECT id FROM entities WHERE name = ? LIMIT 1").get(rawName) as
			| { id: string }
			| undefined;

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
		const newConfidence = (existing.confidence * existing.mentions + confidence) / newMentions;

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
export function txPersistEntities(db: WriteDb, input: PersistEntitiesInput): PersistEntitiesResult {
	let entitiesInserted = 0;
	let entitiesUpdated = 0;
	let relationsInserted = 0;
	let relationsUpdated = 0;
	let mentionsLinked = 0;

	const now = input.extractedAt;

	for (const triple of input.entities) {
		// Pre-validate both names before any DB writes — prevents phantom mention
		// increments on the source when the target would be filtered by upsertEntity.
		const srcCanon = triple.source.trim().toLowerCase().replace(/\s+/g, " ");
		const tgtCanon = triple.target.trim().toLowerCase().replace(/\s+/g, " ");
		if (srcCanon.length < 4 || tgtCanon.length < 4) continue;

		const source = upsertEntity(db, triple.source, triple.sourceType ?? "extracted", input.agentId, now);
		// Defensive — pre-check above should prevent null, but guard anyway
		if (source === null) continue;
		if (source.inserted) entitiesInserted++;
		else entitiesUpdated++;

		const target = upsertEntity(db, triple.target, triple.targetType ?? "extracted", input.agentId, now);
		if (target === null) continue;
		if (target.inserted) entitiesInserted++;
		else entitiesUpdated++;

		const isNewRelation = upsertRelation(db, source.id, target.id, triple.relationship, triple.confidence, now);
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

// ---------------------------------------------------------------------------
// Structured persistence (Remember API bypass)
// ---------------------------------------------------------------------------

export interface StructuredAspect {
	readonly entityName: string;
	readonly aspect: string;
	readonly attributes: ReadonlyArray<{
		readonly content: string;
		readonly confidence?: number;
		readonly importance?: number;
	}>;
}

export interface PersistStructuredInput {
	readonly entities: readonly ExtractedEntity[];
	readonly aspects: readonly StructuredAspect[];
	readonly sourceMemoryId: string;
	readonly content: string;
	readonly agentId: string;
	readonly now: string;
}

export interface PersistStructuredResult {
	readonly entitiesInserted: number;
	readonly entitiesUpdated: number;
	readonly relationsInserted: number;
	readonly relationsUpdated: number;
	readonly mentionsLinked: number;
	readonly aspectsCreated: number;
	readonly attributesCreated: number;
}

/**
 * Write pre-computed entities, aspects, and attributes in a single
 * transaction. Used when callers provide a `structured` payload to
 * the Remember API, bypassing the async pipeline.
 *
 * Call inside `accessor.withWriteTx(db => txPersistStructured(db, input))`.
 */
export function txPersistStructured(db: WriteDb, input: PersistStructuredInput): PersistStructuredResult {
	// Step 1: Persist entity triples via existing logic
	const base = txPersistEntities(db, {
		entities: input.entities,
		sourceMemoryId: input.sourceMemoryId,
		extractedAt: input.now,
		agentId: input.agentId,
	});

	let aspectsCreated = 0;
	let attributesCreated = 0;

	// Decision detection: promote attributes to constraints when
	// the source memory contains decision-indicating language.
	const decision = isDecisionContent(input.content);
	const kind = decision ? "constraint" : "attribute";
	const baseImportance = decision ? 0.85 : 0.5;

	// Collect resolved entity ids for dependency linking
	const resolved: string[] = [];

	// Step 2: Upsert aspects and attributes
	for (const sa of input.aspects) {
		const canonical = toCanonicalName(sa.entityName);
		const row = db
			.prepare(
				`SELECT id FROM entities
				 WHERE canonical_name = ? AND agent_id = ?
				 LIMIT 1`,
			)
			.get(canonical, input.agentId) as { id: string } | undefined;

		if (!row) continue;
		resolved.push(row.id);

		// Upsert aspect
		const aspectCanon = toCanonicalName(sa.aspect);
		const aspectId = crypto.randomUUID();
		db.prepare(
			`INSERT INTO entity_aspects
			 (id, entity_id, agent_id, name, canonical_name, weight, created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, 0.5, ?, ?)
			 ON CONFLICT(entity_id, canonical_name) DO UPDATE
			 SET updated_at = excluded.updated_at`,
		).run(aspectId, row.id, input.agentId, sa.aspect, aspectCanon, input.now, input.now);

		// Read back the actual id (may differ on conflict)
		const stored = db
			.prepare(
				`SELECT id FROM entity_aspects
				 WHERE entity_id = ? AND canonical_name = ?
				 LIMIT 1`,
			)
			.get(row.id, aspectCanon) as { id: string };

		aspectsCreated++;

		// Insert attributes with dedup
		for (const attr of sa.attributes) {
			const normalized = attr.content.trim().toLowerCase();
			const dup = db
				.prepare(
					`SELECT id FROM entity_attributes
					 WHERE aspect_id = ? AND agent_id = ? AND normalized_content = ?
					   AND status = 'active'
					 LIMIT 1`,
				)
				.get(stored.id, input.agentId, normalized) as { id: string } | undefined;

			if (dup) continue;

			const confidence = attr.confidence ?? 0.7;
			const importance = attr.importance ?? baseImportance;
			try {
				db.prepare(
					`INSERT INTO entity_attributes
					 (id, aspect_id, agent_id, memory_id, kind, content,
					  normalized_content, confidence, importance, status,
					  created_at, updated_at)
					 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
				).run(
					crypto.randomUUID(),
					stored.id,
					input.agentId,
					input.sourceMemoryId,
					kind,
					attr.content,
					normalized,
					confidence,
					importance,
					input.now,
					input.now,
				);
				attributesCreated++;
			} catch (e) {
				const msg = e instanceof Error ? e.message : String(e);
				if (!msg.includes("UNIQUE constraint")) throw e;
			}
		}
	}

	// Step 3: Create dependencies between co-occurring entities
	if (resolved.length >= 2) {
		for (let i = 0; i < resolved.length - 1; i++) {
			for (let j = i + 1; j < resolved.length; j++) {
				if (resolved[i] === resolved[j]) continue;
				try {
					const row = db
						.prepare(
							`SELECT id
							 FROM entity_dependencies
							 WHERE source_entity_id = ? AND target_entity_id = ?
							   AND dependency_type = 'related_to' AND agent_id = ?
							 LIMIT 1`,
						)
						.get(resolved[i], resolved[j], input.agentId) as
						| { id: string }
						| undefined;
					if (row) continue;
					const id = crypto.randomUUID();
					const reason = requireDependencyReason(
						"related_to",
						`co-occurred in extracted entities for memory ${input.sourceMemoryId}`,
					);
					db.prepare(
						`INSERT INTO entity_dependencies
						 (id, source_entity_id, target_entity_id, agent_id,
						  dependency_type, strength, confidence, reason, created_at, updated_at)
						 VALUES (?, ?, ?, ?, 'related_to', 0.3, 0.5, ?, ?, ?)`,
					).run(
						id,
						resolved[i],
						resolved[j],
						input.agentId,
						reason,
						input.now,
						input.now,
					);
				} catch (e) {
					const msg = e instanceof Error ? e.message : String(e);
					if (!msg.includes("UNIQUE constraint")) throw e;
				}
			}
		}
	}

	return {
		entitiesInserted: base.entitiesInserted,
		entitiesUpdated: base.entitiesUpdated,
		relationsInserted: base.relationsInserted,
		relationsUpdated: base.relationsUpdated,
		mentionsLinked: base.mentionsLinked,
		aspectsCreated,
		attributesCreated,
	};
}

/**
 * Decrement entity mention counts after memory purge. Entities that
 * drop to 0 mentions are deleted, and dangling relations are cleaned.
 *
 * Call inside `accessor.withWriteTx(db => txDecrementEntityMentions(db, input))`.
 */
export function txDecrementEntityMentions(db: WriteDb, input: DecrementInput): DecrementResult {
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
	const orphaned = db.prepare("SELECT id FROM entities WHERE mentions = 0").all() as Array<{ id: string }>;

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
		db.prepare(`DELETE FROM entities WHERE id IN (${placeholders})`).run(...ids);
	}

	return { entitiesOrphaned: orphaned.length };
}

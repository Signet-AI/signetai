import type { MigrationDb } from "./index";

/**
 * Migration 106: entity-side composite index for memory_entity_mentions.
 *
 * The knowledge graph `COUNT(DISTINCT mem.memory_id)` join in
 * getKnowledgeStats drives from the entity/memory tables (a planner-chosen
 * cross-product when only `(entity_id)` and the `(memory_id, entity_id)`
 * PRIMARY KEY exist), turning a stats call over a few thousand entities into
 * ~30M nested-loop point lookups — 9.4s on a 5.5K-entity install, and the
 * dashboard polls this endpoint every few seconds (Signet-AI/signetai#1139-adjacent).
 *
 * The composite `(entity_id, memory_id)` index lets SQLite drive the join
 * from the mentions table (or resolve `entity_id` lookups covering both
 * columns): the same query drops to ~13ms. It also serves entity-side
 * mention scans in graph-traversal and relinking paths.
 */
export function up(db: MigrationDb): void {
	db.exec(`
		CREATE INDEX IF NOT EXISTS idx_memory_entity_mentions_entity_memory
			ON memory_entity_mentions(entity_id, memory_id);
	`);
}

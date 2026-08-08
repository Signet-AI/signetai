import type { MigrationDb } from "./index";

/**
 * Migration 110: entity-side composite index for memory_entity_mentions.
 *
 * The knowledge-graph `COUNT(DISTINCT mem.memory_id)` join in
 * getKnowledgeStats drives from the entity/memory tables when only the
 * `(entity_id)` index and the `(memory_id, entity_id)` PRIMARY KEY exist,
 * turning a stats call over a few thousand entities into a ~30M-iteration
 * nested loop (9.4s on a 5.5K-entity install). The dashboard polls
 * `/api/knowledge/stats` every few seconds, so each poll blocks the main
 * thread (Signet-AI/signetai#1158).
 *
 * The composite `(entity_id, memory_id)` index lets SQLite drive the join
 * from the mentions table and covers both columns; the same query drops to
 * ~13ms. It also serves entity-side mention scans in graph-traversal and
 * relinking paths.
 */
export function up(db: MigrationDb): void {
	db.exec(`
		CREATE INDEX IF NOT EXISTS idx_memory_entity_mentions_entity_memory
			ON memory_entity_mentions(entity_id, memory_id);
	`);
}

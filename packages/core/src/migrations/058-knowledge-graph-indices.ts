import type { MigrationDb } from "./index";

/**
 * Migration 058: Add indices that support the paginated-ID knowledge-graph
 * queries introduced to fix Signet-AI/signetai#515.
 *
 * - `idx_entities_order` — compound index on the agent scope + ordering
 *   columns used by `listKnowledgeEntities`. Lets SQLite serve the `page`
 *   CTE as an index-only scan before counts are computed.
 * - `idx_entities_extracted_mentions` — partial compound index narrowing
 *   the `pruneSingletonExtractedEntities` candidate scan from the full
 *   entity set to extracted entities only.
 *
 * Both are idempotent (`IF NOT EXISTS`) and safe to reapply.
 */
export function up(db: MigrationDb): void {
	db.exec(
		`CREATE INDEX IF NOT EXISTS idx_entities_order
			ON entities(agent_id, pinned DESC, pinned_at DESC, mentions DESC, updated_at DESC, name)`,
	);
	db.exec(
		`CREATE INDEX IF NOT EXISTS idx_entities_extracted_mentions
			ON entities(entity_type, mentions)
			WHERE entity_type = 'extracted'`,
	);
}

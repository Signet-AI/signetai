import type { MigrationDb } from "./index";

/**
 * Migration 132: make the existing agent scope an explicit observer query
 * dimension without duplicating it into a second identity column.
 */
export function up(db: MigrationDb): void {
	db.exec(`
		CREATE INDEX IF NOT EXISTS idx_epistemic_assertions_observer_entity
			ON epistemic_assertions(agent_id, subject_entity_id, status, asserted_at DESC, created_at DESC);
	`);
}

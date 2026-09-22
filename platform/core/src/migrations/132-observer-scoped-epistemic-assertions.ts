import type { MigrationDb } from "./contract";
export function up(db: MigrationDb): void {
	db.exec(`
		CREATE INDEX IF NOT EXISTS idx_epistemic_assertions_observer_entity
			ON epistemic_assertions(agent_id, subject_entity_id, status, asserted_at DESC, created_at DESC);
	`);
}

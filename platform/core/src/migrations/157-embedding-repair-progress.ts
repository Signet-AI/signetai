import type { MigrationDb } from "./contract";

/**
 * Splits agent-visible repair progress from the singleton provider admission
 * budget. The lease and hourly window remain global, while completion
 * diagnostics are keyed by the agent whose memories were repaired.
 */
export function up(db: MigrationDb): void {
	const columns = new Set(
		(db.prepare("PRAGMA table_info(embedding_repair_checkpoints)").all() as Array<{ name?: string }>).map(
			(row) => row.name,
		),
	);
	if (!columns.has("profile_fingerprint")) {
		db.exec("ALTER TABLE embedding_repair_checkpoints ADD COLUMN profile_fingerprint TEXT");
	}

	db.exec(`
		CREATE TABLE IF NOT EXISTS embedding_repair_progress (
			agent_id TEXT PRIMARY KEY CHECK (length(trim(agent_id)) > 0),
			last_completed_at TEXT,
			last_affected INTEGER NOT NULL DEFAULT 0 CHECK (last_affected >= 0),
			last_error TEXT,
			updated_at TEXT NOT NULL
		);
	`);
}

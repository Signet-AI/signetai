import type { MigrationDb } from "./index";

function addColumnIfMissing(db: MigrationDb, table: string, column: string, definition: string): void {
	const cols = db.prepare(`PRAGMA table_info(${table})`).all() as ReadonlyArray<Record<string, unknown>>;
	if (cols.some((c) => c.name === column)) return;
	db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

/**
 * Migration 044: MEMORY.md temporal head metadata
 *
 * Extends `session_summaries` with provenance metadata so the table can
 * represent summary-worker nodes, transcript-chunk leaves, compaction
 * artifacts, and higher-order condensations without losing lineage.
 */
export function up(db: MigrationDb): void {
	addColumnIfMissing(db, "session_summaries", "source_type", "TEXT");
	addColumnIfMissing(db, "session_summaries", "source_ref", "TEXT");
	addColumnIfMissing(db, "session_summaries", "meta_json", "TEXT");

	db.exec(`
		UPDATE session_summaries
		SET source_type = CASE
			WHEN source_type IS NOT NULL THEN source_type
			WHEN kind = 'session' THEN 'summary'
			WHEN kind IN ('arc', 'epoch') THEN 'condensation'
			ELSE kind
		END
		WHERE source_type IS NULL;

		CREATE INDEX IF NOT EXISTS idx_summaries_source_type
			ON session_summaries(source_type);
		CREATE INDEX IF NOT EXISTS idx_summaries_source_ref
			ON session_summaries(source_ref);
	`);
}

/**
 * Migration 013: Ingestion Tracking
 *
 * Adds infrastructure for the document ingestion engine:
 *   - ingestion_jobs table: tracks each ingestion run (file → memories)
 *   - source_path column on memories: links memories back to their source file
 *   - source_section column on memories: which section the memory came from
 */

import type { MigrationDb } from "./index";

/** Helper: add a column only if it doesn't already exist. */
function addColumnIfMissing(
	db: MigrationDb,
	table: string,
	column: string,
	definition: string,
): void {
	const cols = db.prepare(`PRAGMA table_info(${table})`).all() as ReadonlyArray<
		Record<string, unknown>
	>;
	if (!cols.some((c) => c.name === column)) {
		db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
	}
}

export function up(db: MigrationDb): void {
	// -----------------------------------------------------------------------
	// ingestion_jobs — tracks each ingestion run
	// -----------------------------------------------------------------------
	db.exec(`
		CREATE TABLE IF NOT EXISTS ingestion_jobs (
			id TEXT PRIMARY KEY,
			source_path TEXT NOT NULL,
			source_type TEXT NOT NULL,
			file_hash TEXT,
			status TEXT NOT NULL DEFAULT 'pending',
			chunks_total INTEGER DEFAULT 0,
			chunks_processed INTEGER DEFAULT 0,
			memories_created INTEGER DEFAULT 0,
			started_at TEXT NOT NULL,
			completed_at TEXT,
			error TEXT
		);

		CREATE INDEX IF NOT EXISTS idx_ingestion_jobs_status
			ON ingestion_jobs(status);
		CREATE INDEX IF NOT EXISTS idx_ingestion_jobs_file_hash
			ON ingestion_jobs(file_hash);
		CREATE INDEX IF NOT EXISTS idx_ingestion_jobs_source_path
			ON ingestion_jobs(source_path);
	`);

	// -----------------------------------------------------------------------
	// Extend memories table with provenance columns
	// -----------------------------------------------------------------------
	addColumnIfMissing(db, "memories", "source_path", "TEXT");
	addColumnIfMissing(db, "memories", "source_section", "TEXT");
}

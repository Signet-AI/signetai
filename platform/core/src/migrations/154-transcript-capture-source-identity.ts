import type { MigrationDb } from "./contract";

function addColumnIfMissing(db: MigrationDb, column: string, definition: string): void {
	const columns = db.prepare("PRAGMA table_info(transcript_capture_jobs)").all() as Array<{ name?: unknown }>;
	if (columns.some((row) => row.name === column)) return;
	db.exec(`ALTER TABLE transcript_capture_jobs ADD COLUMN ${column} ${definition}`);
}

export function up(db: MigrationDb): void {
	const table = db
		.prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'transcript_capture_jobs'")
		.get() as { present?: number } | undefined;
	if (!table?.present) return;

	addColumnIfMissing(db, "source_identity", "TEXT");
	addColumnIfMissing(db, "source_sha256", "TEXT");
	addColumnIfMissing(db, "source_size_bytes", "INTEGER");
	addColumnIfMissing(db, "source_mtime_ms", "REAL");
	addColumnIfMissing(db, "source_format", "TEXT");
	addColumnIfMissing(db, "audit_path", "TEXT");

	// New admissions are coalesced by this stable identity. Legacy rows are
	// intentionally left NULL until the repair path can prove which duplicate
	// is authoritative; a migration must not guess while holding the schema lock.
	db.exec(`
		CREATE INDEX IF NOT EXISTS idx_transcript_capture_jobs_source_identity
			ON transcript_capture_jobs(agent_id, source_identity, status);
		CREATE INDEX IF NOT EXISTS idx_transcript_capture_jobs_source_digest
			ON transcript_capture_jobs(agent_id, source_sha256);
	`);
}

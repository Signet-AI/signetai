import type { MigrationDb } from "./index";

function hasColumn(db: MigrationDb, table: string, column: string): boolean {
	return (db.prepare(`PRAGMA table_info(${table})`).all() as ReadonlyArray<Record<string, unknown>>).some(
		(row) => row.name === column,
	);
}

/**
 * Migration 106: `review_after` on memories for selective temporal-claim expiry.
 *
 * Issue #945: temporal claims (e.g. "X is going to Y on March 15th, 2027")
 * need a way to surface as due for review once the referenced date passes,
 * without NLP-parsing every memory on every dreaming pass. This adds a
 * nullable indexed `review_after` (ISO timestamp) column to `memories` so
 * the dreaming pass can query `WHERE review_after IS NOT NULL AND
 * review_after < datetime('now')` directly.
 *
 * The column is additive and nullable — existing rows are unaffected, and
 * any store surface that does not set it behaves exactly as before. The
 * column guard keeps the migration idempotent for tests that re-run the
 * migration set from a stamped schema.
 */
export function up(db: MigrationDb): void {
	if (!hasColumn(db, "memories", "review_after")) {
		db.exec("ALTER TABLE memories ADD COLUMN review_after TEXT;");
	}
	db.exec("CREATE INDEX IF NOT EXISTS idx_memories_review_after ON memories(review_after);");
}

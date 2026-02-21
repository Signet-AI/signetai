/**
 * Migration 003: Unique content hash index
 *
 * Safely creates a unique partial index on content_hash. Must run as a
 * separate migration because 002 was already shipped with a non-unique
 * index — existing installs need this new version to pick up the change.
 *
 * Also backfills `why` and `project` columns for databases that ran 001
 * before those columns were added to the baseline CREATE TABLE.
 */

import type { MigrationDb } from "./index";

/** Conditionally add a column if it doesn't exist yet. */
function addColumnIfMissing(
	db: MigrationDb,
	table: string,
	column: string,
	definition: string,
): boolean {
	const rows = db.prepare(`PRAGMA table_info(${table})`).all() as ReadonlyArray<
		Record<string, unknown>
	>;
	if (rows.some((r) => r.name === column)) return false;
	db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
	return true;
}

export function up(db: MigrationDb): void {
	// Backfill columns that may be missing on older databases
	addColumnIfMissing(db, "memories", "why", "TEXT");
	addColumnIfMissing(db, "memories", "project", "TEXT");

	// Drop the non-unique index from migration 002 if it exists
	db.exec(`DROP INDEX IF EXISTS idx_memories_content_hash`);

	// Deduplicate content_hash values before enforcing uniqueness.
	// For each group of duplicates, keep the semantically newest row
	// (by created_at) and null out the hash on all others.
	db.exec(`
		UPDATE memories
		SET content_hash = NULL
		WHERE content_hash IS NOT NULL
		  AND is_deleted = 0
		  AND id NOT IN (
			SELECT id FROM (
				SELECT id, ROW_NUMBER() OVER (
					PARTITION BY content_hash
					ORDER BY created_at DESC, rowid DESC
				) AS rn
				FROM memories
				WHERE content_hash IS NOT NULL
				  AND is_deleted = 0
			) ranked
			WHERE rn = 1
		  )
	`);

	// Now safe to create the unique partial index
	db.exec(`
		CREATE UNIQUE INDEX IF NOT EXISTS idx_memories_content_hash_unique
			ON memories(content_hash)
			WHERE content_hash IS NOT NULL AND is_deleted = 0
	`);
}

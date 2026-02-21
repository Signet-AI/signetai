/**
 * Migration 008: Unique content_hash on embeddings
 *
 * The baseline schema declares content_hash as UNIQUE but older databases
 * may have been created before that constraint was enforced. The pipeline
 * Phase C write path uses ON CONFLICT(content_hash), which requires a
 * unique index. Dedup any collisions then create the index.
 */

import type { MigrationDb } from "./index";

export function up(db: MigrationDb): void {
	// Only run if embeddings table exists (baseline creates it)
	const tables = db
		.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='embeddings'")
		.all();
	if (tables.length === 0) return;

	// Keep newest embedding per content_hash, delete older dupes
	db.exec(`
		DELETE FROM embeddings
		WHERE rowid NOT IN (
			SELECT MIN(rowid) FROM embeddings
			GROUP BY content_hash
		)
	`);

	// Drop the non-unique index if it exists
	db.exec(`DROP INDEX IF EXISTS idx_embeddings_hash`);

	// Create unique index
	db.exec(`
		CREATE UNIQUE INDEX IF NOT EXISTS idx_embeddings_content_hash_unique
			ON embeddings(content_hash)
	`);
}

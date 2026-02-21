/**
 * Migration 004: Actor classification + correlation + retention indexes
 *
 * Adds structured actor_type and request/session correlation fields to
 * memory_history, plus indexes to support the retention worker's purge
 * queries on soft-deleted memories, expired history, and completed jobs.
 */

import type { MigrationDb } from "./index";

function hasColumn(db: MigrationDb, table: string, column: string): boolean {
	const rows = db.prepare(`PRAGMA table_info(${table})`).all() as ReadonlyArray<
		Record<string, unknown>
	>;
	return rows.some((r) => r.name === column);
}

function addColumnIfMissing(
	db: MigrationDb,
	table: string,
	column: string,
	definition: string,
): void {
	if (!hasColumn(db, table, column)) {
		db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
	}
}

export function up(db: MigrationDb): void {
	// -- Actor classification on memory_history --
	addColumnIfMissing(db, "memory_history", "actor_type", "TEXT");
	addColumnIfMissing(db, "memory_history", "session_id", "TEXT");
	addColumnIfMissing(db, "memory_history", "request_id", "TEXT");

	// -- Retention worker indexes --
	// Tombstone purge: find soft-deleted memories past retention window
	db.exec(`
		CREATE INDEX IF NOT EXISTS idx_memories_deleted_at
			ON memories(deleted_at)
			WHERE is_deleted = 1;
	`);

	// History purge: find old history events by date
	db.exec(`
		CREATE INDEX IF NOT EXISTS idx_memory_history_created_at
			ON memory_history(created_at);
	`);

	// Job purge: find completed/dead jobs by date
	db.exec(`
		CREATE INDEX IF NOT EXISTS idx_memory_jobs_completed_at
			ON memory_jobs(completed_at)
			WHERE status = 'completed';
	`);
	db.exec(`
		CREATE INDEX IF NOT EXISTS idx_memory_jobs_failed_at
			ON memory_jobs(failed_at)
			WHERE status = 'dead';
	`);
}

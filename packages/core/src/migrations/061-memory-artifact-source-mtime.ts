import type { MigrationDb } from "./index";

/**
 * Migration 061: Persist indexed artifact file mtimes.
 *
 * Cold-start reindex previously had no durable on-disk change marker, so an
 * empty in-memory cache forced a full reread and reparse of every canonical
 * artifact even when the database index was already current. Persisting the
 * last indexed file mtime lets the daemon skip unchanged artifacts after a
 * restart while still detecting real on-disk edits.
 */
export function up(db: MigrationDb): void {
	const cols = db.prepare("PRAGMA table_info(memory_artifacts)").all() as Array<{ name: string }>;
	if (cols.some((col) => col.name === "source_mtime_ms")) return;
	db.exec("ALTER TABLE memory_artifacts ADD COLUMN source_mtime_ms REAL");
}

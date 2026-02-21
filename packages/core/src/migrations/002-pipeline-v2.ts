/**
 * Migration 002: Pipeline v2 schema
 *
 * Adds columns for the memory pipeline (content hashing, soft delete,
 * extraction tracking), plus new tables for history, jobs, and the
 * entity graph.
 */

import type { MigrationDb } from "./index";

/** Check whether a column already exists on a table. */
function hasColumn(db: MigrationDb, table: string, column: string): boolean {
	const rows = db.prepare(`PRAGMA table_info(${table})`).all() as ReadonlyArray<
		Record<string, unknown>
	>;
	return rows.some((r) => r.name === column);
}

/** Conditionally add a column if it doesn't exist yet. */
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
	// -- New columns on memories --
	addColumnIfMissing(db, "memories", "content_hash", "TEXT");
	addColumnIfMissing(db, "memories", "normalized_content", "TEXT");
	addColumnIfMissing(db, "memories", "is_deleted", "INTEGER DEFAULT 0");
	addColumnIfMissing(db, "memories", "deleted_at", "TEXT");
	addColumnIfMissing(
		db,
		"memories",
		"extraction_status",
		"TEXT DEFAULT 'none'",
	);
	addColumnIfMissing(db, "memories", "embedding_model", "TEXT");
	addColumnIfMissing(db, "memories", "extraction_model", "TEXT");
	addColumnIfMissing(db, "memories", "update_count", "INTEGER DEFAULT 0");
	addColumnIfMissing(db, "memories", "who", "TEXT");
	addColumnIfMissing(db, "memories", "why", "TEXT");
	addColumnIfMissing(db, "memories", "project", "TEXT");
	// These may already exist from 001-baseline
	addColumnIfMissing(db, "memories", "pinned", "INTEGER DEFAULT 0");
	addColumnIfMissing(db, "memories", "importance", "REAL DEFAULT 0.5");
	addColumnIfMissing(db, "memories", "last_accessed", "TEXT");
	addColumnIfMissing(db, "memories", "access_count", "INTEGER DEFAULT 0");

	// -- memory_history (immutable audit trail) --
	db.exec(`
		CREATE TABLE IF NOT EXISTS memory_history (
			id TEXT PRIMARY KEY,
			memory_id TEXT NOT NULL,
			event TEXT NOT NULL,
			old_content TEXT,
			new_content TEXT,
			changed_by TEXT NOT NULL,
			reason TEXT,
			metadata TEXT,
			created_at TEXT NOT NULL,
			FOREIGN KEY (memory_id) REFERENCES memories(id)
		);
	`);

	// -- memory_jobs (durable queue) --
	db.exec(`
		CREATE TABLE IF NOT EXISTS memory_jobs (
			id TEXT PRIMARY KEY,
			memory_id TEXT NOT NULL,
			job_type TEXT NOT NULL,
			status TEXT NOT NULL DEFAULT 'pending',
			payload TEXT,
			result TEXT,
			attempts INTEGER DEFAULT 0,
			max_attempts INTEGER DEFAULT 3,
			leased_at TEXT,
			completed_at TEXT,
			failed_at TEXT,
			error TEXT,
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL,
			FOREIGN KEY (memory_id) REFERENCES memories(id)
		);
	`);

	// -- Entity graph --
	db.exec(`
		CREATE TABLE IF NOT EXISTS entities (
			id TEXT PRIMARY KEY,
			name TEXT NOT NULL UNIQUE,
			entity_type TEXT NOT NULL,
			description TEXT,
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL
		);
	`);

	db.exec(`
		CREATE TABLE IF NOT EXISTS relations (
			id TEXT PRIMARY KEY,
			source_entity_id TEXT NOT NULL,
			target_entity_id TEXT NOT NULL,
			relation_type TEXT NOT NULL,
			strength REAL DEFAULT 1.0,
			metadata TEXT,
			created_at TEXT NOT NULL,
			FOREIGN KEY (source_entity_id) REFERENCES entities(id),
			FOREIGN KEY (target_entity_id) REFERENCES entities(id)
		);
	`);

	db.exec(`
		CREATE TABLE IF NOT EXISTS memory_entity_mentions (
			memory_id TEXT NOT NULL,
			entity_id TEXT NOT NULL,
			PRIMARY KEY (memory_id, entity_id),
			FOREIGN KEY (memory_id) REFERENCES memories(id),
			FOREIGN KEY (entity_id) REFERENCES entities(id)
		);
	`);

	// -- Audit table for migration history --
	db.exec(`
		CREATE TABLE IF NOT EXISTS schema_migrations_audit (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			version INTEGER NOT NULL,
			applied_at TEXT NOT NULL,
			duration_ms INTEGER,
			checksum TEXT
		);
	`);

	// -- Indexes --
	db.exec(`
		CREATE INDEX IF NOT EXISTS idx_memories_content_hash
			ON memories(content_hash);
		CREATE INDEX IF NOT EXISTS idx_memories_is_deleted
			ON memories(is_deleted);
		CREATE INDEX IF NOT EXISTS idx_memories_extraction_status
			ON memories(extraction_status);
		CREATE INDEX IF NOT EXISTS idx_memory_history_memory_id
			ON memory_history(memory_id);
		CREATE INDEX IF NOT EXISTS idx_memory_jobs_status
			ON memory_jobs(status);
		CREATE INDEX IF NOT EXISTS idx_memory_jobs_memory_id
			ON memory_jobs(memory_id);
		CREATE INDEX IF NOT EXISTS idx_relations_source
			ON relations(source_entity_id);
		CREATE INDEX IF NOT EXISTS idx_relations_target
			ON relations(target_entity_id);
		CREATE INDEX IF NOT EXISTS idx_memory_entity_mentions_entity
			ON memory_entity_mentions(entity_id);
	`);
}

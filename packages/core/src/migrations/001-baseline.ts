/**
 * Migration 001: Baseline schema
 *
 * Captures the unified schema as migration version 1.
 * All statements use IF NOT EXISTS so this is safe to run
 * against databases that already have these tables.
 */

import type { MigrationDb } from "./index";

export function up(db: MigrationDb): void {
	db.exec(`
		CREATE TABLE IF NOT EXISTS schema_migrations (
			version INTEGER PRIMARY KEY,
			applied_at TEXT NOT NULL,
			checksum TEXT NOT NULL
		);

		CREATE TABLE IF NOT EXISTS conversations (
			id TEXT PRIMARY KEY,
			session_id TEXT NOT NULL,
			harness TEXT NOT NULL,
			started_at TEXT NOT NULL,
			ended_at TEXT,
			summary TEXT,
			topics TEXT,
			decisions TEXT,
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL,
			updated_by TEXT NOT NULL,
			vector_clock TEXT NOT NULL DEFAULT '{}',
			version INTEGER DEFAULT 1,
			manual_override INTEGER DEFAULT 0
		);

		CREATE TABLE IF NOT EXISTS memories (
			id TEXT PRIMARY KEY,
			type TEXT NOT NULL DEFAULT 'fact',
			category TEXT,
			content TEXT NOT NULL,
			confidence REAL DEFAULT 1.0,
			importance REAL DEFAULT 0.5,
			source_id TEXT,
			source_type TEXT,
			tags TEXT,
			who TEXT,
			why TEXT,
			project TEXT,
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL,
			updated_by TEXT NOT NULL DEFAULT 'system',
			last_accessed TEXT,
			access_count INTEGER DEFAULT 0,
			vector_clock TEXT NOT NULL DEFAULT '{}',
			version INTEGER DEFAULT 1,
			manual_override INTEGER DEFAULT 0,
			pinned INTEGER DEFAULT 0
		);

		CREATE TABLE IF NOT EXISTS embeddings (
			id TEXT PRIMARY KEY,
			content_hash TEXT NOT NULL UNIQUE,
			vector BLOB NOT NULL,
			dimensions INTEGER NOT NULL,
			source_type TEXT NOT NULL,
			source_id TEXT NOT NULL,
			chunk_text TEXT NOT NULL,
			created_at TEXT NOT NULL
		);

		-- Indexes
		CREATE INDEX IF NOT EXISTS idx_conversations_session
			ON conversations(session_id);
		CREATE INDEX IF NOT EXISTS idx_conversations_harness
			ON conversations(harness);
		CREATE INDEX IF NOT EXISTS idx_memories_type
			ON memories(type);
		CREATE INDEX IF NOT EXISTS idx_memories_category
			ON memories(category);
		CREATE INDEX IF NOT EXISTS idx_memories_pinned
			ON memories(pinned);
		CREATE INDEX IF NOT EXISTS idx_memories_importance
			ON memories(importance DESC);
		CREATE INDEX IF NOT EXISTS idx_memories_created
			ON memories(created_at DESC);
		CREATE INDEX IF NOT EXISTS idx_embeddings_source
			ON embeddings(source_type, source_id);
		CREATE INDEX IF NOT EXISTS idx_embeddings_hash
			ON embeddings(content_hash);
	`);

	// vec0 virtual table — requires sqlite-vec extension which may
	// not be loaded. Gracefully skip if unavailable.
	try {
		db.exec(`
			CREATE VIRTUAL TABLE IF NOT EXISTS vec_embeddings USING vec0(
				embedding FLOAT[768]
			);
		`);
	} catch {
		// sqlite-vec extension not loaded — vector search will be disabled
	}

	// FTS5 virtual table for full-text search on memories
	db.exec(`
		CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
			content,
			content=memories,
			content_rowid=rowid
		);
	`);

	// FTS sync triggers
	db.exec(`
		CREATE TRIGGER IF NOT EXISTS memories_ai
		AFTER INSERT ON memories BEGIN
			INSERT INTO memories_fts(rowid, content)
			VALUES (new.rowid, new.content);
		END;
	`);

	db.exec(`
		CREATE TRIGGER IF NOT EXISTS memories_ad
		AFTER DELETE ON memories BEGIN
			INSERT INTO memories_fts(memories_fts, rowid, content)
			VALUES('delete', old.rowid, old.content);
		END;
	`);

	db.exec(`
		CREATE TRIGGER IF NOT EXISTS memories_au
		AFTER UPDATE ON memories BEGIN
			INSERT INTO memories_fts(memories_fts, rowid, content)
			VALUES('delete', old.rowid, old.content);
			INSERT INTO memories_fts(rowid, content)
			VALUES (new.rowid, new.content);
		END;
	`);
}

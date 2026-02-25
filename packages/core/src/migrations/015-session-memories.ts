/**
 * Migration 015: Session Memories
 *
 * Data pipeline prerequisites for the predictive memory scorer:
 *   - session_memories table: links memories to sessions with scoring metadata
 *   - confidence column on session_scores: LLM self-assessed quality gate
 *   - continuity_reasoning column on session_scores: full LLM reasoning for audit
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
	// session_memories — per-session memory candidate tracking
	// -----------------------------------------------------------------------
	db.exec(`
		CREATE TABLE IF NOT EXISTS session_memories (
			id TEXT PRIMARY KEY,
			session_key TEXT NOT NULL,
			memory_id TEXT NOT NULL,
			source TEXT NOT NULL,
			effective_score REAL,
			predictor_score REAL,
			final_score REAL NOT NULL,
			rank INTEGER NOT NULL,
			was_injected INTEGER NOT NULL,
			relevance_score REAL,
			fts_hit_count INTEGER NOT NULL DEFAULT 0,
			agent_preference TEXT,
			created_at TEXT NOT NULL,
			UNIQUE(session_key, memory_id)
		);

		CREATE INDEX IF NOT EXISTS idx_session_memories_session
			ON session_memories(session_key);
		CREATE INDEX IF NOT EXISTS idx_session_memories_memory
			ON session_memories(memory_id);
	`);

	// -----------------------------------------------------------------------
	// Extend session_scores with quality gate columns
	// -----------------------------------------------------------------------
	addColumnIfMissing(db, "session_scores", "confidence", "REAL");
	addColumnIfMissing(db, "session_scores", "continuity_reasoning", "TEXT");
}

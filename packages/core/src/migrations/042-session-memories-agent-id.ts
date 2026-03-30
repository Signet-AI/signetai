import type { MigrationDb } from "./index";

function addColumnIfMissing(db: MigrationDb, table: string, column: string, definition: string): void {
	const cols = db.prepare(`PRAGMA table_info(${table})`).all() as ReadonlyArray<Record<string, unknown>>;
	if (cols.some((col) => col.name === column)) return;
	db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

/**
 * Migration 042: Add agent scoping to session_memories
 *
 * Rebuilds session_memories so rows are keyed by
 * (session_key, agent_id, memory_id), enabling agent-scoped writes/reads
 * when multiple agents reuse a session key.
 */
export function up(db: MigrationDb): void {
	// Defensive: older repaired DBs may have stamped versions without columns.
	// Ensure all columns referenced by the copy query exist before rebuild.
	addColumnIfMissing(db, "session_memories", "entity_slot", "INTEGER");
	addColumnIfMissing(db, "session_memories", "aspect_slot", "INTEGER");
	addColumnIfMissing(db, "session_memories", "is_constraint", "INTEGER NOT NULL DEFAULT 0");
	addColumnIfMissing(db, "session_memories", "structural_density", "INTEGER");
	addColumnIfMissing(db, "session_memories", "predictor_rank", "INTEGER");
	addColumnIfMissing(db, "session_memories", "agent_relevance_score", "REAL");
	addColumnIfMissing(db, "session_memories", "agent_feedback_count", "INTEGER DEFAULT 0");
	addColumnIfMissing(db, "session_memories", "path_json", "TEXT");

	const cols = db.prepare("PRAGMA table_info(session_memories)").all() as ReadonlyArray<Record<string, unknown>>;
	const hasAgent = cols.some((col) => col.name === "agent_id");
	const agentExpr = hasAgent ? "COALESCE(NULLIF(agent_id, ''), 'default')" : "'default'";

	db.exec(`
		CREATE TABLE IF NOT EXISTS session_memories_new (
			id TEXT PRIMARY KEY,
			session_key TEXT NOT NULL,
			agent_id TEXT NOT NULL DEFAULT 'default',
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
			entity_slot INTEGER,
			aspect_slot INTEGER,
			is_constraint INTEGER NOT NULL DEFAULT 0,
			structural_density INTEGER,
			predictor_rank INTEGER,
			agent_relevance_score REAL,
			agent_feedback_count INTEGER DEFAULT 0,
			path_json TEXT,
			UNIQUE(session_key, agent_id, memory_id)
		);

		INSERT INTO session_memories_new
			(id, session_key, agent_id, memory_id, source,
			 effective_score, predictor_score, final_score, rank,
			 was_injected, relevance_score, fts_hit_count,
			 agent_preference, created_at, entity_slot, aspect_slot,
			 is_constraint, structural_density, predictor_rank,
			 agent_relevance_score, agent_feedback_count, path_json)
		SELECT
			id,
			session_key,
			${agentExpr},
			memory_id,
			source,
			effective_score,
			predictor_score,
			final_score,
			rank,
			was_injected,
			relevance_score,
			fts_hit_count,
			agent_preference,
			created_at,
			entity_slot,
			aspect_slot,
			COALESCE(is_constraint, 0),
			structural_density,
			predictor_rank,
			agent_relevance_score,
			COALESCE(agent_feedback_count, 0),
			path_json
		FROM session_memories;

		DROP TABLE session_memories;
		ALTER TABLE session_memories_new RENAME TO session_memories;

		CREATE INDEX IF NOT EXISTS idx_session_memories_session
			ON session_memories(session_key);
		CREATE INDEX IF NOT EXISTS idx_session_memories_memory
			ON session_memories(memory_id);
		CREATE INDEX IF NOT EXISTS idx_session_memories_agent_session
			ON session_memories(agent_id, session_key);
	`);
}

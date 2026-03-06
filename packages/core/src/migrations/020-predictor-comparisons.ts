/**
 * Migration 020: Predictor Comparisons + Structural Session Features
 *
 * Adds:
 * - predictor_comparisons table for baseline vs predictor audits
 * - predictor_training_log table for training telemetry
 * - structural feature columns on session_memories
 */

import type { MigrationDb } from "./index";

function addColumnIfMissing(db: MigrationDb, table: string, column: string, definition: string): void {
	const cols = db.prepare(`PRAGMA table_info(${table})`).all() as ReadonlyArray<Record<string, unknown>>;
	if (!cols.some((c) => c.name === column)) {
		db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
	}
}

export function up(db: MigrationDb): void {
	db.exec(`
		CREATE TABLE IF NOT EXISTS predictor_comparisons (
			id TEXT PRIMARY KEY,
			session_key TEXT NOT NULL,
			agent_id TEXT NOT NULL DEFAULT 'default',
			predictor_ndcg REAL NOT NULL,
			baseline_ndcg REAL NOT NULL,
			predictor_won INTEGER NOT NULL,
			margin REAL NOT NULL,
			alpha REAL NOT NULL,
			ema_updated INTEGER NOT NULL DEFAULT 0,
			focal_entity_id TEXT,
			focal_entity_name TEXT,
			project TEXT,
			candidate_count INTEGER NOT NULL,
			traversal_count INTEGER NOT NULL DEFAULT 0,
			constraint_count INTEGER NOT NULL DEFAULT 0,
			created_at TEXT NOT NULL DEFAULT (datetime('now'))
		);

		CREATE INDEX IF NOT EXISTS idx_predictor_comparisons_session
			ON predictor_comparisons(session_key);
		CREATE INDEX IF NOT EXISTS idx_predictor_comparisons_agent
			ON predictor_comparisons(agent_id);
		CREATE INDEX IF NOT EXISTS idx_predictor_comparisons_project
			ON predictor_comparisons(project);
		CREATE INDEX IF NOT EXISTS idx_predictor_comparisons_entity
			ON predictor_comparisons(focal_entity_id);

		CREATE TABLE IF NOT EXISTS predictor_training_log (
			id TEXT PRIMARY KEY,
			agent_id TEXT NOT NULL DEFAULT 'default',
			model_version INTEGER NOT NULL,
			loss REAL NOT NULL,
			sample_count INTEGER NOT NULL,
			duration_ms INTEGER NOT NULL,
			canary_ndcg REAL,
			canary_ndcg_delta REAL,
			canary_score_variance REAL,
			canary_topk_churn REAL,
			created_at TEXT NOT NULL DEFAULT (datetime('now'))
		);

		CREATE INDEX IF NOT EXISTS idx_predictor_training_agent
			ON predictor_training_log(agent_id);
	`);

	addColumnIfMissing(db, "session_memories", "entity_slot", "INTEGER");
	addColumnIfMissing(db, "session_memories", "aspect_slot", "INTEGER");
	addColumnIfMissing(db, "session_memories", "is_constraint", "INTEGER NOT NULL DEFAULT 0");
	addColumnIfMissing(db, "session_memories", "structural_density", "INTEGER");
}

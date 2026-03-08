/**
 * Migration 026: Predictor Training Pairs
 *
 * Stores anonymized feature vectors and labels for federated
 * training of the predictive memory scorer. No memory content
 * is stored -- only structural features and numerical labels.
 */

import type { MigrationDb } from "./index";

export function up(db: MigrationDb): void {
	db.exec(`
		CREATE TABLE IF NOT EXISTS predictor_training_pairs (
			id TEXT PRIMARY KEY,
			agent_id TEXT NOT NULL DEFAULT 'default',
			session_key TEXT NOT NULL,
			memory_id TEXT NOT NULL,
			-- Feature vector (anonymized -- no content, just structural features)
			recency_days REAL NOT NULL,
			access_count INTEGER NOT NULL,
			importance REAL NOT NULL,
			decay_factor REAL NOT NULL,
			embedding_similarity REAL,
			entity_slot INTEGER,
			aspect_slot INTEGER,
			is_constraint INTEGER NOT NULL DEFAULT 0,
			structural_density INTEGER,
			fts_hit_count INTEGER NOT NULL DEFAULT 0,
			-- Label (ground truth)
			agent_relevance_score REAL,
			continuity_score REAL,
			fts_overlap_score REAL,
			combined_label REAL NOT NULL,
			-- Metadata
			was_injected INTEGER NOT NULL,
			predictor_rank INTEGER,
			baseline_rank INTEGER,
			created_at TEXT NOT NULL DEFAULT (datetime('now'))
		);

		CREATE INDEX IF NOT EXISTS idx_training_pairs_agent
			ON predictor_training_pairs(agent_id);
		CREATE INDEX IF NOT EXISTS idx_training_pairs_session
			ON predictor_training_pairs(session_key);
	`);
}

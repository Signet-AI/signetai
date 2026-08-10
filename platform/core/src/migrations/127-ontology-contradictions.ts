import type { MigrationDb } from "./index";

/**
 * Migration 127: persisted contradiction observations.
 *
 * Contradictions are derived observations between two competing claim rows,
 * not a replacement truth value. Attribute ids are intentionally soft links:
 * source removal can delete a claim while the resolved observation remains
 * available for audit with its immutable content and provenance snapshots.
 */
export function up(db: MigrationDb): void {
	db.exec(`
		CREATE TABLE IF NOT EXISTS ontology_contradictions (
			id TEXT PRIMARY KEY,
			agent_id TEXT NOT NULL DEFAULT 'default',
			entity_id TEXT,
			entity_name TEXT NOT NULL,
			aspect_id TEXT,
			aspect_name TEXT NOT NULL,
			group_key TEXT NOT NULL DEFAULT 'general',
			claim_key TEXT NOT NULL,
			left_attribute_id TEXT,
			right_attribute_id TEXT,
			left_content TEXT NOT NULL,
			right_content TEXT NOT NULL,
			left_confidence REAL NOT NULL DEFAULT 0.0
				CHECK (left_confidence >= 0.0 AND left_confidence <= 1.0),
			right_confidence REAL NOT NULL DEFAULT 0.0
				CHECK (right_confidence >= 0.0 AND right_confidence <= 1.0),
			left_scope TEXT,
			right_scope TEXT,
			left_visibility TEXT,
			right_visibility TEXT,
			left_source_kind TEXT,
			left_source_id TEXT,
			left_source_path TEXT,
			left_source_root TEXT,
			right_source_kind TEXT,
			right_source_id TEXT,
			right_source_path TEXT,
			right_source_root TEXT,
			left_evidence TEXT NOT NULL DEFAULT '[]',
			right_evidence TEXT NOT NULL DEFAULT '[]',
			detector TEXT NOT NULL CHECK (detector IN ('lexical', 'semantic', 'manual')),
			reason TEXT NOT NULL,
			confidence REAL NOT NULL DEFAULT 0.0
				CHECK (confidence >= 0.0 AND confidence <= 1.0),
			status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'resolved')),
			detected_at TEXT NOT NULL,
			resolved_at TEXT,
			resolution_reason TEXT,
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL,
			UNIQUE (agent_id, left_attribute_id, right_attribute_id)
		);

		CREATE INDEX IF NOT EXISTS idx_ontology_contradictions_agent_status
			ON ontology_contradictions(agent_id, status, updated_at DESC);
		CREATE INDEX IF NOT EXISTS idx_ontology_contradictions_agent_slot
			ON ontology_contradictions(agent_id, entity_id, aspect_id, group_key, claim_key, status);
		CREATE INDEX IF NOT EXISTS idx_ontology_contradictions_attributes
			ON ontology_contradictions(agent_id, left_attribute_id, right_attribute_id);
		CREATE INDEX IF NOT EXISTS idx_ontology_contradictions_sources
			ON ontology_contradictions(agent_id, left_source_id, right_source_id);
	`);
}

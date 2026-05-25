import type { MigrationDb } from "./index";

export function up(db: MigrationDb): void {
	db.exec(`
		CREATE TABLE IF NOT EXISTS temporal_edges (
			id TEXT PRIMARY KEY,
			agent_id TEXT NOT NULL DEFAULT 'default',
			subject_type TEXT NOT NULL,
			subject_id TEXT NOT NULL,
			facet TEXT NOT NULL CHECK(facet IN ('captured', 'session', 'source', 'observed', 'occurred', 'valid')),
			start_at TEXT NOT NULL,
			end_at TEXT,
			confidence REAL NOT NULL DEFAULT 1.0,
			provenance_json TEXT,
			metadata_json TEXT,
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL
		);

		CREATE INDEX IF NOT EXISTS idx_temporal_edges_agent_facet_range
			ON temporal_edges(agent_id, facet, start_at, end_at);
		CREATE INDEX IF NOT EXISTS idx_temporal_edges_agent_subject
			ON temporal_edges(agent_id, subject_type, subject_id);
	`);
}

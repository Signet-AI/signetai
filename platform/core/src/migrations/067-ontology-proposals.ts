import type { MigrationDb } from "./index";

function hasColumn(db: MigrationDb, table: string, column: string): boolean {
	const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name?: unknown }>;
	return rows.some((row) => row.name === column);
}

function addColumnIfMissing(db: MigrationDb, table: string, column: string, definition: string): void {
	if (!hasColumn(db, table, column)) {
		db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
	}
}

/**
 * Migration 067: Ontology proposal loop.
 *
 * Stores reviewable ontology maintenance operations before they mutate graph
 * state. This is the first durable proposal-before-mutation surface for
 * transcript/source-driven ontology maintenance.
 */
export function up(db: MigrationDb): void {
	db.exec(`
		CREATE TABLE IF NOT EXISTS ontology_proposals (
			id          TEXT PRIMARY KEY,
			agent_id    TEXT NOT NULL DEFAULT 'default',
			operation   TEXT NOT NULL,
			status      TEXT NOT NULL DEFAULT 'pending'
				CHECK (status IN ('pending', 'applied', 'rejected', 'failed')),
			payload     TEXT NOT NULL,
			confidence  REAL NOT NULL DEFAULT 0.0
				CHECK (confidence >= 0.0 AND confidence <= 1.0),
			rationale   TEXT NOT NULL DEFAULT '',
			evidence    TEXT NOT NULL DEFAULT '[]',
			risk        TEXT,
			source_kind TEXT,
			source_id   TEXT,
			source_path TEXT,
			source_root TEXT,
			created_by  TEXT NOT NULL DEFAULT 'ontology-proposal',
			applied_by  TEXT,
			rejected_by TEXT,
			result      TEXT,
			created_at  TEXT NOT NULL DEFAULT (datetime('now')),
			updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
			applied_at  TEXT,
			rejected_at TEXT
		);

		CREATE INDEX IF NOT EXISTS idx_ontology_proposals_agent_status
			ON ontology_proposals(agent_id, status, updated_at DESC);

		CREATE INDEX IF NOT EXISTS idx_ontology_proposals_agent_operation
			ON ontology_proposals(agent_id, operation, updated_at DESC);

		CREATE INDEX IF NOT EXISTS idx_ontology_proposals_source
			ON ontology_proposals(agent_id, source_kind, source_id);
	`);

	for (const table of ["entity_attributes", "entity_dependencies"] as const) {
		addColumnIfMissing(db, table, "proposal_id", "TEXT");
		addColumnIfMissing(db, table, "proposal_evidence", "TEXT NOT NULL DEFAULT '[]'");
		db.exec(`CREATE INDEX IF NOT EXISTS idx_${table}_proposal ON ${table}(agent_id, proposal_id)`);
	}
}

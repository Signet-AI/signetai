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

function backfillVersionRoots(db: MigrationDb): void {
	db.exec(`
		UPDATE entity_attributes
		SET version_root_id = id
		WHERE version_root_id IS NULL
	`);
}

/**
 * Migration 070: ontology control-plane state.
 *
 * Adds first-class claim version lineage, archive/status metadata, and
 * proposal provenance columns needed by daemon-backed ontology operations.
 */
export function up(db: MigrationDb): void {
	for (const table of ["entities", "entity_aspects", "entity_dependencies"] as const) {
		addColumnIfMissing(db, table, "status", "TEXT NOT NULL DEFAULT 'active'");
		addColumnIfMissing(db, table, "archived_at", "TEXT");
		addColumnIfMissing(db, table, "archived_by", "TEXT");
		addColumnIfMissing(db, table, "archive_reason", "TEXT");
	}

	for (const table of ["entities", "entity_aspects"] as const) {
		addColumnIfMissing(db, table, "proposal_id", "TEXT");
		addColumnIfMissing(db, table, "proposal_evidence", "TEXT NOT NULL DEFAULT '[]'");
	}

	addColumnIfMissing(db, "entity_attributes", "version", "INTEGER NOT NULL DEFAULT 1");
	addColumnIfMissing(db, "entity_attributes", "version_root_id", "TEXT");
	addColumnIfMissing(db, "entity_attributes", "previous_attribute_id", "TEXT");
	addColumnIfMissing(db, "entity_attributes", "archived_at", "TEXT");
	addColumnIfMissing(db, "entity_attributes", "archived_by", "TEXT");
	addColumnIfMissing(db, "entity_attributes", "archive_reason", "TEXT");
	backfillVersionRoots(db);

	db.exec(`
		CREATE INDEX IF NOT EXISTS idx_entities_status
			ON entities(agent_id, status, updated_at DESC);
		CREATE INDEX IF NOT EXISTS idx_entity_aspects_status
			ON entity_aspects(agent_id, entity_id, status);
		CREATE INDEX IF NOT EXISTS idx_entity_attributes_version_root
			ON entity_attributes(agent_id, version_root_id, version DESC);
		CREATE INDEX IF NOT EXISTS idx_entity_attributes_claim_version
			ON entity_attributes(agent_id, aspect_id, group_key, claim_key, version DESC);
		CREATE INDEX IF NOT EXISTS idx_entity_dependencies_status
			ON entity_dependencies(agent_id, status, updated_at DESC);
		CREATE INDEX IF NOT EXISTS idx_entities_proposal
			ON entities(agent_id, proposal_id);
		CREATE INDEX IF NOT EXISTS idx_entity_aspects_proposal
			ON entity_aspects(agent_id, proposal_id);
	`);
}

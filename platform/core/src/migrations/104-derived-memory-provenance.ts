import type { MigrationDb } from "./contract";

function tableExists(db: MigrationDb, table: string): boolean {
	return db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) !== undefined;
}

function hasColumn(db: MigrationDb, table: string, column: string): boolean {
	return (db.prepare(`PRAGMA table_info(${table})`).all() as ReadonlyArray<Record<string, unknown>>).some(
		(row) => row.name === column,
	);
}
export function up(db: MigrationDb): void {
	db.exec(`
		CREATE TABLE IF NOT EXISTS derived_memory_sources (
			derived_memory_id TEXT NOT NULL,
			source_kind TEXT NOT NULL,
			source_id TEXT NOT NULL,
			source_path TEXT,
			agent_id TEXT NOT NULL,
			created_at TEXT NOT NULL,
			PRIMARY KEY (derived_memory_id, source_kind, source_id)
		);
		CREATE INDEX IF NOT EXISTS idx_derived_memory_sources_derived
			ON derived_memory_sources(agent_id, derived_memory_id);
		CREATE INDEX IF NOT EXISTS idx_derived_memory_sources_source
			ON derived_memory_sources(agent_id, source_kind, source_id);
	`);

	if (tableExists(db, "aggregate_evidence_sources")) {
		db.exec(`
			INSERT OR IGNORE INTO derived_memory_sources
			 (derived_memory_id, source_kind, source_id, source_path, agent_id, created_at)
			SELECT aggregate_memory_id, source_kind, source_id, source_path, agent_id, created_at
			FROM aggregate_evidence_sources
		`);
	}
	if (tableExists(db, "aggregate_memory_sources")) {
		db.exec(`
			INSERT OR IGNORE INTO derived_memory_sources
			 (derived_memory_id, source_kind, source_id, source_path, agent_id, created_at)
			SELECT aggregate_memory_id, 'memory', source_memory_id, NULL, agent_id, created_at
			FROM aggregate_memory_sources
		`);
	}

	if (tableExists(db, "memories") && !hasColumn(db, "memories", "stale_at")) {
		db.exec("ALTER TABLE memories ADD COLUMN stale_at TEXT");
	}
	if (tableExists(db, "memories")) {
		db.exec(`
			CREATE INDEX IF NOT EXISTS idx_memories_stale_derived
			ON memories(agent_id, stale_at)
			WHERE stale_at IS NOT NULL AND is_deleted = 0
		`);
	}
}

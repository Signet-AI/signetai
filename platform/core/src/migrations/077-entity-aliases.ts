import type { MigrationDb } from "./index";

export function up(db: MigrationDb): void {
	db.exec(`
		CREATE TABLE IF NOT EXISTS entity_aliases (
			id TEXT PRIMARY KEY,
			entity_id TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
			agent_id TEXT NOT NULL DEFAULT 'default',
			alias TEXT NOT NULL,
			canonical_alias TEXT NOT NULL,
			confidence REAL NOT NULL DEFAULT 1.0,
			source TEXT,
			status TEXT NOT NULL DEFAULT 'active',
			created_at TEXT NOT NULL DEFAULT (datetime('now')),
			updated_at TEXT NOT NULL DEFAULT (datetime('now'))
		);

		CREATE UNIQUE INDEX IF NOT EXISTS idx_entity_aliases_active_unique
			ON entity_aliases(agent_id, canonical_alias)
			WHERE status = 'active';
		CREATE INDEX IF NOT EXISTS idx_entity_aliases_entity
			ON entity_aliases(agent_id, entity_id, status);
		CREATE INDEX IF NOT EXISTS idx_entity_aliases_lookup
			ON entity_aliases(agent_id, canonical_alias, status);
	`);
}

import type { MigrationDb } from "./contract";
export function up(db: MigrationDb): void {
	db.exec(`
		CREATE TABLE IF NOT EXISTS entity_communities (
			id TEXT PRIMARY KEY,
			agent_id TEXT NOT NULL,
			name TEXT,
			cohesion REAL DEFAULT 0.0,
			member_count INTEGER DEFAULT 0,
			created_at TEXT NOT NULL DEFAULT (datetime('now')),
			updated_at TEXT NOT NULL DEFAULT (datetime('now'))
		)
	`);

	db.exec("CREATE INDEX IF NOT EXISTS idx_entity_communities_agent ON entity_communities(agent_id)");
	const cols = db.prepare("PRAGMA table_info(entities)").all() as Array<{
		name: string;
	}>;
	if (!cols.some((c) => c.name === "community_id")) {
		db.exec("ALTER TABLE entities ADD COLUMN community_id TEXT REFERENCES entity_communities(id)");
	}
}

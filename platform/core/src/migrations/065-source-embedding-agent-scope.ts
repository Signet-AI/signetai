import type { MigrationDb } from "./index";

function hasTable(db: MigrationDb, table: string): boolean {
	const row = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name = ?").get(table) as
		| { name?: unknown }
		| undefined;
	return row?.name === table;
}

function hasColumn(db: MigrationDb, table: string, column: string): boolean {
	const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name?: unknown }>;
	return rows.some((row) => row.name === column);
}

/**
 * Migration 065: agent-scoped source embeddings.
 *
 * Source chunks are retrieval views over external knowledge bases. They need an
 * explicit agent owner so vector recall and scoped disconnect cannot leak or
 * delete another agent's connected source chunks.
 */
export function up(db: MigrationDb): void {
	if (!hasTable(db, "embeddings")) return;

	if (!hasColumn(db, "embeddings", "agent_id")) {
		db.exec("ALTER TABLE embeddings ADD COLUMN agent_id TEXT");
	}

	db.exec("CREATE INDEX IF NOT EXISTS idx_embeddings_agent_source ON embeddings(agent_id, source_type, source_id)");
}

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
 * Migration 064: source graph provenance.
 *
 * Sources such as Obsidian are mounted as read-only graph citizens. These
 * provenance columns keep the source-native filesystem topology visible on the
 * graph rows that were created from that source, so disconnect can purge them
 * without touching user-authored memories or unrelated semantic graph rows.
 */
export function up(db: MigrationDb): void {
	for (const table of ["entities", "entity_communities", "entity_attributes", "entity_dependencies"] as const) {
		addColumnIfMissing(db, table, "source_id", "TEXT");
		addColumnIfMissing(db, table, "source_kind", "TEXT");
		addColumnIfMissing(db, table, "source_path", "TEXT");
		addColumnIfMissing(db, table, "source_root", "TEXT");
	}

	db.exec("CREATE INDEX IF NOT EXISTS idx_entities_source ON entities(agent_id, source_id, source_path)");
	db.exec(
		"CREATE INDEX IF NOT EXISTS idx_entity_communities_source ON entity_communities(agent_id, source_id, source_path)",
	);
	db.exec(
		"CREATE INDEX IF NOT EXISTS idx_entity_attributes_source ON entity_attributes(agent_id, source_id, source_path)",
	);
	db.exec(
		"CREATE INDEX IF NOT EXISTS idx_entity_dependencies_source_origin ON entity_dependencies(agent_id, source_id, source_path)",
	);
}

import type { MigrationDb } from "./index";

function hasColumn(db: MigrationDb, table: string, column: string): boolean {
	const rows = db.prepare(`PRAGMA table_info(${table})`).all() as ReadonlyArray<
		Record<string, unknown>
	>;
	return rows.some((r) => r.name === column);
}

function addColumnIfMissing(
	db: MigrationDb,
	table: string,
	column: string,
	definition: string,
): void {
	if (!hasColumn(db, table, column)) {
		db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
	}
}

export function up(db: MigrationDb): void {
	// Extend entities with canonical name, mention count, and embedding vector
	addColumnIfMissing(db, "entities", "canonical_name", "TEXT");
	addColumnIfMissing(db, "entities", "mentions", "INTEGER DEFAULT 0");
	addColumnIfMissing(db, "entities", "embedding", "BLOB");

	// Extend relations with occurrence count, confidence, and timestamp
	addColumnIfMissing(db, "relations", "mentions", "INTEGER DEFAULT 1");
	addColumnIfMissing(db, "relations", "confidence", "REAL DEFAULT 0.5");
	addColumnIfMissing(db, "relations", "updated_at", "TEXT");

	// Extend memory_entity_mentions with provenance and temporal data
	addColumnIfMissing(db, "memory_entity_mentions", "mention_text", "TEXT");
	addColumnIfMissing(db, "memory_entity_mentions", "confidence", "REAL");
	addColumnIfMissing(db, "memory_entity_mentions", "created_at", "TEXT");

	// Index canonical_name for fast entity resolution lookups
	db.exec(
		"CREATE INDEX IF NOT EXISTS idx_entities_canonical_name ON entities(canonical_name)",
	);

	// Composite index for traversing outgoing edges by type
	db.exec(
		"CREATE INDEX IF NOT EXISTS idx_relations_composite ON relations(source_entity_id, relation_type)",
	);
}

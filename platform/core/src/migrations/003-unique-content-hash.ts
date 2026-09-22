import type { MigrationDb } from "./contract";
function addColumnIfMissing(db: MigrationDb, table: string, column: string, definition: string): boolean {
	const rows = db.prepare(`PRAGMA table_info(${table})`).all() as ReadonlyArray<Record<string, unknown>>;
	if (rows.some((r) => r.name === column)) return false;
	db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
	return true;
}

export function up(db: MigrationDb): void {
	addColumnIfMissing(db, "memories", "why", "TEXT");
	addColumnIfMissing(db, "memories", "project", "TEXT");
	db.exec(`DROP INDEX IF EXISTS idx_memories_content_hash`);
	db.exec(`
		UPDATE memories
		SET content_hash = NULL
		WHERE content_hash IS NOT NULL
		  AND is_deleted = 0
		  AND id NOT IN (
			SELECT id FROM (
				SELECT id, ROW_NUMBER() OVER (
					PARTITION BY content_hash
					ORDER BY created_at DESC, rowid DESC
				) AS rn
				FROM memories
				WHERE content_hash IS NOT NULL
				  AND is_deleted = 0
			) ranked
			WHERE rn = 1
		  )
	`);
	db.exec(`
		CREATE UNIQUE INDEX IF NOT EXISTS idx_memories_content_hash_unique
			ON memories(content_hash)
			WHERE content_hash IS NOT NULL AND is_deleted = 0
	`);
}

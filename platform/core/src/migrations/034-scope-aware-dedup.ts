import type { MigrationDb } from "./contract";
export function up(db: MigrationDb): void {
	db.exec("DROP INDEX IF EXISTS idx_memories_content_hash_unique");
	db.exec(`
		CREATE UNIQUE INDEX idx_memories_content_hash_unique
		ON memories(content_hash, COALESCE(scope, '__NULL__'))
		WHERE content_hash IS NOT NULL AND is_deleted = 0
	`);
}

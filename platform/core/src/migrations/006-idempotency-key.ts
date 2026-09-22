import type { MigrationDb } from "./contract";

function hasColumn(db: MigrationDb, table: string, column: string): boolean {
	const rows = db.prepare(`PRAGMA table_info(${table})`).all() as ReadonlyArray<Record<string, unknown>>;
	return rows.some((r) => r.name === column);
}

export function up(db: MigrationDb): void {
	if (!hasColumn(db, "memories", "idempotency_key")) {
		db.exec("ALTER TABLE memories ADD COLUMN idempotency_key TEXT");
	}
	db.exec(
		`CREATE UNIQUE INDEX IF NOT EXISTS idx_memories_idempotency_key
		 ON memories(idempotency_key)
		 WHERE idempotency_key IS NOT NULL`,
	);
	if (!hasColumn(db, "memories", "runtime_path")) {
		db.exec("ALTER TABLE memories ADD COLUMN runtime_path TEXT");
	}
}

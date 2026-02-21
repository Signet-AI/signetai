import type { MigrationDb } from "./index";

function hasColumn(db: MigrationDb, table: string, column: string): boolean {
	const rows = db.prepare(`PRAGMA table_info(${table})`).all() as ReadonlyArray<
		Record<string, unknown>
	>;
	return rows.some((r) => r.name === column);
}

export function up(db: MigrationDb): void {
	// Add idempotency_key column for dedup across runtime paths
	if (!hasColumn(db, "memories", "idempotency_key")) {
		db.exec(
			"ALTER TABLE memories ADD COLUMN idempotency_key TEXT",
		);
	}

	// Unique partial index — only enforced when key is present
	db.exec(
		`CREATE UNIQUE INDEX IF NOT EXISTS idx_memories_idempotency_key
		 ON memories(idempotency_key)
		 WHERE idempotency_key IS NOT NULL`,
	);

	// Add runtime_path column to track which path produced each memory
	if (!hasColumn(db, "memories", "runtime_path")) {
		db.exec(
			"ALTER TABLE memories ADD COLUMN runtime_path TEXT",
		);
	}
}

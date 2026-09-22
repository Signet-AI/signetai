import type { MigrationDb } from "./contract";
export function up(db: MigrationDb): void {
	const cols = db.prepare("PRAGMA table_info(embeddings)").all() as Array<{ name: string }>;
	if (cols.length === 0) return;
	if (!cols.some((c) => c.name === "vector")) {
		db.exec("ALTER TABLE embeddings ADD COLUMN vector BLOB");
	}
}

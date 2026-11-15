import type { MigrationDb } from "./contract";

export function up(db: MigrationDb): void {
	db.exec(`
		CREATE TABLE IF NOT EXISTS dreaming_policies (
			hash TEXT PRIMARY KEY,
			text TEXT NOT NULL,
			created_at TEXT NOT NULL
		);
	`);
	const columns = new Set(
		(db.prepare("PRAGMA table_info(dreaming_passes)").all() as Array<{ name: string }>).map((column) => column.name),
	);
	if (!columns.has("policy_hash")) db.exec("ALTER TABLE dreaming_passes ADD COLUMN policy_hash TEXT");
	if (!columns.has("policy_source"))
		db.exec("ALTER TABLE dreaming_passes ADD COLUMN policy_source TEXT CHECK (policy_source IN ('default', 'custom'))");
}

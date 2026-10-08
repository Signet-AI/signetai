import type { MigrationDb } from "./contract";

export function up(db: MigrationDb): void {
	if (
		db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'dreaming_evidence_consumption'").get() ==
		null
	)
		return;
	const columns = db.prepare("PRAGMA table_info(dreaming_evidence_consumption)").all() as Array<{ name: string }>;
	if (!columns.some((column) => column.name === "cursor_basis")) {
		db.exec(
			"ALTER TABLE dreaming_evidence_consumption ADD COLUMN cursor_basis TEXT NOT NULL DEFAULT 'delivery' CHECK (cursor_basis IN ('delivery', 'review'))",
		);
	}
	if (!columns.some((column) => column.name === "stalled_passes")) {
		db.exec(
			"ALTER TABLE dreaming_evidence_consumption ADD COLUMN stalled_passes INTEGER NOT NULL DEFAULT 0 CHECK (stalled_passes >= 0)",
		);
	}
}

import type { MigrationDb } from "./contract";

export function up(db: MigrationDb): void {
	const columns = db.prepare("PRAGMA table_info(session_checkpoints)").all() as ReadonlyArray<Record<string, unknown>>;
	const columnNames = new Set(columns.flatMap((column) => (typeof column.name === "string" ? [column.name] : [])));

	if (!columnNames.has("focal_entity_ids")) {
		db.exec("ALTER TABLE session_checkpoints ADD COLUMN focal_entity_ids TEXT");
	}
	if (!columnNames.has("focal_entity_names")) {
		db.exec("ALTER TABLE session_checkpoints ADD COLUMN focal_entity_names TEXT");
	}
	if (!columnNames.has("active_aspect_ids")) {
		db.exec("ALTER TABLE session_checkpoints ADD COLUMN active_aspect_ids TEXT");
	}
	if (!columnNames.has("surfaced_constraint_count")) {
		db.exec("ALTER TABLE session_checkpoints ADD COLUMN surfaced_constraint_count INTEGER");
	}
	if (!columnNames.has("traversal_memory_count")) {
		db.exec("ALTER TABLE session_checkpoints ADD COLUMN traversal_memory_count INTEGER");
	}
}

import { DAEMON_DERIVED_MEMORY_SOURCE_TYPES } from "../memory-provenance";
import type { MigrationDb } from "./contract";
const DERIVED_SOURCE_TYPES = DAEMON_DERIVED_MEMORY_SOURCE_TYPES;

function hasColumn(db: MigrationDb, table: string, column: string): boolean {
	const rows = db.prepare(`PRAGMA table_info(${table})`).all() as ReadonlyArray<Record<string, unknown>>;
	return rows.some((r) => r.name === column);
}

export function up(db: MigrationDb): void {
	const tables = db
		.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name = 'memories'")
		.all() as ReadonlyArray<Record<string, unknown>>;
	if (tables.length === 0) return;

	if (!hasColumn(db, "memories", "memory_kind")) {
		db.exec("ALTER TABLE memories ADD COLUMN memory_kind TEXT");
	}
	if (!hasColumn(db, "memories", "evidence_meta")) {
		db.exec("ALTER TABLE memories ADD COLUMN evidence_meta TEXT");
	}
	if (hasColumn(db, "memories", "source_type")) {
		const placeholders = DERIVED_SOURCE_TYPES.map(() => "?").join(", ");
		db.prepare(
			`UPDATE memories
				 SET memory_kind = 'episodic'
				 WHERE memory_kind IS NULL
				   AND (source_type IS NULL OR source_type NOT IN (${placeholders}))`,
		).run(...DERIVED_SOURCE_TYPES);
	} else {
		db.exec(
			`UPDATE memories
			 SET memory_kind = 'episodic'
			 WHERE memory_kind IS NULL`,
		);
	}
}

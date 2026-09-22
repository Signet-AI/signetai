import type { MigrationDb } from "./contract";
export function up(db: MigrationDb): void {
	db.exec(`
		CREATE VIRTUAL TABLE IF NOT EXISTS entities_fts USING fts5(
			name, canonical_name,
			content='entities', content_rowid='rowid'
		)
	`);

	db.exec(`
		INSERT INTO entities_fts(rowid, name, canonical_name)
		SELECT rowid, name, canonical_name FROM entities
	`);

	db.exec(`
		CREATE TRIGGER IF NOT EXISTS entities_fts_ai AFTER INSERT ON entities BEGIN
			INSERT INTO entities_fts(rowid, name, canonical_name)
			VALUES (new.rowid, new.name, new.canonical_name);
		END
	`);

	db.exec(`
		CREATE TRIGGER IF NOT EXISTS entities_fts_ad AFTER DELETE ON entities BEGIN
			INSERT INTO entities_fts(entities_fts, rowid, name, canonical_name)
			VALUES ('delete', old.rowid, old.name, old.canonical_name);
		END
	`);

	db.exec(`
		CREATE TRIGGER IF NOT EXISTS entities_fts_au AFTER UPDATE ON entities BEGIN
			INSERT INTO entities_fts(entities_fts, rowid, name, canonical_name)
			VALUES ('delete', old.rowid, old.name, old.canonical_name);
			INSERT INTO entities_fts(rowid, name, canonical_name)
			VALUES (new.rowid, new.name, new.canonical_name);
		END
	`);
}

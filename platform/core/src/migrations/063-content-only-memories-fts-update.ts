export function up(db: { exec(sql: string): void }): void {
	db.exec("DROP TRIGGER IF EXISTS memories_au");
	db.exec(`
		CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE OF content ON memories BEGIN
			INSERT INTO memories_fts(memories_fts, rowid, content) VALUES('delete', old.rowid, old.content);
			INSERT INTO memories_fts(rowid, content) VALUES (new.rowid, new.content);
		END;
	`);
}

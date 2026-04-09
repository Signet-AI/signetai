export interface FtsSchemaExecDb {
	exec(sql: string): void;
}

export interface FtsSchemaQueryDb {
	prepare(sql: string): {
		get(...args: unknown[]): Record<string, unknown> | undefined;
	};
}

const MEMORIES_FTS_TOKENIZER = "unicode61";

function normalizeSql(sql: string): string {
	return sql.replace(/\s+/g, " ").trim().toLowerCase();
}

export function createMemoriesFts(db: FtsSchemaExecDb): void {
	db.exec(`
		CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
			content,
			content='memories',
			content_rowid='rowid',
			tokenize='${MEMORIES_FTS_TOKENIZER}'
		);
	`);

	db.exec(`
		CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
			INSERT INTO memories_fts(rowid, content) VALUES (new.rowid, new.content);
		END;
	`);
	db.exec(`
		CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
			INSERT INTO memories_fts(memories_fts, rowid, content) VALUES('delete', old.rowid, old.content);
		END;
	`);
	db.exec(`
		CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE ON memories BEGIN
			INSERT INTO memories_fts(memories_fts, rowid, content) VALUES('delete', old.rowid, old.content);
			INSERT INTO memories_fts(rowid, content) VALUES (new.rowid, new.content);
		END;
	`);
}

export function recreateMemoriesFts(db: FtsSchemaExecDb): void {
	db.exec("DROP TRIGGER IF EXISTS memories_ai");
	db.exec("DROP TRIGGER IF EXISTS memories_ad");
	db.exec("DROP TRIGGER IF EXISTS memories_au");
	db.exec("DROP TABLE IF EXISTS memories_fts");
	createMemoriesFts(db);
	db.exec("INSERT INTO memories_fts(rowid, content) SELECT rowid, content FROM memories");
}

export function readMemoriesFtsSql(db: FtsSchemaQueryDb): string | null {
	const row = db.prepare("SELECT sql FROM sqlite_master WHERE name = 'memories_fts' AND type = 'table'").get() as
		| { sql?: unknown }
		| undefined;
	return typeof row?.sql === "string" ? row.sql : null;
}

export function memoriesFtsNeedsTokenizerRepair(sql: string | null): boolean {
	if (sql === null) return false;
	const normalized = normalizeSql(sql);
	if (normalized.includes("porter unicode61")) return true;
	return !normalized.includes(`tokenize='${MEMORIES_FTS_TOKENIZER}'`);
}

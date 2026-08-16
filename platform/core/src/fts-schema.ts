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
		CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE OF content ON memories BEGIN
			INSERT INTO memories_fts(memories_fts, rowid, content) VALUES('delete', old.rowid, old.content);
			INSERT INTO memories_fts(rowid, content) VALUES (new.rowid, new.content);
		END;
	`);
}

export function recreateMemoriesFtsSchema(db: FtsSchemaExecDb): void {
	db.exec("DROP TRIGGER IF EXISTS memories_ai");
	db.exec("DROP TRIGGER IF EXISTS memories_ad");
	db.exec("DROP TRIGGER IF EXISTS memories_au");
	db.exec("DROP TABLE IF EXISTS memories_fts");
	createMemoriesFts(db);
}

export function recreateMemoriesFts(db: FtsSchemaExecDb): void {
	recreateMemoriesFtsSchema(db);
	db.exec("INSERT INTO memories_fts(rowid, content) SELECT rowid, content FROM memories");
}

export function readMemoriesFtsSql(db: FtsSchemaQueryDb): string | null {
	const row = db.prepare("SELECT sql FROM sqlite_master WHERE name = 'memories_fts' AND type = 'table'").get() as
		| { sql?: unknown }
		| undefined;
	return typeof row?.sql === "string" ? row.sql : null;
}

/**
 * Return the number of documents physically present in the FTS index.
 *
 * An external-content FTS table resolves COUNT(*) through its content table,
 * so COUNT(*) FROM memories_fts includes tombstones and cannot describe index
 * integrity. The docsize shadow table tracks indexed documents instead.
 */
export function readMemoriesFtsIndexRowCount(db: FtsSchemaQueryDb): number | null {
	const row = db.prepare("SELECT COUNT(*) AS count FROM memories_fts_docsize").get() as { count?: unknown } | undefined;
	return typeof row?.count === "number" ? row.count : null;
}

export function memoriesFtsNeedsTokenizerRepair(sql: string | null): boolean {
	if (sql === null) return false;
	const normalized = normalizeSql(sql);
	if (normalized.includes("porter unicode61")) return true;
	return !normalized.includes(`tokenize='${MEMORIES_FTS_TOKENIZER}'`);
}

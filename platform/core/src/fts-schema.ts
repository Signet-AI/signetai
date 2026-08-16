export interface FtsSchemaExecDb {
	exec(sql: string): void;
}

export interface FtsSchemaQueryDb {
	prepare(sql: string): {
		get(...args: unknown[]): Record<string, unknown> | undefined;
	};
}

const MEMORIES_FTS_TOKENIZER = "unicode61";
const FTS_STATE_TABLE = "memories_fts_state";

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
	ensureMemoriesFtsState(db);
	createMemoriesFtsTriggers(db);
}

function ensureMemoriesFtsState(db: FtsSchemaExecDb): void {
	db.exec(`
		CREATE TABLE IF NOT EXISTS ${FTS_STATE_TABLE} (
			id INTEGER PRIMARY KEY CHECK (id = 1),
			memory_count INTEGER NOT NULL,
			indexed_count INTEGER NOT NULL,
			updated_at TEXT NOT NULL
		);
		INSERT OR IGNORE INTO ${FTS_STATE_TABLE} (id, memory_count, indexed_count, updated_at)
		VALUES (
			1,
			-1,
			0,
			datetime('now')
		);
	`);
}

function createMemoriesFtsTriggers(db: FtsSchemaExecDb): void {
	db.exec(`
		DROP TRIGGER IF EXISTS memories_ai;
		DROP TRIGGER IF EXISTS memories_ad;
		DROP TRIGGER IF EXISTS memories_au;

		CREATE TRIGGER memories_ai AFTER INSERT ON memories BEGIN
			INSERT INTO memories_fts(rowid, content) VALUES (new.rowid, new.content);
			UPDATE ${FTS_STATE_TABLE}
			 SET memory_count = CASE WHEN memory_count < 0 THEN -1 ELSE memory_count + 1 END,
			     indexed_count = CASE WHEN indexed_count < 0 THEN 0 ELSE indexed_count + 1 END,
			     updated_at = datetime('now')
			 WHERE id = 1;
		END;

		CREATE TRIGGER memories_ad AFTER DELETE ON memories BEGIN
			INSERT INTO memories_fts(memories_fts, rowid, content) VALUES('delete', old.rowid, old.content);
			UPDATE ${FTS_STATE_TABLE}
			 SET memory_count = CASE WHEN memory_count < 0 THEN -1 ELSE MAX(0, memory_count - 1) END,
			     indexed_count = CASE WHEN indexed_count < 0 THEN 0 ELSE MAX(0, indexed_count - 1) END,
			     updated_at = datetime('now')
			 WHERE id = 1;
		END;

		CREATE TRIGGER memories_au AFTER UPDATE OF content ON memories BEGIN
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
	db.exec(`DROP TABLE IF EXISTS ${FTS_STATE_TABLE}`);
	createMemoriesFts(db);
}

export function recreateMemoriesFts(db: FtsSchemaExecDb): void {
	recreateMemoriesFtsSchema(db);
	db.exec("INSERT INTO memories_fts(rowid, content) SELECT rowid, content FROM memories");
	refreshMemoriesFtsState(db);
}

/** Refresh the persistent counters after a bulk FTS operation. */
export function refreshMemoriesFtsState(db: FtsSchemaExecDb): void {
	ensureMemoriesFtsState(db);
	db.exec(`
		UPDATE ${FTS_STATE_TABLE}
		 SET memory_count = (SELECT COUNT(*) FROM memories),
		     indexed_count = (SELECT COUNT(*) FROM memories_fts_docsize),
		     updated_at = datetime('now')
		 WHERE id = 1;
	`);
}

export function readMemoriesFtsState(
	db: FtsSchemaQueryDb,
): { readonly memoryCount: number; readonly indexedCount: number } | null {
	const row = db.prepare(`SELECT memory_count, indexed_count FROM ${FTS_STATE_TABLE} WHERE id = 1`).get() as
		| { memory_count?: unknown; indexed_count?: unknown }
		| undefined;
	if (typeof row?.memory_count !== "number" || typeof row.indexed_count !== "number") return null;
	return { memoryCount: row.memory_count, indexedCount: row.indexed_count };
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

/**
 * Singleton DB accessor for the Signet daemon.
 *
 * Holds a single write connection for the daemon's lifetime and provides
 * transaction wrappers for safe concurrent access. Read connections are
 * opened on demand (SQLite WAL mode allows concurrent readers).
 */

import { Database, type Statement } from "bun:sqlite";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import {
	DEFAULT_EMBEDDING_DIMENSIONS,
	createMemoriesFts,
	findSqliteVecExtension,
	hasPendingMigrations,
	memoriesFtsNeedsTokenizerRepair,
	readMemoriesFtsSql,
	recreateMemoriesFts,
	runMigrations,
} from "@signet/core";

const HOMEBREW_SQLITE_PATHS = [
	"/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib",
	"/usr/local/opt/sqlite/lib/libsqlite3.dylib",
] as const;

type SqliteSource = "env" | "workspace" | "homebrew";

export interface SqliteChoice {
	readonly path: string;
	readonly source: SqliteSource;
}

export interface VectorRuntimeStatus {
	readonly sqlite: SqliteChoice | null;
	readonly sqliteAttempt: string | null;
	readonly sqliteWarning: string | null;
	readonly extensionPath: string | null;
	readonly extensionLoaded: boolean;
	readonly extensionLoadError: string | null;
}

interface SqliteRuntimeConfig {
	readonly choice: SqliteChoice | null;
	readonly attempt: string | null;
	readonly warning: string | null;
}

// ---------------------------------------------------------------------------
// Public interfaces — thin wrappers over the bun:sqlite Database surface
// ---------------------------------------------------------------------------

export interface WriteDb {
	exec(sql: string): void;
	prepare(sql: string): Statement;
}

export interface ReadDb {
	prepare(sql: string): Statement;
}

export interface DbAccessor {
	/** Run `fn` inside BEGIN IMMEDIATE / COMMIT (ROLLBACK on error). */
	withWriteTx<T>(fn: (db: WriteDb) => T): T;

	/** Open a readonly connection, run `fn`, close it. */
	withReadDb<T>(fn: (db: ReadDb) => T): T;

	/** Close all held connections. Safe to call multiple times. */
	close(): void;
}

// ---------------------------------------------------------------------------
// Singleton state
// ---------------------------------------------------------------------------

let accessor: DbAccessor | null = null;
let dbPath: string | null = null;
let sqliteChoice: SqliteChoice | null = null;
let sqliteAttempt: string | null = null;
let sqliteWarning: string | null = null;
let vecLoaded = false;
let vecLoadError: string | null = null;

// ---------------------------------------------------------------------------
// Initialisation
// ---------------------------------------------------------------------------

function configurePragmas(db: Database): void {
	db.exec("PRAGMA journal_mode = WAL");
	db.exec("PRAGMA busy_timeout = 5000");
	db.exec("PRAGMA synchronous = NORMAL");
	db.exec("PRAGMA temp_store = MEMORY");
}

function toRecordOrUndefined(row: unknown): Record<string, unknown> | undefined {
	if (typeof row !== "object" || row === null) return undefined;
	return row as Record<string, unknown>;
}

function toMigrationDb(db: Database): {
	exec(sql: string): void;
	prepare(sql: string): {
		run(...args: unknown[]): void;
		get(...args: unknown[]): Record<string, unknown> | undefined;
		all(...args: unknown[]): Record<string, unknown>[];
	};
} {
	return {
		exec(sql: string): void {
			db.exec(sql);
		},
		prepare(sql: string) {
			const stmt = db.prepare(sql);
			return {
				run(...args: unknown[]): void {
					stmt.run(...args);
				},
				get(...args: unknown[]): Record<string, unknown> | undefined {
					return toRecordOrUndefined(stmt.get(...args));
				},
				all(...args: unknown[]): Record<string, unknown>[] {
					const rows = stmt.all(...args);
					return rows
						.map((row) => toRecordOrUndefined(row))
						.filter((row): row is Record<string, unknown> => row !== undefined);
				},
			};
		},
	};
}

function toFtsSchemaQueryDb(db: Database): {
	prepare(sql: string): {
		get(...args: unknown[]): Record<string, unknown> | undefined;
	};
} {
	return {
		prepare(sql: string) {
			const stmt = db.prepare(sql);
			return {
				get(...args: unknown[]): Record<string, unknown> | undefined {
					return toRecordOrUndefined(stmt.get(...args));
				},
			};
		},
	};
}

// Cached extension path — resolved once at startup
let vecExtPath: string | null | undefined;

function readTrimmed(env: NodeJS.ProcessEnv, key: string): string | null {
	const value = env[key];
	if (typeof value !== "string") return null;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : null;
}

function readConfigHome(env: NodeJS.ProcessEnv): string {
	const dir = readTrimmed(env, "XDG_CONFIG_HOME");
	if (dir !== null) return dir;
	return join(homedir(), ".config");
}

function readWorkspaceConfig(path: string): string | null {
	if (!existsSync(path)) return null;

	try {
		const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
		if (typeof raw !== "object" || raw === null) return null;
		if (!("workspace" in raw)) return null;
		const value = raw.workspace;
		if (typeof value !== "string") return null;
		const trimmed = value.trim();
		return trimmed.length > 0 ? trimmed : null;
	} catch {
		return null;
	}
}

export function resolveSqliteAgentsDir(opts?: {
	readonly env?: NodeJS.ProcessEnv;
	readonly home?: () => string;
}): string {
	const env = opts?.env ?? process.env;
	const path = readTrimmed(env, "SIGNET_PATH");
	if (path !== null) return path;

	const cfg = readWorkspaceConfig(join(readConfigHome(env), "signet", "workspace.json"));
	if (cfg !== null) return cfg;

	return join((opts?.home ?? homedir)(), ".agents");
}

export function resolveCustomSqlitePath(opts?: {
	readonly platform?: NodeJS.Platform;
	readonly env?: NodeJS.ProcessEnv;
	readonly agentsDir?: string;
	readonly exists?: (path: string) => boolean;
}): SqliteChoice | null {
	const platform = opts?.platform ?? process.platform;
	if (platform !== "darwin") return null;

	const env = opts?.env ?? process.env;
	const exists = opts?.exists ?? existsSync;
	const agentsDir = opts?.agentsDir ?? resolveSqliteAgentsDir({ env });

	const envPath = env.SIGNET_SQLITE_PATH;
	if (envPath) {
		if (exists(envPath)) {
			return { path: envPath, source: "env" };
		}
		return null;
	}

	const local = join(agentsDir, "libsqlite3.dylib");
	if (exists(local)) {
		return { path: local, source: "workspace" };
	}

	for (const path of HOMEBREW_SQLITE_PATHS) {
		if (exists(path)) {
			return { path, source: "homebrew" };
		}
	}

	return null;
}

function resolveHomebrewSqlitePath(exists: (path: string) => boolean): SqliteChoice | null {
	for (const path of HOMEBREW_SQLITE_PATHS) {
		if (exists(path)) {
			return { path, source: "homebrew" };
		}
	}

	return null;
}

function explainSqliteSetup(agentsDir: string): string {
	return [
		"macOS system SQLite may block loadExtension() and force keyword-only recall.",
		`Set SIGNET_SQLITE_PATH, place libsqlite3.dylib in ${agentsDir}, or install Homebrew sqlite.`,
	].join(" ");
}

export function resolveSqliteRuntimeConfig(opts?: {
	readonly platform?: NodeJS.Platform;
	readonly env?: NodeJS.ProcessEnv;
	readonly agentsDir?: string;
	readonly exists?: (path: string) => boolean;
	readonly set?: (path: string) => void;
}): SqliteRuntimeConfig {
	const platform = opts?.platform ?? process.platform;
	if (platform !== "darwin") {
		return {
			choice: null,
			attempt: null,
			warning: null,
		};
	}

	const env = opts?.env ?? process.env;
	const exists = opts?.exists ?? existsSync;
	const set = opts?.set ?? ((path: string) => Database.setCustomSQLite(path));
	const agentsDir = opts?.agentsDir ?? resolveSqliteAgentsDir({ env });
	const envPath = env.SIGNET_SQLITE_PATH;
	if (envPath && !exists(envPath)) {
		return {
			choice: null,
			attempt: envPath,
			warning: `SIGNET_SQLITE_PATH does not exist: ${envPath}. Explicit override is authoritative, refusing fallback to workspace/Homebrew SQLite.`,
		};
	}

	const choice = resolveCustomSqlitePath({ platform, env, agentsDir, exists });
	if (!choice) {
		return {
			choice: null,
			attempt: null,
			warning: explainSqliteSetup(agentsDir),
		};
	}

	try {
		set(choice.path);
		return {
			choice,
			attempt: choice.path,
			warning: null,
		};
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		if (choice.source !== "workspace") {
			return {
				choice: null,
				attempt: choice.path,
				warning: `Failed to activate custom SQLite at ${choice.path}: ${msg}. ${explainSqliteSetup(agentsDir)}`,
			};
		}

		const fallback = resolveHomebrewSqlitePath(exists);
		if (fallback === null || fallback.path === choice.path) {
			return {
				choice: null,
				attempt: choice.path,
				warning: `Failed to activate custom SQLite at ${choice.path}: ${msg}. ${explainSqliteSetup(agentsDir)}`,
			};
		}

		try {
			set(fallback.path);
			console.warn(`[db-accessor] workspace SQLite at ${choice.path} failed (${msg}), fell back to ${fallback.path}`);
			return {
				choice: fallback,
				attempt: fallback.path,
				warning: null,
			};
		} catch (err) {
			const next = err instanceof Error ? err.message : String(err);
			return {
				choice: null,
				attempt: fallback.path,
				warning: `Failed to activate workspace SQLite at ${choice.path}: ${msg}. Fallback Homebrew SQLite at ${fallback.path} also failed: ${next}. ${explainSqliteSetup(agentsDir)}`,
			};
		}
	}
}

function configureCustomSqlite(agentsDir?: string): void {
	const cfg = resolveSqliteRuntimeConfig({ agentsDir });
	sqliteChoice = cfg.choice;
	sqliteAttempt = cfg.attempt;
	sqliteWarning = cfg.warning;
	if (cfg.warning !== null) {
		console.warn(`[db-accessor] ${cfg.warning}`);
	}
}

function loadVecExtension(db: Database): void {
	if (vecExtPath === undefined) {
		vecExtPath = findSqliteVecExtension();
		if (!vecExtPath) {
			vecLoaded = false;
			vecLoadError = "sqlite-vec extension not found";
			console.warn("[db-accessor] sqlite-vec extension not found — vector search disabled");
		}
	}
	if (vecExtPath) {
		try {
			db.loadExtension(vecExtPath);
			vecLoaded = true;
			vecLoadError = null;
		} catch (e) {
			vecLoaded = false;
			vecLoadError = e instanceof Error ? e.message : String(e);
			console.warn("[db-accessor] loadExtension failed:", vecLoadError);
		}
	}
}

export function getVectorRuntimeStatus(): VectorRuntimeStatus {
	return {
		sqlite: sqliteChoice,
		sqliteAttempt,
		sqliteWarning,
		extensionPath: vecExtPath ?? null,
		extensionLoaded: vecLoaded,
		extensionLoadError: vecLoadError,
	};
}

export function isVectorRuntimeUsable(): boolean {
	return vecLoaded && vecLoadError === null;
}

const MAX_MIGRATION_BACKUPS = 5;

/**
 * Back up the database file before running migrations.
 * Flushes WAL first, then copies the main file. Prunes old
 * backups beyond MAX_MIGRATION_BACKUPS (oldest by mtime).
 */
function backupBeforeMigration(db: Database, dbPath: string, schemaVersion: number): void {
	// Flush WAL so the .db file is self-contained
	try {
		db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
	} catch {
		// Non-fatal — backup still useful even with WAL
	}

	const timestamp = Date.now();
	const backupDest = `${dbPath}.bak-v${schemaVersion}-${timestamp}`;
	copyFileSync(dbPath, backupDest);
	console.log(`[db-accessor] Pre-migration backup: ${backupDest}`);

	// Prune old backups
	const dir = dirname(dbPath);
	const base = basename(dbPath);
	const backups = readdirSync(dir)
		.filter((f) => f.startsWith(`${base}.bak-v`))
		.map((f) => ({ name: f, mtime: statSync(join(dir, f)).mtimeMs }))
		.sort((a, b) => b.mtime - a.mtime);

	for (const old of backups.slice(MAX_MIGRATION_BACKUPS)) {
		try {
			unlinkSync(join(dir, old.name));
			console.log(`[db-accessor] Pruned old backup: ${old.name}`);
		} catch {
			// Best effort
		}
	}
}

/**
 * Initialise the singleton accessor. Must be called once at daemon startup
 * before any route handler runs. Ensures the memory directory exists, opens
 * the write connection, sets pragmas, and runs pending migrations.
 */
export function initDbAccessor(path: string, opts?: { readonly agentsDir?: string }): void {
	if (accessor) {
		throw new Error("DbAccessor already initialised");
	}

	const dir = dirname(path);
	if (!existsSync(dir)) {
		mkdirSync(dir, { recursive: true });
	}

	dbPath = path;

	configureCustomSqlite(opts?.agentsDir);

	const writeConn = new Database(path);
	configurePragmas(writeConn);
	loadVecExtension(writeConn);

	// Back up before migrations if there are pending changes
	if (existsSync(path) && hasPendingMigrations(toMigrationDb(writeConn))) {
		const row = writeConn.prepare("SELECT MAX(version) as version FROM schema_migrations").get() as
			| { version: number }
			| undefined;
		const currentSchemaVersion = row && typeof row.version === "number" ? row.version : 0;
		backupBeforeMigration(writeConn, path, currentSchemaVersion);
	}

	// Run schema migrations — this is the sole schema authority.
	// Failures here are fatal: the daemon must not start on bad schema.
	runMigrations(toMigrationDb(writeConn));

	// Ensure FTS5 virtual table exists — may be missing on upgrades from
	// older installs where the table was dropped or never created.
	ensureFtsTable(writeConn);

	// Ensure vec_embeddings virtual table exists with correct schema.
	// Older tables may lack the TEXT id column needed to join with embeddings.
	if (vecExtPath) {
		try {
			ensureVecTable(writeConn);
		} catch (err) {
			// ensureVecTable failure means the vec0 runtime extension is not
			// usable — disable vector search for this process lifetime.
			vecLoaded = false;
			vecLoadError = err instanceof Error ? err.message : String(err);
			console.warn("[db-accessor] vec0 unavailable after extension load:", vecLoadError);
		}
		if (vecLoaded) {
			try {
				backfillVecEmbeddings(writeConn);
			} catch (err) {
				// Backfill failure is a data issue (e.g. bad row, schema mismatch),
				// not a runtime unavailability — vector search stays enabled.
				console.warn("[db-accessor] vec backfill partial:", err instanceof Error ? err.message : String(err));
			}
		}
	}

	accessor = createAccessor(writeConn);
}

export function initDbAccessorLite(dbPathParam: string, vecExtensionPath: string): void {
	if (accessor !== null) throw new Error("DbAccessor already initialised");

	dbPath = dbPathParam;
	vecExtPath = vecExtensionPath;

	const writeConn = new Database(dbPathParam);
	configurePragmas(writeConn);

	if (vecExtensionPath) {
		try {
			writeConn.loadExtension(vecExtensionPath);
			vecLoaded = true;
			vecLoadError = null;
		} catch (e) {
			vecLoaded = false;
			vecLoadError = e instanceof Error ? e.message : String(e);
		}
	} else {
		vecLoaded = false;
		vecLoadError = "no extension path provided";
	}

	accessor = createAccessor(writeConn);
}

// ---------------------------------------------------------------------------
// FTS table creation (self-healing for upgrades)
// ---------------------------------------------------------------------------

/**
 * Ensure the memories_fts virtual table exists with the canonical
 * tokenizer. Older installs can carry a legacy porter-tokenized table,
 * which silently harms lexical recall quality for conversational cues.
 */
export function ensureFtsTable(db: Database): void {
	const sql = readMemoriesFtsSql(toFtsSchemaQueryDb(db));

	if (sql === null) {
		console.log("[db-accessor] memories_fts missing — recreating FTS5 table");
		createMemoriesFts(db);
		const backfilled = db.prepare("SELECT COUNT(*) as n FROM memories").get() as { n: number };
		if (backfilled.n > 0) {
			db.exec("INSERT INTO memories_fts(rowid, content) SELECT rowid, content FROM memories");
			console.log(`[db-accessor] Backfilled ${backfilled.n} rows into memories_fts`);
		}
		return;
	}

	if (!memoriesFtsNeedsTokenizerRepair(sql)) return;

	console.log("[db-accessor] memories_fts tokenizer drift detected — recreating FTS5 table");
	recreateMemoriesFts(db);
}

// ---------------------------------------------------------------------------
// Vec table creation + backfill
// ---------------------------------------------------------------------------

function ensureVecTable(db: Database): void {
	// Check if vec_embeddings exists and has the correct schema (TEXT id).
	// If it exists without an id column, drop and recreate.
	const existing = db.prepare("SELECT sql FROM sqlite_master WHERE name = 'vec_embeddings' AND type = 'table'").get() as
		| { sql: string }
		| undefined;

	if (existing) {
		if (existing.sql.includes("id TEXT")) return;
		// Old schema without id — drop it
		db.exec("DROP TABLE vec_embeddings");
	}

	// Detect actual embedding dimensions from existing data
	const dimRow = db.prepare("SELECT dimensions FROM embeddings LIMIT 1").get() as { dimensions: number } | undefined;
	const dims = dimRow?.dimensions ?? DEFAULT_EMBEDDING_DIMENSIONS;

	db.exec(`
		CREATE VIRTUAL TABLE vec_embeddings USING vec0(
			id TEXT PRIMARY KEY,
			embedding FLOAT[${dims}] distance_metric=cosine
		);
	`);
}

function backfillVecEmbeddings(db: Database): void {
	// Directly query for missing rows instead of comparing counts.
	// Count comparison is racy — a row can exist in embeddings but not
	// vec_embeddings even when counts match (e.g. after a crash mid-sync).
	const rows = db
		.prepare(
			`SELECT e.id, e.vector FROM embeddings e
			 LEFT JOIN vec_embeddings v ON v.id = e.id
			 WHERE v.id IS NULL`,
		)
		.all() as Array<{ id: string; vector: Buffer }>;

	if (rows.length === 0) return;

	const insert = db.prepare("INSERT OR REPLACE INTO vec_embeddings (id, embedding) VALUES (?, ?)");

	let migrated = 0;
	try {
		db.exec("BEGIN");
		for (const row of rows) {
			try {
				const vec = new Float32Array(
					row.vector.buffer.slice(row.vector.byteOffset, row.vector.byteOffset + row.vector.byteLength),
				);
				insert.run(row.id, vec);
				migrated++;
			} catch {
				// Skip malformed rows
			}
		}
		db.exec("COMMIT");
	} catch (e) {
		try {
			db.exec("ROLLBACK");
		} catch {
			// Rollback failed — transaction already closed or rolled back
		}
		throw e;
	}

	if (migrated > 0) {
		// eslint-disable-next-line no-console
		console.log(`[db-accessor] Backfilled ${migrated}/${rows.length} missing embeddings into vec_embeddings`);
	}

	// Clean orphaned vec_embeddings rows (phantom IDs from prior sync bugs)
	try {
		const orphanRow = db
			.prepare(
				`SELECT COUNT(*) AS n FROM vec_embeddings v
				 LEFT JOIN embeddings e ON e.id = v.id
				 WHERE e.id IS NULL`,
			)
			.get() as { n: number } | undefined;
		const orphanCount = orphanRow?.n ?? 0;
		if (orphanCount > 0) {
			db.prepare("DELETE FROM vec_embeddings WHERE id NOT IN (SELECT id FROM embeddings)").run();
			// eslint-disable-next-line no-console
			console.log(`[db-accessor] Cleaned ${orphanCount} orphaned vec_embeddings rows`);
		}
	} catch {
		// vec_embeddings may not exist — non-fatal
	}
}

// ---------------------------------------------------------------------------
// Accessor factory
// ---------------------------------------------------------------------------

const READ_POOL_SIZE = 4;
const MAX_READ_CONNECTIONS = 16;

function createAccessor(writeConn: Database): DbAccessor {
	let closed = false;

	// Small pool of reusable read connections. Recall does 3 reads per
	// request so opening/closing every time adds measurable overhead.
	const readPool: Database[] = [];
	const readInUse = new Set<Database>();

	function acquireRead(): Database {
		if (dbPath === null) throw new Error("DbAccessor not initialised");
		const pooled = readPool.pop();
		if (pooled) {
			readInUse.add(pooled);
			return pooled;
		}
		if (readInUse.size >= MAX_READ_CONNECTIONS) {
			console.warn(`[db] Read connection limit exceeded (${readInUse.size}/${MAX_READ_CONNECTIONS})`);
			throw new Error("Read connection limit exceeded");
		}
		const conn = new Database(dbPath, { readonly: true });
		conn.exec("PRAGMA busy_timeout = 5000");
		loadVecExtension(conn);
		readInUse.add(conn);
		return conn;
	}

	function releaseRead(conn: Database): void {
		readInUse.delete(conn);
		if (readPool.length < READ_POOL_SIZE) {
			readPool.push(conn);
		} else {
			conn.close();
		}
	}

	return {
		withWriteTx<T>(fn: (db: WriteDb) => T): T {
			if (closed) throw new Error("DbAccessor is closed");
			writeConn.exec("BEGIN IMMEDIATE");
			try {
				const result = fn(writeConn);
				writeConn.exec("COMMIT");
				return result;
			} catch (err) {
				writeConn.exec("ROLLBACK");
				throw err;
			}
		},

		withReadDb<T>(fn: (db: ReadDb) => T): T {
			if (closed) throw new Error("DbAccessor is closed");
			const conn = acquireRead();
			try {
				return fn(conn);
			} finally {
				releaseRead(conn);
			}
		},

		close(): void {
			if (closed) return;
			closed = true;
			writeConn.close();
			for (const conn of readPool) conn.close();
			for (const conn of readInUse) conn.close();
			readPool.length = 0;
			readInUse.clear();
		},
	};
}

// ---------------------------------------------------------------------------
// Public helpers
// ---------------------------------------------------------------------------

/** Get the initialised accessor. Throws if `initDbAccessor` hasn't been called. */
export function getDbAccessor(): DbAccessor {
	if (!accessor) {
		throw new Error("DbAccessor not initialised — call initDbAccessor() first");
	}
	return accessor;
}

export function hasDbAccessor(): boolean {
	return accessor !== null;
}

/** Tear down the singleton. Safe to call even if never initialised. */
export function closeDbAccessor(): void {
	if (accessor) {
		accessor.close();
		accessor = null;
		dbPath = null;
	}
	sqliteChoice = null;
	sqliteAttempt = null;
	sqliteWarning = null;
	vecLoaded = false;
	vecLoadError = null;
	vecExtPath = undefined;
}

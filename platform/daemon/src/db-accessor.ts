/**
 * Singleton DB accessor for the Signet daemon.
 *
 * Holds a single write connection for the daemon's lifetime and provides
 * transaction wrappers for safe concurrent access. Read connections are
 * opened on demand (SQLite WAL mode allows concurrent readers).
 */

import {
	copyFileSync,
	existsSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	statSync,
	statfsSync,
	unlinkSync,
} from "node:fs";
import { copyFile as copyFileAsync, unlink as unlinkAsync } from "node:fs/promises";
import { createRequire } from "node:module";
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
	resolveSqliteJournalConfig,
	runMigrations,
} from "@signet/core";
import { convertToIncrementalVacuum, DbSpacePreflightError, ensureVacuumConversionState } from "./db-vacuum";
import type { DbSpaceMetrics } from "./db-vacuum";

import { ensureEmbeddingIndexState } from "./embedding-index-state";
import { loadMemoryConfig } from "./memory-config";
import { observeDbLatency } from "./runtime-pressure";

export { DbSpacePreflightError };

const isBun = typeof (globalThis as Record<string, unknown>).Bun !== "undefined";
const require = createRequire(import.meta.url);

export interface SqliteRunResult {
	readonly changes: number;
	readonly lastInsertRowid?: number | bigint;
}

export type SqliteStatement = {
	run(...params: unknown[]): SqliteRunResult;
	get(...params: unknown[]): Record<string, unknown> | undefined;
	all<Row = unknown>(...params: unknown[]): Row[];
};

export interface TypedSqliteStatement<Row extends object> {
	run(...params: unknown[]): SqliteRunResult;
	get(...params: unknown[]): Row | undefined;
	all(...params: unknown[]): Row[];
}

export function prepareTypedStatement<Row extends object>(
	db: {
		prepare(sql: string): {
			run(...params: unknown[]): unknown;
			get(...params: unknown[]): unknown;
			all(...params: unknown[]): unknown[];
		};
	},
	sql: string,
): TypedSqliteStatement<Row> {
	return db.prepare(sql) as unknown as TypedSqliteStatement<Row>;
}

type SqliteDatabase = {
	prepare(sql: string): SqliteStatement;
	exec(sql: string): void;
	close(): void;
	loadExtension?(path: string): void;
};

let Database: new (path: string, opts?: Record<string, unknown>) => SqliteDatabase;

if (isBun) {
	// eslint-disable-next-line @typescript-eslint/no-require-imports
	const mod = require("bun:sqlite");
	Database = mod.Database;
} else {
	// eslint-disable-next-line @typescript-eslint/no-require-imports
	Database = require("better-sqlite3");
}

type SQLQueryBindings = unknown;

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
// Public interfaces — thin wrappers over the Database surface
// ---------------------------------------------------------------------------

export interface WriteDb {
	exec(sql: string): void;
	prepare(sql: string): SqliteStatement;
}

export interface ReadDb {
	prepare(sql: string): SqliteStatement;
}

export interface WritePressure {
	/** Number of async write operations waiting for admission. */
	readonly queued: number;
	/** Maximum number of async write operations waiting for admission. */
	readonly maxQueue: number;
	/** Age of the oldest queued operation, or null when the queue is empty. */
	readonly oldestWaitMs: number | null;
	/** Duration of the most recently completed write operation. */
	readonly lastDurationMs: number | null;
}

export class DbWriteQueueFullError extends Error {
	readonly code = "DB_WRITE_QUEUE_FULL" as const;

	constructor() {
		super("Database write queue is full; retry after write pressure clears");
		this.name = "DbWriteQueueFullError";
	}
}

/**
 * Canonical contract for daemon code that can cross an event-loop boundary.
 *
 * New production code must use these async primitives. They are required here
 * rather than optional so an accessor implementation cannot silently omit the
 * async boundary and force callers back onto synchronous SQLite.
 */
export interface AsyncDbAccessor {
	/** Admit a write transaction through the bounded async writer queue. */
	withWriteTxAsync<T>(fn: (db: WriteDb) => T): Promise<T>;

	/** Admit a WAL checkpoint through the bounded async writer queue. */
	checkpointWalAsync?(): Promise<void>;

	/** Admit incremental vacuum through the bounded async writer queue. */
	incrementalVacuumAsync?(): Promise<number>;

	/** Admit the one-time legacy auto_vacuum conversion through the bounded
	 *  async writer queue. */
	vacuumConversionAsync?(): Promise<boolean>;

	/** Return bounded local diagnostics for the writer admission path. */
	getWritePressure?(): WritePressure;

	/** Async variant of withReadDb. The connection stays checked out of the
	 *  read pool for the whole `fn`, including across event-loop yields, so
	 *  long readers can breathe without starving other readers (the pool
	 *  grows on demand up to the connection limit). */
	withReadDbAsync<T>(fn: (db: ReadDb) => Promise<T>): Promise<T>;

	/** Close all held connections. Safe to call multiple times. */
	close(): void;
}

/**
 * Production DB contract. Synchronous transaction and read methods are
 * intentionally absent. Legacy callers are marked at their call sites with a
 * tracked `@ts-expect-error LEGACY_SYNC_DB_ACCESS` until the A3 migration wave
 * removes them.
 */
export interface DbAccessor extends AsyncDbAccessor {}

/**
 * Runtime-only implementation shape. This is not exported, so production
 * callers cannot obtain synchronous methods through the public accessor type.
 * The test/bootstrap-only `db-accessor-sync.ts` module provides the explicit
 * compatibility surface for code that must exercise these legacy methods.
 */
interface SyncDbAccessorRuntime {
	withWriteTx<T>(fn: (db: WriteDb) => T): T;
	withReadDb<T>(fn: (db: ReadDb) => T): T;
	checkpointWal(): void;
	incrementalVacuum(): number;
	vacuumConversion(): boolean;
}

type RuntimeDbAccessor = DbAccessor & SyncDbAccessorRuntime;

// ---------------------------------------------------------------------------
// Singleton state
// ---------------------------------------------------------------------------

let accessor: RuntimeDbAccessor | null = null;
let dbPath: string | null = null;
let sqliteChoice: SqliteChoice | null = null;
let sqliteAttempt: string | null = null;
let sqliteWarning: string | null = null;
let vecLoaded = false;
let vecLoadError: string | null = null;

// ---------------------------------------------------------------------------
// Initialisation
// ---------------------------------------------------------------------------

function configurePragmas(db: SqliteDatabase, path: string): void {
	// Set auto_vacuum = INCREMENTAL before any tables are created. This only
	// affects fresh databases; existing databases are converted by the
	// post-ready vacuum worker after finishDbAccessorInit (#1139, #1493).
	db.exec("PRAGMA auto_vacuum = INCREMENTAL");
	const journal = resolveSqliteJournalConfig({ directory: dirname(path) });
	db.exec(`PRAGMA journal_mode = ${journal.journalMode}`);
	db.exec("PRAGMA busy_timeout = 5000");
	db.exec(`PRAGMA synchronous = ${journal.networkFilesystem ? "FULL" : "NORMAL"}`);
	db.exec("PRAGMA temp_store = MEMORY");
}

function toRecordOrUndefined(row: unknown): Record<string, unknown> | undefined {
	if (typeof row !== "object" || row === null) return undefined;
	return row as Record<string, unknown>;
}

function toMigrationDb(db: SqliteDatabase): {
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
				run(...args: SQLQueryBindings[]): void {
					stmt.run(...args);
				},
				get(...args: SQLQueryBindings[]): Record<string, unknown> | undefined {
					return toRecordOrUndefined(stmt.get(...args));
				},
				all(...args: SQLQueryBindings[]): Record<string, unknown>[] {
					const rows = stmt.all(...args);
					return rows
						.map((row) => toRecordOrUndefined(row))
						.filter((row): row is Record<string, unknown> => row !== undefined);
				},
			};
		},
	};
}

export function toFtsSchemaQueryDb(db: { prepare(sql: string): SqliteStatement }): {
	prepare(sql: string): {
		get(...args: SQLQueryBindings[]): Record<string, unknown> | undefined;
	};
} {
	return {
		prepare(sql: string) {
			const stmt = db.prepare(sql);
			return {
				get(...args: SQLQueryBindings[]): Record<string, unknown> | undefined {
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
	const set =
		opts?.set ??
		((path: string) => {
			const sqliteCtor = Database as unknown as { setCustomSQLite?: (p: string) => void };
			if (typeof sqliteCtor.setCustomSQLite === "function") {
				sqliteCtor.setCustomSQLite(path);
			}
		});
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

function loadVecExtension(db: SqliteDatabase): void {
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
			if (typeof db.loadExtension !== "function") throw new Error("SQLite loadExtension API unavailable");
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

const MAX_MIGRATION_BACKUPS = 1;
// Some runner and edge filesystems report zero available blocks even though a
// small write still succeeds. Probe those small databases instead of treating
// the statfs result as definitive, while keeping large databases fail-closed.
const MAX_ZERO_FREE_SPACE_PROBE_BYTES = 1024 * 1024;

interface MigrationBackupDeps {
	readonly copyFileSync: (source: string, destination: string) => void;
	readonly readdirSync: (path: string) => string[];
	readonly statSync: (path: string) => { readonly mtimeMs: number; readonly size?: number };
	readonly statfsSync?: (path: string) => { readonly bavail: number; readonly bsize: number };
	readonly unlinkSync: (path: string) => void;
	readonly now: () => number;
	readonly log: (message: string) => void;
}

const migrationBackupDeps: MigrationBackupDeps = {
	copyFileSync,
	readdirSync,
	statSync,
	statfsSync,
	unlinkSync,
	now: Date.now,
	log: console.log,
};

function readErrorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

function isMissingPathError(err: unknown): boolean {
	return err instanceof Error && "code" in err && (err.code === "ENOENT" || err.code === "ENOTDIR");
}

function migrationBackups(
	dbPath: string,
	deps: MigrationBackupDeps,
): Array<{ readonly name: string; readonly mtime: number; readonly size: number }> {
	const dir = dirname(dbPath);
	const base = basename(dbPath);
	return deps
		.readdirSync(dir)
		.filter((f) => f.startsWith(`${base}.bak-v`))
		.flatMap((f) => {
			try {
				const stat = deps.statSync(join(dir, f));
				return [{ name: f, mtime: stat.mtimeMs, size: stat.size ?? 0 }];
			} catch (err) {
				if (isMissingPathError(err)) return [];
				throw err;
			}
		})
		.sort((a, b) => b.mtime - a.mtime);
}

function pruneMigrationBackups(dbPath: string, keep: number, deps: MigrationBackupDeps): void {
	const dir = dirname(dbPath);
	for (const old of migrationBackups(dbPath, deps).slice(Math.max(0, keep))) {
		try {
			deps.unlinkSync(join(dir, old.name));
			deps.log(`[db-accessor] Pruned old backup: ${old.name}`);
		} catch {
			// Best effort.
		}
	}
}

function availableBytes(path: string, deps: MigrationBackupDeps): number | null {
	if (!deps.statfsSync) return null;
	try {
		const stat = deps.statfsSync(path);
		return stat.bavail * stat.bsize;
	} catch {
		return null;
	}
}

function fileSize(path: string, deps: MigrationBackupDeps): number | null {
	try {
		const size = deps.statSync(path).size;
		return typeof size === "number" && Number.isFinite(size) && size >= 0 ? size : null;
	} catch {
		return null;
	}
}

function isDbFullError(err: unknown): boolean {
	if (!(err instanceof Error)) return false;
	const code = "code" in err ? err.code : undefined;
	return (
		code === "ENOSPC" ||
		code === "SQLITE_FULL" ||
		err.message.includes("ENOSPC") ||
		err.message.includes("SQLITE_FULL") ||
		err.message.toLowerCase().includes("no space left on device") ||
		err.message.toLowerCase().includes("database or disk is full")
	);
}

function preflightMigrationBackupSpace(dbPath: string, deps: MigrationBackupDeps): DbSpaceMetrics | null {
	const dbBytes = fileSize(dbPath, deps);
	const freeBytes = availableBytes(dirname(dbPath), deps);
	if (dbBytes === null || freeBytes === null) return null;
	const metrics = { dbBytes, freeBytes, requiredBytes: dbBytes };
	if (freeBytes === 0 && dbBytes <= MAX_ZERO_FREE_SPACE_PROBE_BYTES) {
		const probeDest = `${dbPath}.space-probe-${deps.now()}`;
		try {
			// A zero statfs reading is not reliable on every runner or edge
			// filesystem. Copy the actual database before failing closed so this
			// exception is allowed only when the required backup write succeeds.
			deps.copyFileSync(dbPath, probeDest);
			return metrics;
		} catch (err) {
			throw new DbSpacePreflightError("migration_backup", metrics, err);
		} finally {
			try {
				deps.unlinkSync(probeDest);
			} catch {
				// Best effort cleanup of the preflight probe.
			}
		}
	}
	if (freeBytes < dbBytes) throw new DbSpacePreflightError("migration_backup", metrics);
	return metrics;
}

function migrationBackupSpaceError(
	dbPath: string,
	metrics: DbSpaceMetrics,
	deps: MigrationBackupDeps,
	err: unknown,
): DbSpacePreflightError {
	const freeBytes = availableBytes(dirname(dbPath), deps) ?? metrics.freeBytes;
	return new DbSpacePreflightError("migration_backup", { ...metrics, freeBytes }, err);
}

/**
 * Back up the database file before running migrations.
 * Flushes WAL first, then copies the main file. Prunes old
 * backups after the space preflight, so a failed preflight keeps existing
 * recovery backups intact.
 */
export function backupBeforeMigration(
	db: { exec(sql: string): unknown },
	dbPath: string,
	schemaVersion: number,
	deps: MigrationBackupDeps = migrationBackupDeps,
): string {
	const space = prepareMigrationBackup(db, dbPath, deps);
	const backupDest = migrationBackupDestination(dbPath, schemaVersion, deps);
	try {
		deps.copyFileSync(dbPath, backupDest);
	} catch (err) {
		cleanupPartialMigrationBackup(backupDest, deps);
		if (isDbFullError(err) && space !== null) {
			throw migrationBackupSpaceError(dbPath, space, deps, err);
		}
		throw migrationBackupError(backupDest, err);
	}
	finishMigrationBackup(dbPath, backupDest, deps);
	return backupDest;
}

export async function backupBeforeMigrationAsync(
	db: { exec(sql: string): unknown },
	dbPath: string,
	schemaVersion: number,
	deps: MigrationBackupDeps = migrationBackupDeps,
): Promise<string> {
	const space = prepareMigrationBackup(db, dbPath, deps);
	const backupDest = migrationBackupDestination(dbPath, schemaVersion, deps);
	try {
		if (deps === migrationBackupDeps) {
			await copyFileAsync(dbPath, backupDest);
		} else {
			deps.copyFileSync(dbPath, backupDest);
		}
	} catch (err) {
		await cleanupPartialMigrationBackupAsync(backupDest, deps);
		if (isDbFullError(err) && space !== null) {
			throw migrationBackupSpaceError(dbPath, space, deps, err);
		}
		throw migrationBackupError(backupDest, err);
	}
	finishMigrationBackup(dbPath, backupDest, deps);
	return backupDest;
}

function prepareMigrationBackup(
	db: { exec(sql: string): unknown },
	dbPath: string,
	deps: MigrationBackupDeps,
): DbSpaceMetrics | null {
	// Flush WAL so the .db file is self-contained before measuring the copy.
	try {
		db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
	} catch {
		// Non-fatal — backup still useful even with WAL.
	}

	// Check space before pruning or copying. A failed preflight must not remove
	// the only retained backup that the operator may need for recovery.
	const space = preflightMigrationBackupSpace(dbPath, deps);

	// Make room for the incoming backup only after the preflight has passed.
	pruneMigrationBackups(dbPath, MAX_MIGRATION_BACKUPS, deps);
	return space;
}

function migrationBackupDestination(dbPath: string, schemaVersion: number, deps: MigrationBackupDeps): string {
	return `${dbPath}.bak-v${schemaVersion}-${deps.now()}`;
}

function cleanupPartialMigrationBackup(backupDest: string, deps: MigrationBackupDeps): void {
	try {
		deps.unlinkSync(backupDest);
	} catch {
		// Best effort cleanup for partial copy files.
	}
}

async function cleanupPartialMigrationBackupAsync(backupDest: string, deps: MigrationBackupDeps): Promise<void> {
	try {
		if (deps === migrationBackupDeps) await unlinkAsync(backupDest);
		else deps.unlinkSync(backupDest);
	} catch {
		// Best effort cleanup for partial copy files.
	}
}

function migrationBackupError(backupDest: string, err: unknown): Error {
	return new Error(
		`Failed to create pre-migration backup at ${backupDest}. ` +
			`Free disk space and retry; the database was not migrated. Cause: ${readErrorMessage(err)}`,
	);
}

function finishMigrationBackup(dbPath: string, backupDest: string, deps: MigrationBackupDeps): void {
	deps.log(`[db-accessor] Pre-migration backup: ${backupDest}`);
	// Final retention pass in case another process wrote backups concurrently.
	pruneMigrationBackups(dbPath, MAX_MIGRATION_BACKUPS, deps);
}

function verifyPostMigrationIntegrity(writeConn: SqliteDatabase): void {
	const rows = writeConn.prepare("PRAGMA integrity_check").all() as ReadonlyArray<Record<string, unknown>>;
	const messages = rows.map((row) => String(row.integrity_check ?? ""));
	if (messages.length === 1 && messages[0] === "ok") return;
	throw new Error(`Post-migration integrity check failed: ${messages.join("; ") || "no result"}`);
}

function cleanupMigrationBackupAfterSuccess(backupDest: string, deps: MigrationBackupDeps): void {
	try {
		deps.unlinkSync(backupDest);
		deps.log(`[db-accessor] Removed verified migration backup: ${backupDest}`);
	} catch (err) {
		if (!isMissingPathError(err)) {
			deps.log(`[db-accessor] Retained verified migration backup after cleanup failure: ${backupDest}`);
		}
	}
}

/**
 * Initialise the singleton accessor. Must be called once at daemon startup
 * before any route handler runs. Ensures the memory directory exists, opens
 * the write connection, sets pragmas, and runs pending migrations.
 */
export function initDbAccessor(path: string, opts?: { readonly agentsDir?: string }): void {
	const writeConn = openDbAccessorConnection(path, opts);
	const migrationBackup = backupBeforePendingMigrations(writeConn, path);
	finishDbAccessorInit(writeConn, opts, migrationBackup);
}

export async function initDbAccessorAsync(path: string, opts?: { readonly agentsDir?: string }): Promise<void> {
	const writeConn = openDbAccessorConnection(path, opts);
	const migrationBackup = await backupBeforePendingMigrationsAsync(writeConn, path);
	finishDbAccessorInit(writeConn, opts, migrationBackup);
}

function openDbAccessorConnection(path: string, opts?: { readonly agentsDir?: string }): SqliteDatabase {
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
	configurePragmas(writeConn, path);
	loadVecExtension(writeConn);
	return writeConn;
}

function readCurrentSchemaVersion(writeConn: SqliteDatabase): number {
	const row = writeConn.prepare("SELECT MAX(version) as version FROM schema_migrations").get() as
		| { version: number }
		| undefined;
	return row && typeof row.version === "number" ? row.version : 0;
}

function backupBeforePendingMigrations(writeConn: SqliteDatabase, path: string): string | null {
	if (existsSync(path) && hasPendingMigrations(toMigrationDb(writeConn))) {
		return backupBeforeMigration(writeConn, path, readCurrentSchemaVersion(writeConn));
	}
	return null;
}

async function backupBeforePendingMigrationsAsync(writeConn: SqliteDatabase, path: string): Promise<string | null> {
	if (existsSync(path) && hasPendingMigrations(toMigrationDb(writeConn))) {
		return await backupBeforeMigrationAsync(writeConn, path, readCurrentSchemaVersion(writeConn));
	}
	return null;
}

function finishDbAccessorInit(
	writeConn: SqliteDatabase,
	opts?: { readonly agentsDir?: string },
	migrationBackup?: string | null,
): void {
	// Run schema migrations — this is the sole schema authority.
	// Failures here are fatal: the daemon must not start on bad schema.
	runMigrations(toMigrationDb(writeConn));
	if (migrationBackup !== null && migrationBackup !== undefined) {
		// Keep the rollback point until migration and a full integrity check both
		// succeed. Any thrown error leaves it available for recovery.
		verifyPostMigrationIntegrity(writeConn);
		cleanupMigrationBackupAfterSuccess(migrationBackup, migrationBackupDeps);
	}

	// Record one-time conversion state only after migrations have succeeded.
	// The conversion itself is deliberately post-ready because VACUUM can
	// block the event loop for minutes on a large legacy database (#1493).
	ensureVacuumConversionState(toMigrationDb(writeConn));

	// Ensure FTS5 virtual table exists — may be missing on upgrades from
	// older installs where the table was dropped or never created.
	ensureFtsTable(writeConn);
	const configuredEmbedding = loadMemoryConfig(opts?.agentsDir ?? resolveSqliteAgentsDir()).embedding;
	const legacyVecSql = writeConn
		.prepare("SELECT sql FROM sqlite_master WHERE name = 'vec_embeddings' AND type = 'table'")
		.get() as { sql?: string } | undefined;
	const legacyDimensions = readVecEmbeddingDimensions(legacyVecSql?.sql);
	const embeddingIndexState = ensureEmbeddingIndexState(
		writeConn,
		legacyDimensions === null ? configuredEmbedding : { ...configuredEmbedding, dimensions: legacyDimensions },
	);

	// Ensure vec_embeddings virtual table exists with the configured dimensions.
	// Older tables may lack the TEXT id column or carry stale FLOAT[N] dims.
	if (vecExtPath) {
		const vecDimensions = embeddingIndexState.active.dimensions;
		try {
			ensureVecTable(writeConn, vecDimensions);
		} catch (err) {
			// ensureVecTable failure means the vec0 runtime extension is not
			// usable — disable vector search for this process lifetime.
			vecLoaded = false;
			vecLoadError = err instanceof Error ? err.message : String(err);
			console.warn("[db-accessor] vec0 unavailable after extension load:", vecLoadError);
		}
		if (vecLoaded) {
			try {
				backfillVecEmbeddings(writeConn, vecDimensions);
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
	configurePragmas(writeConn, dbPathParam);

	if (vecExtensionPath) {
		try {
			if (typeof writeConn.loadExtension !== "function") throw new Error("SQLite loadExtension API unavailable");
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
export function ensureFtsTable(db: SqliteDatabase): void {
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

function resolveVecEmbeddingDimensions(agentsDir?: string): number {
	try {
		const dimensions = loadMemoryConfig(agentsDir ?? resolveSqliteAgentsDir()).embedding.dimensions;
		if (Number.isInteger(dimensions) && dimensions > 0) return dimensions;
	} catch (err) {
		console.warn(
			"[db-accessor] Failed to read embedding dimensions from config; using default:",
			err instanceof Error ? err.message : String(err),
		);
	}
	return DEFAULT_EMBEDDING_DIMENSIONS;
}

export function readVecEmbeddingDimensions(sql: string | null | undefined): number | null {
	if (!sql) return null;
	const match = /\bembedding\s+FLOAT\s*\[\s*(\d+)\s*\]/i.exec(sql);
	if (!match) return null;
	const parsed = Number.parseInt(match[1], 10);
	return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

export function vecEmbeddingsSchemaNeedsRepair(sql: string | null | undefined, expectedDimensions: number): boolean {
	if (!sql) return true;
	if (!/\bid\s+TEXT\b/i.test(sql)) return true;
	return readVecEmbeddingDimensions(sql) !== expectedDimensions;
}

function ensureVecTable(db: SqliteDatabase, expectedDimensions: number): void {
	const existing = db.prepare("SELECT sql FROM sqlite_master WHERE name = 'vec_embeddings' AND type = 'table'").get() as
		| { sql: string }
		| undefined;

	if (existing) {
		if (!vecEmbeddingsSchemaNeedsRepair(existing.sql, expectedDimensions)) return;
		if (/\bid\s+TEXT\b/i.test(existing.sql)) {
			console.warn(`[db-accessor] vec_embeddings schema drift detected; recreating with FLOAT[${expectedDimensions}]`);
		}
		db.exec("DROP TABLE vec_embeddings");
	}

	db.exec(`
		CREATE VIRTUAL TABLE vec_embeddings USING vec0(
			id TEXT PRIMARY KEY,
			embedding FLOAT[${expectedDimensions}] distance_metric=cosine
		);
	`);
}

function vecRowidsTableAvailable(db: SqliteDatabase): boolean {
	try {
		const row = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'vec_embeddings_rowids'").get();
		return row !== undefined;
	} catch {
		return false;
	}
}

function missingVecEmbeddingsRows(
	db: SqliteDatabase,
	expectedDimensions: number,
): Array<{ id: string; vector: Buffer }> {
	// sqlite-vec's virtual table is expensive for anti-joins: on a 43k-row local
	// DB, `LEFT JOIN vec_embeddings` costs ~6.5s even when no rows are missing.
	// The backing rowid table is a normal SQLite table with a UNIQUE id index and
	// answers the same existence question in tens of milliseconds. Keep the
	// virtual-table fallback for non-sqlite-vec test doubles and unexpected
	// future layouts.
	const targetTable = vecRowidsTableAvailable(db) ? "vec_embeddings_rowids" : "vec_embeddings";
	return db
		.prepare(
			`SELECT e.id, e.vector FROM embeddings e
			 LEFT JOIN ${targetTable} v ON v.id = e.id
			 WHERE v.id IS NULL AND e.dimensions = ?`,
		)
		.all(expectedDimensions) as Array<{ id: string; vector: Buffer }>;
}

function countSkippedVecEmbeddingsRows(db: SqliteDatabase, expectedDimensions: number): number {
	const targetTable = vecRowidsTableAvailable(db) ? "vec_embeddings_rowids" : "vec_embeddings";
	const skippedRow = db
		.prepare(
			`SELECT COUNT(*) AS n FROM embeddings e
			 LEFT JOIN ${targetTable} v ON v.id = e.id
			 WHERE v.id IS NULL AND e.dimensions != ?`,
		)
		.get(expectedDimensions) as { n: number } | undefined;
	return skippedRow?.n ?? 0;
}

function backfillVecEmbeddings(db: SqliteDatabase, expectedDimensions: number): void {
	// Directly query for missing rows instead of comparing counts.
	// Count comparison is racy — a row can exist in embeddings but not
	// vec_embeddings even when counts match (e.g. after a crash mid-sync).
	const rows = missingVecEmbeddingsRows(db, expectedDimensions);

	const skippedCount = countSkippedVecEmbeddingsRows(db, expectedDimensions);
	if (skippedCount > 0) {
		console.warn(
			`[db-accessor] Skipped ${skippedCount} embeddings with dimensions that do not match FLOAT[${expectedDimensions}]`,
		);
	}

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
export const MAX_WRITE_QUEUE = 64;

type WriteJob<T> = {
	readonly run: () => T;
	readonly queuedAt: number;
	readonly resolve: (value: T | PromiseLike<T>) => void;
	readonly reject: (reason?: unknown) => void;
};

function yieldToEventLoop(): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, 0));
}

function createAccessor(writeConn: SqliteDatabase): RuntimeDbAccessor {
	let closed = false;
	let writeDraining = false;
	let lastWriteDurationMs: number | null = null;
	const writeQueue: WriteJob<unknown>[] = [];
	// Small pool of reusable read connections. Recall does 3 reads per
	// request so opening/closing every time adds measurable overhead.
	const readPool: SqliteDatabase[] = [];
	const readInUse = new Set<SqliteDatabase>();

	function acquireRead(): SqliteDatabase {
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

	function releaseRead(conn: SqliteDatabase): void {
		readInUse.delete(conn);
		if (readPool.length < READ_POOL_SIZE) {
			readPool.push(conn);
		} else {
			conn.close();
		}
	}

	function runWriteOperation<T>(fn: () => T): T {
		const startedAt = performance.now();
		try {
			return fn();
		} finally {
			lastWriteDurationMs = performance.now() - startedAt;
			observeDbLatency(lastWriteDurationMs);
		}
	}

	function runWriteTx<T>(fn: (db: WriteDb) => T): T {
		return runWriteOperation(() => {
			writeConn.exec("BEGIN IMMEDIATE");
			try {
				const result = fn(writeConn);
				writeConn.exec("COMMIT");
				return result;
			} catch (err) {
				writeConn.exec("ROLLBACK");
				throw err;
			}
		});
	}

	function runCheckpointWal(): void {
		runWriteOperation(() => {
			writeConn.exec("PRAGMA wal_checkpoint(TRUNCATE)");
		});
	}

	function runIncrementalVacuum(): number {
		return runWriteOperation(() => {
			writeConn.exec("PRAGMA incremental_vacuum");
			const row = writeConn.prepare("PRAGMA freelist_count").get() as { freelist_count?: number } | undefined;
			return typeof row?.freelist_count === "number" ? row.freelist_count : 0;
		});
	}

	function runVacuumConversion(): boolean {
		return runWriteOperation(() =>
			convertToIncrementalVacuum(toMigrationDb(writeConn), { dbPath: dbPath ?? undefined }),
		);
	}

	function enqueueWrite<T>(run: () => T): Promise<T> {
		if (closed) return Promise.reject(new Error("DbAccessor is closed"));
		if (writeQueue.length >= MAX_WRITE_QUEUE) return Promise.reject(new DbWriteQueueFullError());
		return new Promise<T>((resolve, reject) => {
			writeQueue.push({
				run,
				queuedAt: performance.now(),
				resolve: (value) => resolve(value as T),
				reject,
			});
			drainWriteQueue();
		});
	}

	function drainWriteQueue(): void {
		if (writeDraining) return;
		writeDraining = true;
		const next = (): void => {
			const job = writeQueue.shift();
			if (!job) {
				writeDraining = false;
				return;
			}
			if (closed) {
				job.reject(new Error("DbAccessor is closed"));
				setTimeout(next, 0);
				return;
			}
			try {
				job.resolve(job.run());
			} catch (err) {
				job.reject(err);
			}
			if (writeQueue.length > 0) {
				void yieldToEventLoop().then(next);
			} else {
				writeDraining = false;
			}
		};
		void yieldToEventLoop().then(next);
	}

	return {
		withWriteTx<T>(fn: (db: WriteDb) => T): T {
			if (closed) throw new Error("DbAccessor is closed");
			return runWriteTx(fn);
		},

		withWriteTxAsync<T>(fn: (db: WriteDb) => T): Promise<T> {
			return enqueueWrite(() => runWriteTx(fn));
		},

		checkpointWalAsync(): Promise<void> {
			return enqueueWrite(runCheckpointWal);
		},

		incrementalVacuumAsync(): Promise<number> {
			return enqueueWrite(runIncrementalVacuum);
		},

		vacuumConversionAsync(): Promise<boolean> {
			return enqueueWrite(runVacuumConversion);
		},

		checkpointWal(): void {
			if (closed) throw new Error("DbAccessor is closed");
			runCheckpointWal();
		},

		incrementalVacuum(): number {
			if (closed) throw new Error("DbAccessor is closed");
			return runIncrementalVacuum();
		},

		vacuumConversion(): boolean {
			if (closed) throw new Error("DbAccessor is closed");
			return runVacuumConversion();
		},

		getWritePressure(): WritePressure {
			const oldest = writeQueue[0];
			return {
				queued: writeQueue.length,
				maxQueue: MAX_WRITE_QUEUE,
				oldestWaitMs: oldest ? Math.max(0, performance.now() - oldest.queuedAt) : null,
				lastDurationMs: lastWriteDurationMs,
			};
		},

		withReadDb<T>(fn: (db: ReadDb) => T): T {
			if (closed) throw new Error("DbAccessor is closed");
			const startedAt = performance.now();
			const conn = acquireRead();
			try {
				return fn(conn);
			} finally {
				releaseRead(conn);
				observeDbLatency(performance.now() - startedAt);
			}
		},

		async withReadDbAsync<T>(fn: (db: ReadDb) => Promise<T>): Promise<T> {
			if (closed) throw new Error("DbAccessor is closed");
			const startedAt = performance.now();
			const conn = acquireRead();
			try {
				return await fn(conn);
			} finally {
				releaseRead(conn);
				observeDbLatency(performance.now() - startedAt);
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

/** Queue a write transaction when supported, with a sync fallback for test doubles. */
export async function runWriteTxAsync<T>(accessor: DbAccessor, fn: (db: WriteDb) => T): Promise<T> {
	if (accessor.withWriteTxAsync) return accessor.withWriteTxAsync(fn);
	return accessor.withWriteTx(fn);
}

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

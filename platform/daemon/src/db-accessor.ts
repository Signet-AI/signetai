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
	lstatSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	statSync,
	statfsSync,
	truncateSync,
	unlinkSync,
} from "node:fs";
import {
	open as openAsync,
	rm as rmAsync,
	readFile as readFileAsync,
	rename as renameAsync,
	unlink as unlinkAsync,
	writeFile as writeFileAsync,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import {
	createMemoriesFts,
	findSqliteVecExtension,
	hasPendingMigrations,
	LATEST_SCHEMA_VERSION,
	MIGRATIONS,
	memoriesFtsIntegrityIsComplete,
	memoriesFtsNeedsTokenizerRepair,
	readMemoriesFtsIntegrity,
	readMemoriesFtsSql,
	refreshMemoriesFtsState,
	recreateMemoriesFts,
	recreateMemoriesFtsSchema,
	resolveSqliteJournalConfig,
	runMigrations,
} from "@signet/core";
import { convertToIncrementalVacuum, DbSpacePreflightError, ensureVacuumConversionState } from "./db-vacuum";
import type { DbSpaceMetrics } from "./db-vacuum";

import { ensureEmbeddingIndexState } from "./embedding-index-state";
import { loadMemoryConfig } from "./memory-config";
import {
	getDbRuntimeMetrics,
	recordDbOperation,
	resetDbObservability,
	setDbQueueTelemetry,
	type DbOperationOutcome,
	type DbRuntimeMetrics,
} from "./db-observability";
import { closeDbAccessorParticipants } from "./db-accessor-lifecycle";
import { observeDbLatency } from "./runtime-pressure";
import { resetFtsIndexState, setFtsIndexIncomplete } from "./fts-index-state";
import {
	beginSyncDbCall,
	captureSyncDbCallSiteToken,
	endSyncDbCall,
	type SyncDbCallSiteToken,
} from "./sync-db-attribution";

export type { SyncDbCallSiteToken } from "./sync-db-attribution";

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

type SqliteWriteSurface = Pick<SqliteDatabase, "prepare" | "exec">;

type DatabaseConstructor = new (path: string, opts?: Record<string, unknown>) => SqliteDatabase;

// Loading the database driver is intentionally deferred until the daemon opens
// a database. The MCP stdio server imports DB helpers for content-safety
// projection, but delegates all database work to the daemon over HTTP. Loading
// better-sqlite3 here would make that otherwise database-free Node entrypoint
// unusable from the published wrapper, which does not ship this native addon.
let databaseConstructor: DatabaseConstructor | null = null;

function getDatabaseConstructor(): DatabaseConstructor {
	if (databaseConstructor !== null) return databaseConstructor;
	if (isBun) {
		// eslint-disable-next-line @typescript-eslint/no-require-imports
		databaseConstructor = require("bun:sqlite").Database as DatabaseConstructor;
		return databaseConstructor;
	}
	try {
		// eslint-disable-next-line @typescript-eslint/no-require-imports
		databaseConstructor = require("better-sqlite3") as DatabaseConstructor;
		return databaseConstructor;
	} catch (error) {
		throw new Error(
			"Signet's Node database path requires the better-sqlite3 npm package. Install it before starting the daemon.",
			{ cause: error },
		);
	}
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
	/** Number of write transactions currently executing. */
	readonly active: boolean;
	/** Operation label of the oldest queued job, if any. */
	readonly oldestOperation: string | null;
	/** Number of queued jobs rejected because admission was full. */
	readonly rejected: number;
	/** Number of queued jobs cancelled before execution. */
	readonly cancelled: number;
	/** Number of jobs that missed their deadline before execution. */
	readonly timedOut: number;
	/** Queue wait for the most recently started job. */
	readonly lastQueueWaitMs: number | null;
}

export interface ReadPressure {
	/** Number of active read leases. */
	readonly activeLeases: number;
	/** Maximum number of read connections, including non-pooled leases. */
	readonly maxConnections: number;
	/** Number of callers waiting for a read lease. */
	readonly queued: number;
	/** Maximum number of queued read callers. */
	readonly maxQueue: number;
	/** Age of the oldest waiting caller, or null when empty. */
	readonly oldestWaitMs: number | null;
	/** Most recent read lease wait. */
	readonly lastWaitMs: number | null;
	readonly rejected: number;
	/** Number of synchronous legacy reads rejected at the connection cap. */
	readonly syncRejected: number;
	readonly cancelled: number;
	readonly timedOut: number;
}

export interface ReadAdmissionOptions {
	/** Maximum time to wait for a connection. Default 5 seconds. */
	readonly timeoutMs?: number;
	/** Abort a queued request without affecting other readers. */
	readonly signal?: AbortSignal;
	/** Stable diagnostic label for the owner boundary. */
	readonly operation?: string;
	/** Static caller location retained for in-flight parent attribution. */
	readonly siteToken?: SyncDbCallSiteToken;
}

export interface WriteAdmissionOptions {
	/** Stable diagnostic label for the owner boundary. */
	readonly operation?: string;
	/** Static caller location retained for in-flight parent attribution. */
	readonly siteToken?: SyncDbCallSiteToken;
	/** Maximum time a queued job may wait before it is rejected. */
	readonly deadlineMs?: number;
	/** Estimated work units for diagnostics and scheduling. */
	readonly estimatedWorkUnits?: number;
	/** Abort a queued job before it starts. */
	readonly signal?: AbortSignal;
}

export interface DbRuntimePressure {
	readonly writer: WritePressure;
	readonly reader: ReadPressure;
	readonly runtime: DbRuntimeMetrics;
}

export class DbWriteQueueFullError extends Error {
	readonly code = "DB_WRITE_QUEUE_FULL" as const;

	constructor() {
		super("Database write queue is full; retry after write pressure clears");
		this.name = "DbWriteQueueFullError";
	}
}

export class DbReadQueueFullError extends Error {
	readonly code = "DB_READ_QUEUE_FULL" as const;

	constructor() {
		super("Database read admission queue is full; retry after read pressure clears");
		this.name = "DbReadQueueFullError";
	}
}

export class DbReadAdmissionRejectedError extends Error {
	readonly code = "DB_READ_ADMISSION_REJECTED" as const;

	constructor(operation: string) {
		super(`Database read admission rejected for ${operation}; retry after read pressure clears`);
		this.name = "DbReadAdmissionRejectedError";
	}
}

export class DbReadAdmissionTimeoutError extends Error {
	readonly code = "DB_READ_ADMISSION_TIMEOUT" as const;

	constructor(timeoutMs: number) {
		super(`Database read admission timed out after ${timeoutMs}ms`);
		this.name = "DbReadAdmissionTimeoutError";
	}
}

export class DbReadAdmissionCancelledError extends Error {
	readonly code = "DB_READ_ADMISSION_CANCELLED" as const;

	constructor() {
		super("Database read admission was cancelled before a connection became available");
		this.name = "DbReadAdmissionCancelledError";
	}
}

export class DbWriteAdmissionCancelledError extends Error {
	readonly code = "DB_WRITE_ADMISSION_CANCELLED" as const;

	constructor() {
		super("Database write admission was cancelled before execution");
		this.name = "DbWriteAdmissionCancelledError";
	}
}

export class DbWriteAdmissionTimeoutError extends Error {
	readonly code = "DB_WRITE_ADMISSION_TIMEOUT" as const;

	constructor() {
		super("Database write admission deadline exceeded");
		this.name = "DbWriteAdmissionTimeoutError";
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
	withWriteTxAsync<T>(fn: (db: WriteDb) => T, options?: WriteAdmissionOptions): Promise<T>;

	/** Admit an autocommit write session through the bounded async writer queue. */
	withWriteDbAsync<T>(fn: (db: WriteDb) => T, options?: WriteAdmissionOptions): Promise<T>;

	/** Admit a WAL checkpoint through the bounded async writer queue. */
	checkpointWalAsync?(options?: WriteAdmissionOptions): Promise<void>;

	/** Admit incremental vacuum through the bounded async writer queue. */
	incrementalVacuumAsync?(options?: WriteAdmissionOptions): Promise<number>;

	/** Admit the one-time legacy auto_vacuum conversion through the bounded
	 *  async writer queue. */
	vacuumConversionAsync?(options?: WriteAdmissionOptions): Promise<boolean>;

	/** Return bounded local diagnostics for the writer admission path. */
	getWritePressure?(): WritePressure;

	/** Return bounded local diagnostics for the read admission path. */
	getReadPressure?(): ReadPressure;

	/** Return the combined database-owner diagnostics envelope. */
	getDbRuntimePressure?(): DbRuntimePressure;

	/** Async variant of withReadDb. The connection is held only while the
	 * callback's synchronous database work runs and is admitted through a FIFO
	 * lease queue. If the callback returns a promise, its continuation runs
	 * after the lease is released and must not use the database connection. */
	withReadDbAsync<T>(fn: (db: ReadDb) => T | Promise<T>, options?: ReadAdmissionOptions): Promise<T>;

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
let databaseIntegrityWritesBlocked = false;

export class DatabaseIntegrityCorruptError extends Error {
	readonly code = "db-integrity-corrupt" as const;

	constructor() {
		super("Database writes are blocked because integrity verification confirmed corruption");
		this.name = "DatabaseIntegrityCorruptError";
	}
}

export function setDatabaseIntegrityWritesBlocked(blocked: boolean): void {
	databaseIntegrityWritesBlocked = blocked;
}

function assertDatabaseIntegrityWritesAllowed(): void {
	if (databaseIntegrityWritesBlocked) throw new DatabaseIntegrityCorruptError();
}

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
			const sqliteCtor = getDatabaseConstructor() as unknown as { setCustomSQLite?: (p: string) => void };
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
			console.warn("[db-accessor] sqlite-vec extension not found — using bounded canonical-vector fallback");
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
export const MIGRATION_BACKUP_CHUNK_BYTES = 64 * 1024 * 1024;
const MIGRATION_BACKUP_SPACE_MARGIN_BYTES = MIGRATION_BACKUP_CHUNK_BYTES * 2;
/**
 * Startup deadline headroom reserved for migration execution and post-copy
 * bookkeeping inside the initialize job's deadline.
 */
const MIGRATION_BACKUP_STARTUP_RESERVE_MS = 5_000;

export type MigrationBackupAdmissionReason = "space" | "throughput" | "retained-unverified-backup";

const MIGRATION_CHECKPOINT_TABLE = "db_integrity_checkpoints";
const MIGRATION_CHECKPOINT_COMPLETE_STATUS = "complete";
const MIGRATION_CHECKPOINT_PARKED_STATUS = "degraded:integrity-unverified";
const MIGRATION_CHECKPOINT_FAILED_STATUS = "failed:integrity-unverified";
const MIGRATION_VERIFY_CHECKPOINT_PREFIX = "database.migration-verify:";

/** Match only names emitted by migrationBackupDestination. */
export function isGeneratedMigrationBackupName(base: string, name: string): boolean {
	const escapedBase = base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	return new RegExp(`^${escapedBase}\\.bak-v\\d+-\\d+$`).test(name);
}

type MigrationBackupDb = {
	exec(sql: string): unknown;
	prepare?: (sql: string) => {
		get(...params: unknown[]): Record<string, unknown> | undefined;
	};
};

export class MigrationBackupAdmissionError extends Error {
	readonly code = "DB_MIGRATION_BACKUP_ADMISSION_FAILED" as const;

	constructor(
		readonly reason: MigrationBackupAdmissionReason,
		message: string,
		cause?: unknown,
	) {
		super(`[migration_backup] admission refused (${reason}): ${message}`, cause === undefined ? undefined : { cause });
		this.name = "MigrationBackupAdmissionError";
	}
}

function assertMigrationStartupBudget(deadlineAt: number | undefined, stage: string): void {
	if (deadlineAt !== undefined && Date.now() >= deadlineAt - MIGRATION_BACKUP_STARTUP_RESERVE_MS) {
		throw new MigrationBackupAdmissionError(
			"throughput",
			`migration backup startup budget exhausted before ${stage}; resume cursor retained`,
		);
	}
}

interface MigrationBackupCursor {
	readonly sourcePath: string;
	readonly sourceSize: number;
	readonly sourceMtimeMs: number;
	readonly destination: string;
	readonly offset: number;
}

export interface MigrationBackupDeps {
	readonly copyFileSync: (source: string, destination: string) => void;
	readonly readdirSync: (path: string) => string[];
	readonly statSync: (path: string) => { readonly mtimeMs: number; readonly size?: number };
	readonly lstatSync?: (path: string) => {
		readonly mtimeMs: number;
		readonly size?: number;
		readonly isFile: () => boolean;
	};
	readonly statfsSync?: (path: string) => { readonly bavail: number; readonly bsize: number };
	readonly unlinkSync: (path: string) => void;
	readonly now: () => number;
	readonly log: (message: string) => void;
	readonly warn?: (message: string) => void;
	/** Test seam and optional alternate checkpoint source for backup admission. */
	readonly readVerificationCheckpoint?: (backupPath: string) => string | undefined;
}

const migrationBackupDeps: MigrationBackupDeps = {
	copyFileSync,
	readdirSync,
	statSync,
	lstatSync,
	statfsSync,
	unlinkSync,
	now: Date.now,
	log: console.error,
	warn: console.warn,
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
		.filter(
			(f) =>
				isGeneratedMigrationBackupName(base, f) &&
				!f.endsWith(".cursor.json") &&
				!f.includes(".probe-") &&
				!f.includes(".space-probe-"),
		)
		.flatMap((f) => {
			try {
				const path = join(dir, f);
				if (deps.lstatSync !== undefined) {
					const stat = deps.lstatSync(path);
					if (!stat.isFile()) {
						deps.log(`[db-accessor] Skipped non-regular migration backup: ${f}`);
						return [];
					}
					return [{ name: f, mtime: stat.mtimeMs, size: stat.size ?? 0 }];
				}
				const stat = deps.statSync(path);
				return [{ name: f, mtime: stat.mtimeMs, size: stat.size ?? 0 }];
			} catch (err) {
				if (isMissingPathError(err)) return [];
				throw err;
			}
		})
		.sort((a, b) => b.mtime - a.mtime);
}

/** Read the corruption verdict without opening the database. */
export function readMigrationBackupVerdictStatus(backupPath: string): string | undefined {
	try {
		const parsed = JSON.parse(readFileSync(`${backupPath}.verdict.json`, "utf8")) as { status?: unknown };
		return typeof parsed.status === "string" ? parsed.status : undefined;
	} catch {
		return undefined;
	}
}

function isTerminalMigrationBackupStatus(status: string | undefined): boolean {
	return (
		status === MIGRATION_CHECKPOINT_FAILED_STATUS ||
		status === MIGRATION_CHECKPOINT_PARKED_STATUS ||
		status === "failed" ||
		status === "parked"
	);
}

function readMigrationBackupCheckpointStatus(
	backupPath: string,
	db: MigrationBackupDb | undefined,
	deps: MigrationBackupDeps,
): string | undefined {
	const sidecarStatus = readMigrationBackupVerdictStatus(backupPath);
	if (sidecarStatus !== undefined) return sidecarStatus;
	const overridden = deps.readVerificationCheckpoint?.(backupPath);
	if (overridden !== undefined) return overridden;
	if (db?.prepare === undefined) return undefined;
	try {
		const row = db
			.prepare(`SELECT status FROM ${MIGRATION_CHECKPOINT_TABLE} WHERE checkpoint_key = ?`)
			.get(`${MIGRATION_VERIFY_CHECKPOINT_PREFIX}${basename(backupPath)}`);
		return typeof row?.status === "string" ? row.status : undefined;
	} catch {
		// A missing/legacy checkpoint is unverified by definition.
		return undefined;
	}
}

function migrationBackupCursor(
	dbPath: string,
	backupPath: string,
): Pick<MigrationBackupCursor, "sourceSize" | "sourceMtimeMs" | "offset"> | undefined {
	try {
		const parsed = JSON.parse(readFileSync(`${backupPath}.cursor.json`, "utf8")) as Partial<MigrationBackupCursor>;
		if (
			parsed.sourcePath !== dbPath ||
			parsed.destination !== backupPath ||
			typeof parsed.sourceSize !== "number" ||
			!Number.isFinite(parsed.sourceSize) ||
			typeof parsed.sourceMtimeMs !== "number" ||
			!Number.isFinite(parsed.sourceMtimeMs) ||
			typeof parsed.offset !== "number" ||
			!Number.isInteger(parsed.offset) ||
			parsed.offset < 0 ||
			parsed.offset > parsed.sourceSize
		)
			return undefined;
		return { sourceSize: parsed.sourceSize, sourceMtimeMs: parsed.sourceMtimeMs, offset: parsed.offset };
	} catch {
		return undefined;
	}
}
/**
 * Backups emitted by releases before cursor sidecars existed are still valid
 * rollback points. Treat a generated name with no cursor as an unverified
 * legacy backup; malformed cursor sidecars remain a separate, unclassified
 * case and are never admitted as evidence.
 */
function isCursorlessLegacyMigrationBackup(backupPath: string, cursor: unknown): boolean {
	return cursor === undefined && !existsSync(`${backupPath}.cursor.json`);
}

/** Reclaim only backups whose retained cursor proves an older source generation. */
function pruneStaleMigrationBackups(
	dbPath: string,
	sourceSize: number,
	sourceMtimeMs: number,
	deps: MigrationBackupDeps,
	db?: MigrationBackupDb,
): void {
	for (const backup of migrationBackups(dbPath, deps)) {
		const backupPath = join(dirname(dbPath), backup.name);
		const cursor = migrationBackupCursor(dbPath, backupPath);
		if (isCursorlessLegacyMigrationBackup(backupPath, cursor)) {
			const legacyStatus = readMigrationBackupCheckpointStatus(backupPath, db, deps);
			if (legacyStatus !== MIGRATION_CHECKPOINT_COMPLETE_STATUS) {
				deps.log(`[db-accessor] Preserving unverified legacy rollback point: ${backup.name}`);
				continue;
			}
		}
		if (cursor === undefined || (cursor.sourceSize === sourceSize && cursor.sourceMtimeMs === sourceMtimeMs)) continue;
		const checkpointStatus = readMigrationBackupCheckpointStatus(backupPath, db, deps);
		if (checkpointStatus !== MIGRATION_CHECKPOINT_COMPLETE_STATUS) {
			deps.log(`[db-accessor] Preserving unverified rollback point: ${backup.name}`);
			continue;
		}
		try {
			deps.unlinkSync(backupPath);
		} catch (error) {
			if (!isMissingPathError(error)) throw error;
			continue;
		}
		try {
			deps.unlinkSync(`${backupPath}.verdict.json`);
		} catch (error) {
			if (!isMissingPathError(error)) throw error;
		}
		try {
			deps.unlinkSync(`${backupPath}.cursor.json`);
		} catch (error) {
			if (!isMissingPathError(error)) throw error;
		}
		deps.log(`[db-accessor] Reclaimed stale migration backup: ${backup.name}`);
	}
}

function assertNoRetainedUnverifiedMigrationBackup(
	dbPath: string,
	sourceSize: number,
	sourceMtimeMs: number,
	deps: MigrationBackupDeps,
	db?: MigrationBackupDb,
): void {
	for (const backup of migrationBackups(dbPath, deps)) {
		const backupPath = join(dirname(dbPath), backup.name);
		const cursor = migrationBackupCursor(dbPath, backupPath);
		if (isCursorlessLegacyMigrationBackup(backupPath, cursor)) {
			const legacyStatus = readMigrationBackupCheckpointStatus(backupPath, db, deps);
			if (legacyStatus !== MIGRATION_CHECKPOINT_COMPLETE_STATUS) {
				throw new MigrationBackupAdmissionError(
					"retained-unverified-backup",
					`retained legacy rollback file ${backup.name} is unverified; restore or rename the retained file before retrying`,
				);
			}
		}
		if (cursor === undefined || (cursor.sourceSize === sourceSize && cursor.sourceMtimeMs === sourceMtimeMs)) continue;
		const checkpointStatus = readMigrationBackupCheckpointStatus(backupPath, db, deps);
		if (checkpointStatus === MIGRATION_CHECKPOINT_COMPLETE_STATUS) continue;
		throw new MigrationBackupAdmissionError(
			"retained-unverified-backup",
			`retained rollback file ${backup.name} is unverified; restore or rename the retained file before retrying`,
		);
	}
}

/**
 * A prior-generation backup that is merely unverified is recoverable: defer
 * this boot's new migration and let the post-ready verifier decide its fate.
 * Terminal failed/parked generations remain a hard admission refusal.
 */
function shouldDeferPendingMigration(dbPath: string, db: MigrationBackupDb, deps: MigrationBackupDeps): boolean {
	if (!existsSync(dbPath) || !hasPendingMigrations(db as never)) return false;
	const source = deps.statSync(dbPath);
	let deferred = false;
	for (const backup of migrationBackups(dbPath, deps)) {
		const backupPath = join(dirname(dbPath), backup.name);
		const cursor = migrationBackupCursor(dbPath, backupPath);
		if (isCursorlessLegacyMigrationBackup(backupPath, cursor)) {
			const legacyStatus = readMigrationBackupCheckpointStatus(backupPath, db, deps);
			if (legacyStatus === MIGRATION_CHECKPOINT_COMPLETE_STATUS) continue;
			if (isTerminalMigrationBackupStatus(legacyStatus)) {
				throw new MigrationBackupAdmissionError(
					"retained-unverified-backup",
					`retained legacy rollback file ${backup.name} has terminal verification status ${legacyStatus}; operator repair is required`,
				);
			}
			deferred = true;
			continue;
		}
		if (cursor?.offset === 0 && (source.size ?? 0) > 0) {
			const status = readMigrationBackupCheckpointStatus(backupPath, db, deps);
			if (isTerminalMigrationBackupStatus(status)) {
				throw new MigrationBackupAdmissionError(
					"retained-unverified-backup",
					`retained rollback file ${backup.name} has terminal verification status ${status}; operator repair is required`,
				);
			}
			if (status !== MIGRATION_CHECKPOINT_COMPLETE_STATUS) deferred = true;
			continue;
		}
		if (cursor === undefined || (cursor.sourceSize === source.size && cursor.sourceMtimeMs === source.mtimeMs))
			continue;
		const status = readMigrationBackupCheckpointStatus(backupPath, db, deps);
		if (status === MIGRATION_CHECKPOINT_COMPLETE_STATUS) continue;
		if (isTerminalMigrationBackupStatus(status)) {
			throw new MigrationBackupAdmissionError(
				"retained-unverified-backup",
				`retained rollback file ${backup.name} has terminal verification status ${status}; operator repair is required`,
			);
		}
		deferred = true;
	}
	if (deferred) deps.log("[db-accessor] migration deferred pending prior-generation verification");
	return deferred;
}

function pruneMigrationBackups(
	dbPath: string,
	keep: number,
	deps: MigrationBackupDeps,
	keepName?: string,
	strict = false,
	db?: MigrationBackupDb,
	verifiedBackupPath?: string,
): void {
	const dir = dirname(dbPath);
	for (const old of migrationBackups(dbPath, deps)
		.filter((backup) => backup.name !== keepName)
		.slice(Math.max(0, keep))) {
		try {
			const backupPath = join(dir, old.name);
			const cursor = migrationBackupCursor(dbPath, backupPath);
			const legacyUnverified =
				isCursorlessLegacyMigrationBackup(backupPath, cursor) && backupPath !== verifiedBackupPath;
			if (
				(legacyUnverified || cursor !== undefined) &&
				backupPath !== verifiedBackupPath &&
				readMigrationBackupCheckpointStatus(backupPath, db, deps) !== MIGRATION_CHECKPOINT_COMPLETE_STATUS
			) {
				deps.log(
					`[db-accessor] Preserving ${legacyUnverified ? "unverified legacy " : "unverified "}rollback point: ${old.name}`,
				);
				continue;
			}
			try {
				deps.unlinkSync(backupPath);
			} catch (err) {
				if (!isMissingPathError(err)) throw err;
			}
			if (migrationBackups(dbPath, deps).some((backup) => backup.name === old.name)) {
				throw new Error(`Migration backup still exists after unlink: ${backupPath}`);
			}
			try {
				deps.unlinkSync(`${backupPath}.cursor.json`);
			} catch {
				// A completed backup has no cursor; stale cursor cleanup is best effort.
			}
			try {
				deps.unlinkSync(`${backupPath}.verdict.json`);
			} catch {
				// Terminal verdict cleanup is best effort after the backup is gone.
			}
			deps.log(`[db-accessor] Pruned old backup: ${old.name}`);
		} catch (error) {
			if (strict) throw error;
			// Best effort during pre-migration pruning; the integrity gate uses strict mode.
		}
	}
}

function availableBytes(path: string, deps: MigrationBackupDeps): number | null {
	if (!deps.statfsSync) return null;
	try {
		const stat = deps.statfsSync(path);
		if (!Number.isFinite(stat.bavail) || stat.bavail < 0) return null;
		if (!Number.isFinite(stat.bsize) || stat.bsize <= 0) return null;
		const available = stat.bavail * stat.bsize;
		return Number.isFinite(available) && available >= 0 ? available : null;
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
	if (dbBytes === null) return null;
	const metrics = {
		dbBytes,
		freeBytes,
		requiredBytes: dbBytes + MIGRATION_BACKUP_SPACE_MARGIN_BYTES,
	} satisfies DbSpaceMetrics;
	if (freeBytes === null) {
		// statfs is unavailable or returned an unusable value on some filesystems.
		// Do not turn an unknown measurement into a false zero and brick startup;
		// the copy itself remains the authoritative write check.
		(deps.warn ?? deps.log)(
			"[db-accessor] Migration backup free space is unknown; proceeding without the space preflight.",
		);
		return metrics;
	}
	if (freeBytes < metrics.requiredBytes) throw new DbSpacePreflightError("migration_backup", metrics);
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
 * stale backups before admission, then prunes old backups after the copy is
 * complete so a failed preflight keeps current-generation recovery intact.
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
	pruneMigrationBackups(dbPath, MAX_MIGRATION_BACKUPS, deps, undefined, false, db);
	return backupDest;
}

export async function backupBeforeMigrationAsync(
	db: { exec(sql: string): unknown },
	dbPath: string,
	schemaVersion: number,
	deps: MigrationBackupDeps = migrationBackupDeps,
	deadlineAt = Number.POSITIVE_INFINITY,
): Promise<string> {
	if (deps !== migrationBackupDeps) {
		const space = prepareMigrationBackup(db, dbPath, deps);
		const backupDest = migrationBackupDestination(dbPath, schemaVersion, deps);
		try {
			deps.copyFileSync(dbPath, backupDest);
		} catch (err) {
			await cleanupPartialMigrationBackupAsync(backupDest, deps);
			if (isDbFullError(err) && space !== null) {
				throw migrationBackupSpaceError(dbPath, space, deps, err);
			}
			throw migrationBackupError(backupDest, err);
		}
		finishMigrationBackup(dbPath, backupDest, deps);
		pruneMigrationBackups(dbPath, MAX_MIGRATION_BACKUPS, deps, undefined, false, db);
		return backupDest;
	}
	return await streamedMigrationBackup(db, dbPath, schemaVersion, deadlineAt);
}

async function streamedMigrationBackup(
	db: { exec(sql: string): unknown },
	dbPath: string,
	schemaVersion: number,
	deadlineAt: number,
): Promise<string> {
	try {
		db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
	} catch {
		// Non-fatal — the backup remains useful when WAL cannot be truncated.
	}
	const sourceStat = statSync(dbPath);
	const sourceSize = sourceStat.size;
	const sourceMtimeMs = sourceStat.mtimeMs;
	const sourceMode = sourceStat.mode & 0o7777;
	const resume = await readMigrationBackupCursor(dbPath, sourceSize, sourceMtimeMs);
	const backupDest = resume?.destination ?? migrationBackupDestination(dbPath, schemaVersion, migrationBackupDeps);
	const offset = resume?.offset ?? 0;
	if (resume === undefined) {
		try {
			prepareMigrationBackup(db, dbPath, migrationBackupDeps);
		} catch (error) {
			if (error instanceof DbSpacePreflightError) {
				throw new MigrationBackupAdmissionError("space", error.message, error);
			}
			throw error;
		}
		await probeMigrationBackupThroughput(dbPath, sourceSize, backupDest, sourceMode, 0, deadlineAt);
		await copyMigrationBackupChunks(dbPath, backupDest, sourceSize, sourceMtimeMs, sourceMode, offset, deadlineAt);
	} else {
		// Admission holds across restarts too: free space and disk throughput
		// can change between processes (the partial copy already consumed
		// `offset` bytes), so a resume re-preflights the remaining bytes and
		// re-probes the remaining copy budget before writing anything.
		pruneStaleMigrationBackups(dbPath, sourceSize, sourceMtimeMs, migrationBackupDeps, db);
		preflightResumedMigrationBackupSpace(dbPath, sourceSize, offset, migrationBackupDeps);
		await probeMigrationBackupThroughput(dbPath, sourceSize, backupDest, sourceMode, offset, deadlineAt);
		await copyMigrationBackupChunks(dbPath, backupDest, sourceSize, sourceMtimeMs, sourceMode, offset, deadlineAt);
	}
	finishMigrationBackup(dbPath, backupDest, migrationBackupDeps);
	pruneMigrationBackups(dbPath, MAX_MIGRATION_BACKUPS, migrationBackupDeps, undefined, false, db);
	return backupDest;
}

async function readMigrationBackupCursor(
	dbPath: string,
	sourceSize: number,
	sourceMtimeMs: number,
): Promise<MigrationBackupCursor | undefined> {
	const dir = dirname(dbPath);
	const base = basename(dbPath);
	for (const name of readdirSync(dir).filter(
		(entry) =>
			entry.endsWith(".cursor.json") && isGeneratedMigrationBackupName(base, entry.slice(0, -".cursor.json".length)),
	)) {
		const cursorPath = join(dir, name);
		try {
			const parsed = JSON.parse(await readFileAsync(cursorPath, "utf8")) as Partial<MigrationBackupCursor>;
			const cursorMatchesSource =
				parsed.sourcePath === dbPath && parsed.sourceSize === sourceSize && parsed.sourceMtimeMs === sourceMtimeMs;
			const destination = typeof parsed.destination === "string" ? parsed.destination : undefined;
			const safeDestination =
				destination !== undefined &&
				destination === join(dir, basename(destination)) &&
				basename(destination).startsWith(`${base}.bak-v`);
			let destinationStat: ReturnType<typeof lstatSync> | undefined;
			let destinationExists = false;
			if (destination !== undefined) {
				try {
					destinationStat = lstatSync(destination);
					destinationExists = true;
				} catch (error) {
					if (!isMissingPathError(error)) throw error;
				}
			}
			const regularDestinationStat = destinationStat?.isFile() === true ? destinationStat : undefined;
			const destinationIsRegularFile = regularDestinationStat !== undefined;
			const destinationSize = regularDestinationStat?.size;
			const cursorOffsetValid =
				typeof parsed.offset === "number" &&
				Number.isInteger(parsed.offset) &&
				parsed.offset >= 0 &&
				parsed.offset <= sourceSize;
			const destinationSizeValid =
				destinationIsRegularFile &&
				destinationSize !== undefined &&
				cursorOffsetValid &&
				destinationSize >= parsed.offset;
			if (
				cursorMatchesSource &&
				safeDestination &&
				cursorOffsetValid &&
				destinationExists &&
				!destinationIsRegularFile
			) {
				try {
					// A cursor must never be allowed to remove a directory or follow a
					// symlink. unlinkSync removes only the named directory entry.
					unlinkSync(destination);
				} catch (error) {
					migrationBackupDeps.log(
						`[db-accessor] Ignored non-regular migration backup destination ${destination}: ${readErrorMessage(error)}`,
					);
				}
				try {
					unlinkSync(cursorPath);
				} catch (error) {
					if (!isMissingPathError(error)) throw error;
				}
			}
			if (!cursorMatchesSource || !safeDestination || !cursorOffsetValid || !destinationSizeValid) {
				if (
					cursorMatchesSource &&
					safeDestination &&
					cursorOffsetValid &&
					destinationIsRegularFile &&
					destinationSize !== undefined &&
					destinationSize < parsed.offset
				) {
					await rmAsync(destination, { force: true });
					await rmAsync(cursorPath, { force: true });
				}
				continue;
			}
			if (destinationSize > parsed.offset) truncateSync(destination, parsed.offset);
			return { ...parsed, destination } as MigrationBackupCursor;
		} catch {
			// A torn cursor is ignored; the next admission creates a fresh backup.
		}
	}
	return undefined;
}

async function writeMigrationBackupCursor(cursor: MigrationBackupCursor): Promise<void> {
	const cursorPath = `${cursor.destination}.cursor.json`;
	const tempPath = `${cursorPath}.tmp-${process.pid}`;
	await writeFileAsync(tempPath, `${JSON.stringify(cursor)}\n`, "utf8");
	await renameAsync(tempPath, cursorPath);
}

async function probeMigrationBackupThroughput(
	dbPath: string,
	sourceSize: number,
	backupDest: string,
	sourceMode: number,
	resumeOffset = 0,
	deadlineAt: number,
): Promise<void> {
	if (sourceSize === 0 || resumeOffset >= sourceSize) return;
	if (Date.now() >= deadlineAt - MIGRATION_BACKUP_STARTUP_RESERVE_MS) {
		throw new MigrationBackupAdmissionError(
			"throughput",
			"migration backup throughput probe reached the owner deadline reserve",
		);
	}
	const probeDest = `${backupDest}.probe-${process.pid}`;
	let source: Awaited<ReturnType<typeof openAsync>> | undefined;
	let probe: Awaited<ReturnType<typeof openAsync>> | undefined;
	try {
		source = await openAsync(dbPath, "r");
		probe = await openAsync(probeDest, "w", sourceMode);
		const buffer = Buffer.allocUnsafe(Math.min(MIGRATION_BACKUP_CHUNK_BYTES, sourceSize));
		const probeStartedAt = performance.now();
		const result = await source.read(buffer, 0, buffer.length, resumeOffset);
		let probeWritten = 0;
		while (probeWritten < result.bytesRead) {
			const written = await probe.write(buffer, probeWritten, result.bytesRead - probeWritten, probeWritten);
			if (written.bytesWritten === 0) {
				throw new Error("Migration backup throughput probe write stalled");
			}
			probeWritten += written.bytesWritten;
		}
		await probe.sync();
		const probeElapsedMs = Math.max(1, performance.now() - probeStartedAt);
		const bytesPerMs = result.bytesRead / probeElapsedMs;
		const remainingBytes = sourceSize - resumeOffset;
		const estimatedMs = Math.ceil(remainingBytes / bytesPerMs);
		// The initialize job's deadline covers admission + probe + copy +
		// migration + startup bookkeeping. The copy may only claim the window
		// left after the probe spent its time and the reserve is kept for the
		// migration itself. (The copy loop re-checks this window every chunk;
		// a stall mid-copy surfaces as the deadline error, never a silent wedge.)
		const copyWindowMs = deadlineAt - Date.now() - MIGRATION_BACKUP_STARTUP_RESERVE_MS;
		if (!Number.isFinite(estimatedMs) || copyWindowMs <= 0 || estimatedMs > copyWindowMs) {
			throw new MigrationBackupAdmissionError(
				"throughput",
				`measured copy rate predicts ${estimatedMs}ms for the remaining ${remainingBytes} of ${sourceSize} bytes; copy window is ${copyWindowMs}ms after probe time and startup reserve`,
			);
		}
	} catch (error) {
		if (error instanceof MigrationBackupAdmissionError) throw error;
		if (isDbFullError(error)) {
			throw new MigrationBackupAdmissionError(
				"space",
				"throughput probe could not write its bounded scratch chunk",
				error,
			);
		}
		throw error;
	} finally {
		await source?.close();
		await probe?.close();
		try {
			await unlinkAsync(probeDest);
		} catch {
			// Best effort probe cleanup. Preserve the admission/copy error above.
		}
	}
}

type MigrationBackupReadChunk = (
	buffer: Buffer,
	length: number,
	position: number,
) => Promise<{ readonly bytesRead: number }>;

export async function copyMigrationBackupChunks(
	dbPath: string,
	backupDest: string,
	sourceSize: number,
	sourceMtimeMs: number,
	sourceMode: number,
	offset: number,
	deadlineAt: number,
	readChunk?: MigrationBackupReadChunk,
): Promise<void> {
	const source = await openAsync(dbPath, "r");
	let destination: Awaited<ReturnType<typeof openAsync>> | undefined;
	try {
		destination = await openAsync(backupDest, offset === 0 ? "w" : "r+", sourceMode);
		if (destination === undefined) throw new Error("Migration backup destination did not open");
		await destination.truncate(offset);
		if (offset === 0) {
			await writeMigrationBackupCursor({
				sourcePath: dbPath,
				sourceSize,
				sourceMtimeMs,
				destination: backupDest,
				offset: 0,
			});
		}
		// The measured rate is admission, not a leash: the deadline owns the
		// hard stop. This wall-clock check makes budget exhaustion mid-copy a
		// named admission error with a resumable cursor, instead of letting
		// the copy run until the deadline kills the job.
		const buffer = Buffer.allocUnsafe(Math.min(MIGRATION_BACKUP_CHUNK_BYTES, Math.max(1, sourceSize)));
		while (offset < sourceSize) {
			if (Date.now() >= deadlineAt - MIGRATION_BACKUP_STARTUP_RESERVE_MS) {
				throw new MigrationBackupAdmissionError(
					"throughput",
					`migration backup copy exceeded its budget at ${offset} of ${sourceSize} bytes; resume cursor retained`,
				);
			}
			const length = Math.min(buffer.length, sourceSize - offset);
			const result = await (readChunk === undefined
				? source.read(buffer, 0, length, offset)
				: readChunk(buffer, length, offset));
			if (result.bytesRead === 0) throw new Error(`Migration backup source ended at ${offset} of ${sourceSize} bytes`);
			let chunkOffset = 0;
			while (chunkOffset < result.bytesRead) {
				const written = await destination.write(
					buffer,
					chunkOffset,
					result.bytesRead - chunkOffset,
					offset + chunkOffset,
				);
				if (written.bytesWritten === 0)
					throw new Error(`Migration backup write stalled at ${offset + chunkOffset} of ${sourceSize} bytes`);
				chunkOffset += written.bytesWritten;
			}
			// Advance and persist the cursor before the post-chunk deadline fence.
			// If the final chunk consumed the remaining budget, the cursor is the
			// durable resume point and must not be removed by the caller.
			offset += result.bytesRead;
			await destination.sync();
			await writeMigrationBackupCursor({
				sourcePath: dbPath,
				sourceSize,
				sourceMtimeMs,
				destination: backupDest,
				offset,
			});
		}
		if (Date.now() >= deadlineAt - MIGRATION_BACKUP_STARTUP_RESERVE_MS) {
			throw new MigrationBackupAdmissionError(
				"throughput",
				`migration backup copy exhausted its deadline reserve at ${offset} of ${sourceSize} bytes; resume cursor retained`,
			);
		}
	} catch (error) {
		if (isDbFullError(error)) {
			throw new MigrationBackupAdmissionError("space", "database backup copy ran out of space after admission", error);
		}
		throw error;
	} finally {
		await source.close();
		await destination?.close();
	}
}

function sweepStaleMigrationBackupProbes(dbPath: string, deps: MigrationBackupDeps): void {
	const dir = dirname(dbPath);
	const base = basename(dbPath);
	let entries: string[];
	try {
		entries = deps.readdirSync(dir);
	} catch {
		return;
	}
	for (const entry of entries) {
		const isProbe = entry.includes(".probe-") || entry.includes(".space-probe-");
		const probeName = entry.includes(".space-probe-")
			? entry.slice(0, entry.indexOf(".space-probe-"))
			: entry.slice(0, entry.indexOf(".probe-"));
		if (
			!isGeneratedMigrationBackupName(base, probeName) ||
			!isProbe ||
			entry.endsWith(`.probe-${process.pid}`) ||
			entry.endsWith(`.space-probe-${process.pid}`)
		)
			continue;
		const path = join(dir, entry);
		try {
			deps.unlinkSync(path);
			deps.log(`[db-accessor] Reclaimed stale migration backup probe: ${entry}`);
		} catch {
			// Probe cleanup is deliberately best effort: admission remains
			// authoritative and must not fail because a stale scratch file races.
		}
	}
}

function prepareMigrationBackup(
	db: MigrationBackupDb,
	dbPath: string,
	deps: MigrationBackupDeps,
): DbSpaceMetrics | null {
	// Flush WAL so the .db file is self-contained before measuring the copy.
	try {
		db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
	} catch {
		// Non-fatal — backup still useful even with WAL.
	}

	try {
		const source = deps.statSync(dbPath);
		if (typeof source.size === "number" && Number.isFinite(source.size)) {
			assertNoRetainedUnverifiedMigrationBackup(dbPath, source.size, source.mtimeMs, deps, db);
			pruneStaleMigrationBackups(dbPath, source.size, source.mtimeMs, deps, db);
		}
	} catch (error) {
		if (error instanceof MigrationBackupAdmissionError) throw error;
		// The space preflight remains authoritative when metadata collection races
		// with a source or backup disappearing.
	}
	sweepStaleMigrationBackupProbes(dbPath, deps);
	return preflightMigrationBackupSpace(dbPath, deps);
}

/**
 * Resume admission: the remaining bytes still need headroom on this disk,
 * now, after the partial copy already consumed `offset` bytes. The
 * in-progress backup itself is the current attempt's rollback point, so it
 * is not pruned; only its remaining growth must fit. Unknown statfs readings
 * warn and proceed, exactly like the fresh-copy preflight.
 */
function preflightResumedMigrationBackupSpace(
	dbPath: string,
	sourceSize: number,
	offset: number,
	deps: MigrationBackupDeps,
): void {
	const remaining = sourceSize - offset;
	if (remaining <= 0) return;
	const freeBytes = availableBytes(dirname(dbPath), deps);
	const metrics = {
		dbBytes: sourceSize,
		freeBytes,
		requiredBytes: remaining + MIGRATION_BACKUP_SPACE_MARGIN_BYTES,
	} satisfies DbSpaceMetrics;
	if (freeBytes === null) {
		(deps.warn ?? deps.log)(
			"[db-accessor] Migration backup resume free space is unknown; proceeding without the space preflight.",
		);
		return;
	}
	if (freeBytes < metrics.requiredBytes) throw new DbSpacePreflightError("migration_backup", metrics);
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

function finishMigrationBackup(_dbPath: string, backupDest: string, deps: MigrationBackupDeps): void {
	deps.log(`[db-accessor] Pre-migration backup: ${backupDest}`);
}

/** Return whether startup still has a migration rollback point awaiting verification. */
export function hasPendingMigrationBackup(dbPath: string): boolean {
	return migrationBackups(dbPath, migrationBackupDeps).length > 0;
}

/** Return the newest rollback backup awaiting post-ready verification. */
export function pendingMigrationBackupPath(dbPath: string): string | null {
	const pending = migrationBackups(dbPath, migrationBackupDeps)[0];
	return pending === undefined ? null : join(dirname(dbPath), pending.name);
}

/** Return the size of the newest rollback backup awaiting post-ready verification. */
export function pendingMigrationBackupSizeBytes(dbPath: string): number | null {
	const pending = migrationBackups(dbPath, migrationBackupDeps)[0];
	return pending?.size ?? null;
}

/** Remove rollback points only after post-ready integrity maintenance passes. */
export function pruneMigrationBackupsAfterIntegrity(
	dbPath: string,
	deps: MigrationBackupDeps = migrationBackupDeps,
	verifiedBackupPath?: string,
): void {
	pruneMigrationBackups(dbPath, 0, deps, undefined, true, undefined, verifiedBackupPath);
	const dir = dirname(dbPath);
	const base = basename(dbPath);
	for (const name of deps
		.readdirSync(dir)
		.filter(
			(entry) =>
				entry.endsWith(".cursor.json") && isGeneratedMigrationBackupName(base, entry.slice(0, -".cursor.json".length)),
		)) {
		const backupName = name.slice(0, -".cursor.json".length);
		if (migrationBackups(dbPath, deps).some((backup) => backup.name === backupName)) continue;
		try {
			deps.unlinkSync(join(dir, name));
		} catch {
			// Best effort cleanup; retaining a cursor is safer than deleting evidence.
		}
	}
}

/**
 * Rowid high-water mark of the migration audit log, read before migrations run.
 * The audit table is an append-only autoincrement log, so rows above this mark
 * are exactly the migrations this startup applied.
 */
function migrationAuditHighWaterMark(writeConn: SqliteDatabase): number {
	try {
		const row = writeConn.prepare("SELECT MAX(id) AS maxId FROM schema_migrations_audit").get() as
			| { maxId?: unknown }
			| undefined;
		const maxId = Number(row?.maxId);
		return Number.isFinite(maxId) && maxId > 0 ? maxId : 0;
	} catch {
		return 0;
	}
}

/**
 * Versions applied by this startup's migration run, scoped by the audit
 * high-water mark captured before migrations ran.
 */
function appliedMigrationVersions(writeConn: SqliteDatabase, auditHighWaterMark: number): Set<number> {
	try {
		const rows = writeConn
			.prepare("SELECT version FROM schema_migrations_audit WHERE id > ?")
			.all(auditHighWaterMark) as ReadonlyArray<{ version?: unknown }>;
		return new Set(rows.map((row) => Number(row.version)).filter((v) => Number.isFinite(v)));
	} catch {
		// Audit table missing or unreadable: verify every migration so this
		// fails loudly rather than silently skipping artifact verification.
		return new Set(MIGRATIONS.map((m) => m.version));
	}
}

function verifyMigrationArtifacts(writeConn: SqliteDatabase, auditHighWaterMark: number): void {
	const version = readCurrentSchemaVersion(writeConn);
	if (version !== LATEST_SCHEMA_VERSION) {
		throw new Error(
			`Migration artifact verification found schema version ${version}; expected ${LATEST_SCHEMA_VERSION}`,
		);
	}
	const missing: string[] = [];
	// Only migrations applied during this startup are verified here. Core
	// migration logic deliberately accepts legacy inline-migrated v1 databases
	// whose baseline artifacts (conversations, embeddings) were never created;
	// verifying all migrations unconditionally would reject that supported
	// shape. Earlier versions were verified by the startup that applied them.
	const appliedVersions = appliedMigrationVersions(writeConn, auditHighWaterMark);
	for (const migration of MIGRATIONS) {
		if (!appliedVersions.has(migration.version)) continue;
		for (const table of migration.artifacts?.tables ?? []) {
			const row = writeConn.prepare("SELECT 1 AS present FROM sqlite_schema WHERE name = ? LIMIT 1").get(table);
			if (row === undefined) missing.push(`table ${table} (migration ${migration.version})`);
		}
		for (const column of migration.artifacts?.columns ?? []) {
			const rows = writeConn.prepare(`PRAGMA table_info(${JSON.stringify(column.table)})`).all() as ReadonlyArray<{
				name?: unknown;
			}>;
			const tableExists = rows.length > 0;
			if (!tableExists && column.optional === true) continue;
			if (!rows.some((row) => row.name === column.column))
				missing.push(`column ${column.table}.${column.column} (migration ${migration.version})`);
		}
	}
	if (missing.length > 0) throw new Error(`Migration artifact verification failed: ${missing.join(", ")}`);
}

/**
 * Initialise the singleton accessor. Must be called once at daemon startup
 * before any route handler runs. Ensures the memory directory exists, opens
 * the write connection, sets pragmas, and runs pending migrations.
 */
export function initDbAccessor(path: string, opts?: { readonly agentsDir?: string }): void {
	const writeConn = openDbAccessorConnection(path, opts);
	const deferMigrations = shouldDeferPendingMigration(path, toMigrationDb(writeConn) as never, migrationBackupDeps);
	if (deferMigrations) {
		writeConn.close();
		initDbAccessorReadOnly(path, vecExtPath ?? "", opts);
		return;
	}
	const migrationBackup = deferMigrations ? null : backupBeforePendingMigrations(writeConn, path);
	finishDbAccessorInit(writeConn, opts, migrationBackup, undefined, deferMigrations);
}

export interface DbAccessorInitializationResult {
	readonly pendingVecBackfill: boolean;
	/** sqlite-vec path resolved while opening the owner connection. */
	readonly extensionPath?: string | null;
	/** Prior-generation verification is still running; this accessor is readonly. */
	readonly deferredMigrationVerification: boolean;
}

export async function initDbAccessorAsync(
	path: string,
	opts?: { readonly agentsDir?: string; readonly deadlineAt?: number },
): Promise<DbAccessorInitializationResult> {
	const writeConn = openDbAccessorConnection(path, opts);
	const deferMigrations = shouldDeferPendingMigration(path, toMigrationDb(writeConn) as never, migrationBackupDeps);
	if (deferMigrations) {
		writeConn.close();
		initDbAccessorReadOnly(path, vecExtPath ?? "", opts);
		return {
			pendingVecBackfill: false,
			extensionPath: vecExtPath ?? null,
			deferredMigrationVerification: true,
		};
	}
	const migrationBackup = deferMigrations
		? null
		: await backupBeforePendingMigrationsAsync(writeConn, path, opts?.deadlineAt);
	return finishDbAccessorInit(writeConn, opts, migrationBackup, opts?.deadlineAt, false);
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

	const writeConn = new (getDatabaseConstructor())(path);
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

async function backupBeforePendingMigrationsAsync(
	writeConn: SqliteDatabase,
	path: string,
	deadlineAt?: number,
): Promise<string | null> {
	if (existsSync(path) && hasPendingMigrations(toMigrationDb(writeConn))) {
		return await backupBeforeMigrationAsync(
			writeConn,
			path,
			readCurrentSchemaVersion(writeConn),
			migrationBackupDeps,
			deadlineAt,
		);
	}
	return null;
}

function finishDbAccessorInit(
	writeConn: SqliteDatabase,
	opts?: { readonly agentsDir?: string },
	migrationBackup?: string | null,
	deadlineAt?: number,
	skipMigrations = false,
): DbAccessorInitializationResult {
	// Run schema migrations — this is the sole schema authority.
	// Failures here are fatal: the daemon must not start on bad schema.
	const auditHighWaterMark = migrationAuditHighWaterMark(writeConn);
	if (!skipMigrations) {
		assertMigrationStartupBudget(deadlineAt, "migrations");
		runMigrations(toMigrationDb(writeConn));
	}
	if (!skipMigrations && migrationBackup !== null && migrationBackup !== undefined) {
		assertMigrationStartupBudget(deadlineAt, "migration artifact verification");
		// Startup only checks bounded schema artifacts for the migrations this
		// run applied. The retained rollback point is pruned by post-ready
		// incremental integrity maintenance after it passes.
		verifyMigrationArtifacts(writeConn, auditHighWaterMark);
	}

	// Record one-time conversion state only after migrations have succeeded.
	// The conversion itself is deliberately post-ready because VACUUM can
	// block the event loop for minutes on a large legacy database (#1493).
	assertMigrationStartupBudget(deadlineAt, "vacuum conversion state");
	ensureVacuumConversionState(toMigrationDb(writeConn));

	// Ensure FTS5 virtual table exists — may be missing on upgrades from
	// older installs where the table was dropped or never created.
	assertMigrationStartupBudget(deadlineAt, "FTS setup");
	resetFtsIndexState();
	ensureFtsTable(writeConn, { deferBackfill: true });
	const ftsIntegrity = readMemoriesFtsIntegrity(toFtsSchemaQueryDb(writeConn));
	setFtsIndexIncomplete(ftsIntegrity === null || !memoriesFtsIntegrityIsComplete(ftsIntegrity));
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
		assertMigrationStartupBudget(deadlineAt, "vector setup");
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
			const pendingVecBackfill = hasMissingVecEmbeddings(writeConn, vecDimensions);
			accessor = createAccessor(writeConn);
			return { pendingVecBackfill, extensionPath: vecExtPath ?? null, deferredMigrationVerification: false };
		}
	}

	accessor = createAccessor(writeConn);
	return { pendingVecBackfill: false, extensionPath: vecExtPath ?? null, deferredMigrationVerification: false };
}

export function initDbAccessorLite(dbPathParam: string, vecExtensionPath: string): void {
	if (accessor !== null) throw new Error("DbAccessor already initialised");

	dbPath = dbPathParam;
	vecExtPath = vecExtensionPath;

	const writeConn = new (getDatabaseConstructor())(dbPathParam);
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

/**
 * Open only the readonly accessor needed to serve recovery/status routes when
 * startup retained a confirmed-corrupt migration checkpoint. Unlike the
 * normal lite path this does not change pragmas or schema/index state.
 */
export function initDbAccessorReadOnly(
	dbPathParam: string,
	vecExtensionPath: string,
	opts?: { readonly agentsDir?: string },
): void {
	if (accessor !== null) throw new Error("DbAccessor already initialised");

	dbPath = dbPathParam;
	vecExtPath = vecExtensionPath;
	configureCustomSqlite(opts?.agentsDir);
	const readConn = new (getDatabaseConstructor())(dbPathParam, { readonly: true });
	loadVecExtension(readConn);
	accessor = createAccessor(readConn);
}

// ---------------------------------------------------------------------------
// FTS table creation (self-healing for upgrades)
// ---------------------------------------------------------------------------

/**
 * Ensure the memories_fts virtual table exists with the canonical
 * tokenizer. Older installs can carry a legacy porter-tokenized table,
 * which silently harms lexical recall quality for conversational cues.
 */
export function ensureFtsTable(db: SqliteDatabase, options: { readonly deferBackfill?: boolean } = {}): void {
	const sql = readMemoriesFtsSql(toFtsSchemaQueryDb(db));

	if (sql === null) {
		console.error("[db-accessor] memories_fts missing — recreating FTS5 table");
		createMemoriesFts(db);
		if (options.deferBackfill !== true) {
			const backfilled = db.prepare("SELECT COUNT(*) as n FROM memories").get() as { n: number };
			if (backfilled.n > 0) {
				db.exec("INSERT INTO memories_fts(rowid, content) SELECT rowid, content FROM memories");
				console.error(`[db-accessor] Backfilled ${backfilled.n} rows into memories_fts`);
			}
		}
		if (options.deferBackfill !== true) refreshMemoriesFtsState(db);
		return;
	}

	if (!memoriesFtsNeedsTokenizerRepair(sql)) {
		createMemoriesFts(db);
		if (options.deferBackfill !== true) refreshMemoriesFtsState(db);
		return;
	}

	console.error("[db-accessor] memories_fts tokenizer drift detected — recreating FTS5 table");
	if (options.deferBackfill === true) recreateMemoriesFtsSchema(db);
	else recreateMemoriesFts(db);
	if (options.deferBackfill !== true) refreshMemoriesFtsState(db);
}

// ---------------------------------------------------------------------------
// Vec table creation + backfill
// ---------------------------------------------------------------------------

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

function ensureVecEmbeddingsQuarantineTable(db: SqliteWriteSurface): void {
	db.exec(`
		CREATE TABLE IF NOT EXISTS vec_embeddings_quarantine (
			rowid TEXT PRIMARY KEY,
			dimensions INTEGER NOT NULL,
			reason TEXT NOT NULL,
			quarantinedAt TEXT NOT NULL
		)
	`);
}

function decodeBackfillVector(
	vector: unknown,
	expectedDimensions: number,
): { readonly vector: Float32Array } | { readonly reason: string } {
	if (vector === null || vector === undefined) return { reason: "embedding blob is NULL" };
	// bun:sqlite exposes BLOB columns as Uint8Array (and Buffer is a subtype),
	// while text/number values from a legacy nullable table are not decodable.
	if (!(vector instanceof Uint8Array)) return { reason: "embedding blob is not a binary buffer" };
	const expectedBytes = expectedDimensions * Float32Array.BYTES_PER_ELEMENT;
	if (vector.byteLength !== expectedBytes) {
		return {
			reason: `embedding blob has ${vector.byteLength} bytes; expected ${expectedBytes} for ${expectedDimensions} dimensions`,
		};
	}
	try {
		const decoded = new Float32Array(vector.buffer.slice(vector.byteOffset, vector.byteOffset + vector.byteLength));
		if (decoded.some((value) => !Number.isFinite(value))) {
			return { reason: "embedding vector contains a non-finite value" };
		}
		return { vector: decoded };
	} catch (error) {
		return { reason: `embedding blob could not be decoded: ${error instanceof Error ? error.message : String(error)}` };
	}
}

function ensureVecTable(db: SqliteDatabase, expectedDimensions: number): void {
	const existing = db.prepare("SELECT sql FROM sqlite_master WHERE name = 'vec_embeddings' AND type = 'table'").get() as
		| { sql: string }
		| undefined;

	if (existing) {
		if (!vecEmbeddingsSchemaNeedsRepair(existing.sql, expectedDimensions)) {
			ensureVecEmbeddingsQuarantineTable(db);
			return;
		}
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
	ensureVecEmbeddingsQuarantineTable(db);
}

function vecRowidsTableAvailable(db: SqliteWriteSurface): boolean {
	try {
		const row = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'vec_embeddings_rowids'").get();
		return row !== undefined;
	} catch {
		return false;
	}
}

function hasMissingVecEmbeddings(db: SqliteWriteSurface, expectedDimensions: number): boolean {
	try {
		const targetTable = vecRowidsTableAvailable(db) ? "vec_embeddings_rowids" : "vec_embeddings";
		return (
			db
				.prepare(
					`SELECT 1 FROM embeddings e
					 LEFT JOIN ${targetTable} v ON v.id = e.id
					 LEFT JOIN vec_embeddings_quarantine q ON q.rowid = e.id
					 WHERE v.id IS NULL AND q.rowid IS NULL AND e.dimensions = ? LIMIT 1`,
				)
				.get(expectedDimensions) !== undefined
		);
	} catch {
		return false;
	}
}

const VEC_EMBEDDING_BACKFILL_BATCH_SIZE = 10_000;
// The migration reserve is 5s, leaving a 60s post-ready work window.
export const VEC_EMBEDDING_POST_READY_BUDGET_MS = 65_000;

let pendingVecBackfillDimensions: number | null = null;

function missingVecEmbeddingsRows(
	db: SqliteWriteSurface,
	expectedDimensions: number,
	lastId: string,
	limit: number,
): Array<{ id: string; vector: unknown }> {
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
			 LEFT JOIN vec_embeddings_quarantine q ON q.rowid = e.id
			 WHERE v.id IS NULL AND q.rowid IS NULL AND e.dimensions = ? AND e.id > ?
			 ORDER BY e.id LIMIT ?`,
		)
		.all(expectedDimensions, lastId, limit) as Array<{ id: string; vector: unknown }>;
}

export interface VecBackfillOptions {
	readonly maxBatches?: number;
	/** Bound one synchronous writer turn so the daemon can yield between slices. */
	readonly batchSize?: number;
	/** Optional log sinks for callers whose stdout is a protocol channel. */
	readonly log?: (message: string) => void;
	readonly warn?: (message: string) => void;
}

export function backfillVecEmbeddings(
	db: SqliteWriteSurface,
	expectedDimensions: number,
	deadlineAt?: number,
	options: VecBackfillOptions = {},
): void {
	const log = options.log ?? console.error;
	const warn = options.warn ?? console.warn;
	// Keep quarantine state durable across restarts and exclude it from every
	// subsequent pending probe. The table contains IDs and diagnostics only.
	ensureVecEmbeddingsQuarantineTable(db);
	// Directly query for missing rows instead of comparing counts.
	// Count comparison is racy — a row can exist in embeddings but not
	// vec_embeddings even when counts match (e.g. after a crash mid-sync).
	const batchSize = Math.max(
		1,
		Math.min(options.batchSize ?? VEC_EMBEDDING_BACKFILL_BATCH_SIZE, VEC_EMBEDDING_BACKFILL_BATCH_SIZE),
	);
	const insert = db.prepare("INSERT OR REPLACE INTO vec_embeddings (id, embedding) VALUES (?, ?)");
	const quarantine = db.prepare(
		"INSERT OR IGNORE INTO vec_embeddings_quarantine (rowid, dimensions, reason, quarantinedAt) VALUES (?, ?, ?, ?)",
	);
	let lastId = "";
	let migrated = 0;
	let totalRows = 0;
	let batches = 0;
	let deferred = false;
	let lastBatchSize = batchSize;
	let remainingRowsAtLeast = 0;
	const stopForBudget = (error: unknown, remainingHint = 1): boolean => {
		if (!(error instanceof MigrationBackupAdmissionError) || error.reason !== "throughput") throw error;
		deferred = true;
		pendingVecBackfillDimensions = expectedDimensions;
		remainingRowsAtLeast = remainingHint;
		return true;
	};
	for (;;) {
		// Keep both the anti-join and the transaction inside the startup budget.
		if (options.maxBatches !== undefined && batches >= options.maxBatches) {
			if (lastBatchSize < batchSize) break;
			deferred = true;
			pendingVecBackfillDimensions = expectedDimensions;
			remainingRowsAtLeast = 1;
			break;
		}
		try {
			assertMigrationStartupBudget(deadlineAt, "vector embedding backfill batch");
		} catch (error) {
			if (stopForBudget(error)) break;
			throw error;
		}
		const rows = missingVecEmbeddingsRows(db, expectedDimensions, lastId, batchSize);
		if (rows.length === 0) break;
		lastBatchSize = rows.length;
		batches++;
		totalRows += rows.length;
		let batchLastId = lastId;
		let processedRows = 0;
		try {
			db.exec("BEGIN");
			for (const [index, row] of rows.entries()) {
				if (index % 100 === 0) assertMigrationStartupBudget(deadlineAt, "vector embedding backfill");
				const decoded = decodeBackfillVector(row.vector, expectedDimensions);
				if ("reason" in decoded) {
					const reason = decoded.reason.slice(0, 1_000);
					const result = quarantine.run(row.id, expectedDimensions, reason, new Date().toISOString());
					if (result.changes > 0) {
						// Log once per validated malformed row; retries do not spam logs.
						warn(`[db-accessor] Quarantined malformed embedding row ${row.id}: ${reason}`);
					}
				} else {
					// Insert failures are operational errors (for example, SQLITE_BUSY).
					// Let the outer transaction handler roll back and let the caller retry;
					// only validated data-shape failures enter durable quarantine.
					insert.run(row.id, decoded.vector);
					migrated++;
				}
				batchLastId = row.id;
				processedRows++;
			}
			db.exec("COMMIT");
			lastId = batchLastId;
		} catch (e) {
			if (e instanceof MigrationBackupAdmissionError && e.reason === "throughput") {
				// The budget fence can fire inside a large transaction. Commit the
				// durable prefix instead of rolling it back and retrying the same rows
				// forever; the keyset cursor resumes after this committed row.
				try {
					db.exec("COMMIT");
				} catch (commitError) {
					try {
						db.exec("ROLLBACK");
					} catch {
						// Preserve the commit failure.
					}
					throw commitError;
				}
				lastId = batchLastId;
				stopForBudget(e, Math.max(1, rows.length - processedRows));
				break;
			}
			try {
				db.exec("ROLLBACK");
			} catch {
				// Rollback failed — transaction already closed or rolled back
			}
			throw e;
		}
		if (rows.length < batchSize) break;
	}

	if (migrated > 0) {
		log(`[db-accessor] Backfilled ${migrated}/${totalRows} missing embeddings into vec_embeddings`);
	}
	if (deferred) {
		warn(
			`[db-accessor] Deferred vector embedding backfill after ${migrated} rows; remaining rows at least ${remainingRowsAtLeast} will be completed post-ready`,
		);
		return;
	}

	try {
		assertMigrationStartupBudget(deadlineAt, "vector embedding cleanup");
	} catch (error) {
		if (stopForBudget(error, 0)) return;
		throw error;
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
			log(`[db-accessor] Cleaned ${orphanCount} orphaned vec_embeddings rows`);
		}
	} catch {
		// vec_embeddings may not exist — non-fatal
	}
	pendingVecBackfillDimensions = null;
}

export function hasPendingVecBackfill(): boolean {
	return pendingVecBackfillDimensions !== null;
}

export function pendingVecBackfillDimensionsValue(): number | null {
	return pendingVecBackfillDimensions;
}

export function continuePendingVecBackfill(
	db: SqliteWriteSurface,
	deadlineAt = Date.now() + VEC_EMBEDDING_POST_READY_BUDGET_MS,
): void {
	const dimensions = pendingVecBackfillDimensions;
	if (dimensions === null) return;
	backfillVecEmbeddings(db, dimensions, deadlineAt);
}

// ---------------------------------------------------------------------------
// Accessor factory
// ---------------------------------------------------------------------------

const READ_POOL_SIZE = 4;
export const MAX_READ_CONNECTIONS = 16;
export const MAX_READ_WAITERS = 64;
export const DEFAULT_READ_WAIT_TIMEOUT_MS = 5_000;
export const MAX_WRITE_QUEUE = 64;

type WriteJob<T> = {
	readonly run: () => T;
	readonly queuedAt: number;
	readonly operation: string;
	readonly deadlineAt: number | null;
	readonly estimatedWorkUnits: number | null;
	readonly signal: AbortSignal | undefined;
	readonly onAbort: () => void;
	readonly transactional: boolean;
	cancellation: "pending" | "requested" | "started";
	readonly resolve: (value: T | PromiseLike<T>) => void;
	readonly reject: (reason?: unknown) => void;
};

type ReadWaiter = {
	readonly enqueuedAt: number;
	readonly operation: string;
	readonly timeoutMs: number;
	readonly signal: AbortSignal | undefined;
	readonly resolve: (lease: { readonly conn: SqliteDatabase; readonly waitMs: number }) => void;
	readonly reject: (reason?: unknown) => void;
	readonly onAbort: () => void;
	readonly timer: ReturnType<typeof setTimeout>;
};

function yieldToEventLoop(): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, 0));
}

function createAccessor(writeConn: SqliteDatabase): RuntimeDbAccessor {
	let closed = false;
	let writeDraining = false;
	let writeActive = false;
	let lastWriteDurationMs: number | null = null;
	let lastWriteQueueWaitMs: number | null = null;
	let writeRejected = 0;
	let writeCancelled = 0;
	let writeTimedOut = 0;
	const writeQueue: WriteJob<unknown>[] = [];
	// Small pool of reusable read connections. Recall does 3 reads per
	// request so opening/closing every time adds measurable overhead.
	const readPool: SqliteDatabase[] = [];
	const readInUse = new Set<SqliteDatabase>();
	const readWaiters: ReadWaiter[] = [];
	let lastReadWaitMs: number | null = null;
	let readRejected = 0;
	let readSyncRejected = 0;
	let readCancelled = 0;
	let readTimedOut = 0;

	function updateQueueTelemetry(): void {
		const oldestRead = readWaiters[0];
		const oldestWrite = writeQueue[0];
		setDbQueueTelemetry({
			readDepth: readWaiters.length,
			readMaxDepth: MAX_READ_WAITERS,
			readOldestAgeMs: oldestRead ? Math.max(0, performance.now() - oldestRead.enqueuedAt) : null,
			readActiveLeases: readInUse.size,
			writeDepth: writeQueue.length,
			writeMaxDepth: MAX_WRITE_QUEUE,
			writeOldestAgeMs: oldestWrite ? Math.max(0, performance.now() - oldestWrite.queuedAt) : null,
			writeActive,
		});
	}

	function openReadConnection(): SqliteDatabase {
		if (dbPath === null) throw new Error("DbAccessor not initialised");
		const conn = new (getDatabaseConstructor())(dbPath, { readonly: true });
		conn.exec("PRAGMA busy_timeout = 5000");
		loadVecExtension(conn);
		readInUse.add(conn);
		updateQueueTelemetry();
		return conn;
	}

	function acquireReadSync(operation: string): SqliteDatabase {
		const pooled = readPool.pop();
		if (pooled) {
			readInUse.add(pooled);
			updateQueueTelemetry();
			return pooled;
		}
		if (readInUse.size >= MAX_READ_CONNECTIONS) {
			readRejected++;
			readSyncRejected++;
			recordDbOperation({
				owner: "read",
				operation,
				durationMs: 0,
				queueWaitMs: 0,
				queueDepth: readWaiters.length,
				queueAgeMs: readWaiters[0] ? performance.now() - readWaiters[0].enqueuedAt : null,
				estimatedWorkUnits: null,
				outcome: "rejected",
			});
			throw new DbReadAdmissionRejectedError(operation);
		}
		return openReadConnection();
	}

	function acquireRead(
		options: ReadAdmissionOptions = {},
	): Promise<{ readonly conn: SqliteDatabase; readonly waitMs: number }> {
		const operation = options.operation ?? "db.read";
		const timeoutMs =
			typeof options.timeoutMs === "number" && Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
				? options.timeoutMs
				: DEFAULT_READ_WAIT_TIMEOUT_MS;
		if (closed) return Promise.reject(new Error("DbAccessor is closed"));
		if (options.signal?.aborted) {
			readCancelled++;
			recordDbOperation({
				owner: "read",
				operation,
				durationMs: 0,
				queueWaitMs: 0,
				queueDepth: readWaiters.length,
				queueAgeMs: null,
				estimatedWorkUnits: null,
				outcome: "cancelled",
			});
			return Promise.reject(new DbReadAdmissionCancelledError());
		}
		const pooled = readPool.pop();
		if (pooled) {
			readInUse.add(pooled);
			updateQueueTelemetry();
			return Promise.resolve({ conn: pooled, waitMs: 0 });
		}
		if (readInUse.size < MAX_READ_CONNECTIONS) return Promise.resolve({ conn: openReadConnection(), waitMs: 0 });
		if (readWaiters.length >= MAX_READ_WAITERS) {
			readRejected++;
			recordDbOperation({
				owner: "read",
				operation,
				durationMs: 0,
				queueWaitMs: 0,
				queueDepth: readWaiters.length,
				queueAgeMs: readWaiters[0] ? performance.now() - readWaiters[0].enqueuedAt : null,
				estimatedWorkUnits: null,
				outcome: "rejected",
			});
			return Promise.reject(new DbReadQueueFullError());
		}

		return new Promise((resolve, reject) => {
			let settled = false;
			const enqueuedAt = performance.now();
			const waiter = {} as ReadWaiter;
			const rejectQueued = (error: Error, outcome: DbOperationOutcome): void => {
				if (settled) return;
				settled = true;
				const index = readWaiters.indexOf(waiter);
				if (index >= 0) readWaiters.splice(index, 1);
				if (outcome === "cancelled") readCancelled++;
				else readTimedOut++;
				const waitMs = Math.max(0, performance.now() - enqueuedAt);
				recordDbOperation({
					owner: "read",
					operation,
					durationMs: 0,
					queueWaitMs: waitMs,
					queueDepth: readWaiters.length,
					queueAgeMs: waitMs,
					estimatedWorkUnits: null,
					outcome,
				});
				clearTimeout(waiter.timer);
				options.signal?.removeEventListener("abort", waiter.onAbort);
				reject(error);
				updateQueueTelemetry();
			};
			const onAbort = (): void => rejectQueued(new DbReadAdmissionCancelledError(), "cancelled");
			const timer = setTimeout(() => rejectQueued(new DbReadAdmissionTimeoutError(timeoutMs), "timed_out"), timeoutMs);
			Object.assign(waiter, {
				enqueuedAt,
				operation,
				timeoutMs,
				signal: options.signal,
				resolve,
				reject,
				onAbort,
				timer,
			});
			readWaiters.push(waiter);
			options.signal?.addEventListener("abort", onAbort, { once: true });
			updateQueueTelemetry();
		});
	}

	function releaseRead(conn: SqliteDatabase): void {
		readInUse.delete(conn);
		const waiter = readWaiters.shift();
		if (waiter) {
			clearTimeout(waiter.timer);
			waiter.signal?.removeEventListener("abort", waiter.onAbort);
			const waitMs = Math.max(0, performance.now() - waiter.enqueuedAt);
			lastReadWaitMs = waitMs;
			readInUse.add(conn);
			waiter.resolve({ conn, waitMs });
			updateQueueTelemetry();
			return;
		}
		if (readPool.length < READ_POOL_SIZE) readPool.push(conn);
		else conn.close();
		updateQueueTelemetry();
	}

	function runWriteOperation<T>(
		fn: () => T,
		meta: {
			readonly operation: string;
			readonly queuedAt?: number;
			readonly queueDepth?: number;
			readonly queueAgeMs?: number | null;
			readonly estimatedWorkUnits?: number | null;
		},
	): T {
		const startedAt = performance.now();
		let outcome: DbOperationOutcome = "completed";
		try {
			return fn();
		} catch (error) {
			outcome = "failed";
			throw error;
		} finally {
			lastWriteDurationMs = performance.now() - startedAt;
			lastWriteQueueWaitMs = meta.queuedAt === undefined ? 0 : Math.max(0, startedAt - meta.queuedAt);
			observeDbLatency(lastWriteDurationMs);
			recordDbOperation({
				owner: "write",
				operation: meta.operation,
				durationMs: lastWriteDurationMs,
				queueWaitMs: lastWriteQueueWaitMs,
				queueDepth: meta.queueDepth ?? writeQueue.length,
				queueAgeMs: meta.queueAgeMs ?? (meta.queuedAt === undefined ? null : lastWriteQueueWaitMs),
				estimatedWorkUnits: meta.estimatedWorkUnits ?? null,
				outcome,
			});
		}
	}

	type WriteOperationMeta = Parameters<typeof runWriteOperation>[1];

	function runWriteTx<T>(fn: (db: WriteDb) => T, meta: WriteOperationMeta = { operation: "db.write" }): T {
		assertDatabaseIntegrityWritesAllowed();
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
		}, meta);
	}

	function runCheckpointWal(): void {
		assertDatabaseIntegrityWritesAllowed();
		writeConn.exec("PRAGMA wal_checkpoint(TRUNCATE)");
	}

	function runIncrementalVacuum(): number {
		assertDatabaseIntegrityWritesAllowed();
		writeConn.exec("PRAGMA incremental_vacuum");
		const row = writeConn.prepare("PRAGMA freelist_count").get() as { freelist_count?: number } | undefined;
		return typeof row?.freelist_count === "number" ? row.freelist_count : 0;
	}

	function runVacuumConversion(): boolean {
		assertDatabaseIntegrityWritesAllowed();
		return convertToIncrementalVacuum(toMigrationDb(writeConn), { dbPath: dbPath ?? undefined });
	}

	function enqueueWrite<T>(run: () => T, options: WriteAdmissionOptions = {}, transactional = true): Promise<T> {
		const operation = options.operation ?? "db.write";
		if (closed) return Promise.reject(new Error("DbAccessor is closed"));
		if (options.signal?.aborted) {
			writeCancelled++;
			recordDbOperation({
				owner: "write",
				operation,
				durationMs: 0,
				queueWaitMs: 0,
				queueDepth: writeQueue.length,
				queueAgeMs: null,
				estimatedWorkUnits: options.estimatedWorkUnits ?? null,
				outcome: "cancelled",
			});
			return Promise.reject(new DbWriteAdmissionCancelledError());
		}
		if (writeQueue.length >= MAX_WRITE_QUEUE) {
			writeRejected++;
			recordDbOperation({
				owner: "write",
				operation,
				durationMs: 0,
				queueWaitMs: 0,
				queueDepth: writeQueue.length,
				queueAgeMs: writeQueue[0] ? performance.now() - writeQueue[0].queuedAt : null,
				estimatedWorkUnits: options.estimatedWorkUnits ?? null,
				outcome: "rejected",
			});
			return Promise.reject(new DbWriteQueueFullError());
		}
		return new Promise<T>((resolve, reject) => {
			const queuedAt = performance.now();
			const job = {} as WriteJob<unknown>;
			const onAbort = (): void => {
				const index = writeQueue.indexOf(job);
				if (index < 0) {
					job.cancellation = "requested";
					return;
				}
				writeQueue.splice(index, 1);
				job.cancellation = "requested";
				writeCancelled++;
				const waitMs = Math.max(0, performance.now() - queuedAt);
				recordDbOperation({
					owner: "write",
					operation,
					durationMs: 0,
					queueWaitMs: waitMs,
					queueDepth: writeQueue.length,
					queueAgeMs: waitMs,
					estimatedWorkUnits: job.estimatedWorkUnits,
					outcome: "cancelled",
				});
				reject(new DbWriteAdmissionCancelledError());
				updateQueueTelemetry();
			};
			Object.assign(job, {
				run,
				queuedAt,
				operation,
				deadlineAt:
					typeof options.deadlineMs === "number" && Number.isFinite(options.deadlineMs) && options.deadlineMs > 0
						? queuedAt + options.deadlineMs
						: null,
				estimatedWorkUnits:
					typeof options.estimatedWorkUnits === "number" && Number.isFinite(options.estimatedWorkUnits)
						? Math.max(0, options.estimatedWorkUnits)
						: null,
				signal: options.signal,
				onAbort,
				transactional,
				cancellation: "pending",
				resolve: (value: T | PromiseLike<T>) => resolve(value),
				reject,
			});
			writeQueue.push(job);
			options.signal?.addEventListener("abort", onAbort, { once: true });
			updateQueueTelemetry();
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
				updateQueueTelemetry();
				return;
			}
			job.signal?.removeEventListener("abort", job.onAbort);
			if (closed) {
				job.reject(new Error("DbAccessor is closed"));
				void yieldToEventLoop().then(next);
				return;
			}
			const now = performance.now();
			if (job.signal?.aborted) {
				job.cancellation = "requested";
				writeCancelled++;
				job.reject(new DbWriteAdmissionCancelledError());
				void yieldToEventLoop().then(next);
				return;
			}
			if (job.deadlineAt !== null && now >= job.deadlineAt) {
				writeTimedOut++;
				recordDbOperation({
					owner: "write",
					operation: job.operation,
					durationMs: 0,
					queueWaitMs: Math.max(0, now - job.queuedAt),
					queueDepth: writeQueue.length,
					queueAgeMs: Math.max(0, now - job.queuedAt),
					estimatedWorkUnits: job.estimatedWorkUnits,
					outcome: "timed_out",
				});
				job.reject(new DbWriteAdmissionTimeoutError());
				void yieldToEventLoop().then(next);
				return;
			}
			job.cancellation = "started";
			writeActive = true;
			updateQueueTelemetry();
			try {
				job.resolve(
					job.transactional
						? runWriteTx(() => job.run(), {
								operation: job.operation,
								queuedAt: job.queuedAt,
								queueDepth: writeQueue.length,
								queueAgeMs: Math.max(0, now - job.queuedAt),
								estimatedWorkUnits: job.estimatedWorkUnits,
							})
						: runWriteOperation(job.run, {
								operation: job.operation,
								queuedAt: job.queuedAt,
								queueDepth: writeQueue.length,
								queueAgeMs: Math.max(0, now - job.queuedAt),
								estimatedWorkUnits: job.estimatedWorkUnits,
							}),
				);
			} catch (err) {
				job.reject(err);
			} finally {
				writeActive = false;
			}
			updateQueueTelemetry();
			if (writeQueue.length > 0) void yieldToEventLoop().then(next);
			else {
				writeDraining = false;
				updateQueueTelemetry();
			}
		};
		void yieldToEventLoop().then(next);
	}

	return {
		withWriteTx<T>(fn: (db: WriteDb) => T, siteToken?: SyncDbCallSiteToken): T {
			if (closed) throw new Error("DbAccessor is closed");
			const attribution = beginSyncDbCall("withWriteTx", Date.now(), siteToken);
			try {
				return runWriteTx(fn);
			} finally {
				endSyncDbCall(attribution);
			}
		},

		withWriteTxAsync<T>(fn: (db: WriteDb) => T, options?: WriteAdmissionOptions): Promise<T> {
			return enqueueWrite(() => {
				const attribution = beginSyncDbCall("withWriteTxAsync", Date.now(), options?.siteToken);
				try {
					return fn(writeConn);
				} finally {
					endSyncDbCall(attribution);
				}
			}, options);
		},

		withWriteDbAsync<T>(fn: (db: WriteDb) => T, options?: WriteAdmissionOptions): Promise<T> {
			return enqueueWrite(
				() => {
					const attribution = beginSyncDbCall("withWriteDbAsync", Date.now(), options?.siteToken);
					try {
						assertDatabaseIntegrityWritesAllowed();
						return fn(writeConn);
					} finally {
						endSyncDbCall(attribution);
					}
				},
				options,
				false,
			);
		},

		checkpointWalAsync(options?: WriteAdmissionOptions): Promise<void> {
			return enqueueWrite(
				() => {
					const attribution = beginSyncDbCall("checkpointWalAsync", Date.now(), options?.siteToken);
					try {
						return runCheckpointWal();
					} finally {
						endSyncDbCall(attribution);
					}
				},
				{ ...options, operation: options?.operation ?? "db.checkpoint_wal" },
				false,
			);
		},

		incrementalVacuumAsync(options?: WriteAdmissionOptions): Promise<number> {
			return enqueueWrite(
				() => {
					const attribution = beginSyncDbCall("incrementalVacuumAsync", Date.now(), options?.siteToken);
					try {
						return runIncrementalVacuum();
					} finally {
						endSyncDbCall(attribution);
					}
				},
				{ ...options, operation: options?.operation ?? "db.incremental_vacuum" },
				false,
			);
		},

		vacuumConversionAsync(options?: WriteAdmissionOptions): Promise<boolean> {
			return enqueueWrite(
				() => {
					const attribution = beginSyncDbCall("vacuumConversionAsync", Date.now(), options?.siteToken);
					try {
						return runVacuumConversion();
					} finally {
						endSyncDbCall(attribution);
					}
				},
				{ ...options, operation: options?.operation ?? "db.vacuum_conversion" },
				false,
			);
		},

		checkpointWal(): void {
			if (closed) throw new Error("DbAccessor is closed");
			runWriteOperation(runCheckpointWal, { operation: "db.checkpoint_wal" });
		},

		incrementalVacuum(): number {
			if (closed) throw new Error("DbAccessor is closed");
			return runWriteOperation(runIncrementalVacuum, { operation: "db.incremental_vacuum" });
		},

		vacuumConversion(): boolean {
			if (closed) throw new Error("DbAccessor is closed");
			return runWriteOperation(runVacuumConversion, { operation: "db.vacuum_conversion" });
		},

		getWritePressure(): WritePressure {
			const oldest = writeQueue[0];
			return {
				queued: writeQueue.length,
				maxQueue: MAX_WRITE_QUEUE,
				oldestWaitMs: oldest ? Math.max(0, performance.now() - oldest.queuedAt) : null,
				lastDurationMs: lastWriteDurationMs,
				active: writeActive,
				oldestOperation: oldest?.operation ?? null,
				rejected: writeRejected,
				cancelled: writeCancelled,
				timedOut: writeTimedOut,
				lastQueueWaitMs: lastWriteQueueWaitMs,
			};
		},

		getReadPressure(): ReadPressure {
			const oldest = readWaiters[0];
			return {
				activeLeases: readInUse.size,
				maxConnections: MAX_READ_CONNECTIONS,
				queued: readWaiters.length,
				maxQueue: MAX_READ_WAITERS,
				oldestWaitMs: oldest ? Math.max(0, performance.now() - oldest.enqueuedAt) : null,
				lastWaitMs: lastReadWaitMs,
				rejected: readRejected,
				syncRejected: readSyncRejected,
				cancelled: readCancelled,
				timedOut: readTimedOut,
			};
		},

		getDbRuntimePressure(): DbRuntimePressure {
			updateQueueTelemetry();
			const self = this as unknown as { getWritePressure: () => WritePressure; getReadPressure: () => ReadPressure };
			return { writer: self.getWritePressure(), reader: self.getReadPressure(), runtime: getDbRuntimeMetrics() };
		},

		withReadDb<T>(fn: (db: ReadDb) => T, siteToken?: SyncDbCallSiteToken): T {
			if (closed) throw new Error("DbAccessor is closed");
			const attribution = beginSyncDbCall("withReadDb", Date.now(), siteToken);
			const startedAt = performance.now();
			let conn: SqliteDatabase | null = null;
			let outcome: DbOperationOutcome = "completed";
			try {
				conn = acquireReadSync("db.read.sync");
				return fn(conn);
			} catch (error) {
				outcome = "failed";
				throw error;
			} finally {
				endSyncDbCall(attribution);
				if (conn !== null) releaseRead(conn);
				const durationMs = performance.now() - startedAt;
				observeDbLatency(durationMs);
				recordDbOperation({
					owner: "read",
					operation: "db.read.sync",
					durationMs,
					queueWaitMs: 0,
					queueDepth: readWaiters.length,
					queueAgeMs: null,
					estimatedWorkUnits: null,
					outcome,
				});
			}
		},

		async withReadDbAsync<T>(fn: (db: ReadDb) => T | Promise<T>, options?: ReadAdmissionOptions): Promise<T> {
			if (closed) throw new Error("DbAccessor is closed");
			const startedAt = performance.now();
			const lease = await acquireRead(options);
			let outcome: DbOperationOutcome = "completed";
			let result: T | Promise<T>;
			try {
				// Invoke the callback before releasing the lease so its synchronous
				// query work runs against the admitted connection. Do not await a
				// returned promise here: unrelated async work must not retain it.
				const attribution = beginSyncDbCall("withReadDbAsync", Date.now(), options?.siteToken);
				try {
					result = fn(lease.conn);
				} finally {
					endSyncDbCall(attribution);
				}
			} catch (error) {
				outcome = "failed";
				releaseRead(lease.conn);
				const durationMs = performance.now() - startedAt;
				lastReadWaitMs = lease.waitMs;
				observeDbLatency(durationMs);
				recordDbOperation({
					owner: "read",
					operation: options?.operation ?? "db.read",
					durationMs,
					queueWaitMs: lease.waitMs,
					queueDepth: readWaiters.length,
					queueAgeMs: lease.waitMs,
					estimatedWorkUnits: null,
					outcome,
				});
				throw error;
			}
			releaseRead(lease.conn);
			try {
				return await result;
			} catch (error) {
				outcome = "failed";
				throw error;
			} finally {
				const durationMs = performance.now() - startedAt;
				lastReadWaitMs = lease.waitMs;
				observeDbLatency(durationMs);
				recordDbOperation({
					owner: "read",
					operation: options?.operation ?? "db.read",
					durationMs,
					queueWaitMs: lease.waitMs,
					queueDepth: readWaiters.length,
					queueAgeMs: lease.waitMs,
					estimatedWorkUnits: null,
					outcome,
				});
			}
		},

		close(): void {
			if (closed) return;
			closed = true;
			writeConn.close();
			for (const conn of readPool) conn.close();
			for (const conn of readInUse) conn.close();
			for (const waiter of readWaiters) {
				clearTimeout(waiter.timer);
				waiter.signal?.removeEventListener("abort", waiter.onAbort);
				waiter.reject(new Error("DbAccessor is closed"));
			}
			readWaiters.length = 0;
			readPool.length = 0;
			readInUse.clear();
			updateQueueTelemetry();
		},
	};
}

// ---------------------------------------------------------------------------
// Public helpers
// ---------------------------------------------------------------------------

export async function runWriteTxAsync<T>(
	accessor: DbAccessor,
	fn: (db: WriteDb) => T,
	options?: WriteAdmissionOptions,
): Promise<T> {
	const siteToken = options?.siteToken ?? captureSyncDbCallSiteToken();
	// DYNAMIC_SITE_TOKEN: this helper captures its actual caller before queueing.
	return await accessor.withWriteTxAsync(fn, siteToken === undefined ? options : { ...options, siteToken });
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

/** Return the initialized database path for owner-routed helpers. */
export function getDbAccessorPath(): string {
	if (dbPath === null) throw new Error("DbAccessor not initialised — call initDbAccessor() first");
	return dbPath;
}

/** Tear down the singleton and its lazy DB-owner clients. Safe to call even if never initialised. */
export async function closeDbAccessor(): Promise<void> {
	databaseIntegrityWritesBlocked = false;
	pendingVecBackfillDimensions = null;
	const closingDbPath = dbPath;
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
	resetDbObservability();
	await closeDbAccessorParticipants(closingDbPath ?? undefined);
}

import { statSync, statfsSync } from "node:fs";
import { dirname } from "node:path";
import type { DbAccessor, ReadDb, WriteDb } from "./db-accessor";
import { logger } from "./logger";
const VACUUM_CONVERSION_TABLE = "_signet_vacuum_converted";
const VACUUM_CONVERSION_STATE_TABLE = "_signet_vacuum_conversion";
const MAX_CONVERSION_ATTEMPTS = 3;

export type DbSpaceOperation = "migration_backup" | "vacuum";

export interface DbSpaceMetrics {
	readonly dbBytes: number;
	readonly freeBytes: number | null;
	readonly requiredBytes: number;
}

export class DbSpacePreflightError extends Error {
	readonly code = "DB_SPACE_PREFLIGHT_FAILED" as const;

	constructor(
		readonly operation: DbSpaceOperation,
		readonly metrics: DbSpaceMetrics,
		cause?: unknown,
	) {
		const label = operation === "migration_backup" ? "migration backup" : "VACUUM scratch space";
		super(
			`[${operation}] ${label} blocked: insufficient disk space. Database size: ${metrics.dbBytes} bytes; free: ${metrics.freeBytes} bytes; required: ${metrics.requiredBytes} bytes. Free disk space and retry.${cause === undefined ? "" : ` Cause: ${cause instanceof Error ? cause.message : String(cause)}`}`,
			cause === undefined ? undefined : { cause },
		);
		this.name = "DbSpacePreflightError";
	}
}

export interface DbSpaceDeps {
	readonly statSync: (path: string) => { readonly size: number };
	readonly statfsSync: (path: string) => { readonly bavail: number; readonly bsize: number };
}

export interface VacuumConversionOptions {
	readonly dbPath?: string;
	readonly deps?: DbSpaceDeps;
	readonly log?: (message: string) => void;
	readonly beforeVacuum?: () => void;
}

const dbSpaceDeps: DbSpaceDeps = { statSync, statfsSync };

function isDbFullError(error: unknown): boolean {
	if (!(error instanceof Error)) return false;
	const code = "code" in error ? error.code : undefined;
	return (
		code === "ENOSPC" ||
		code === "SQLITE_FULL" ||
		error.message.includes("ENOSPC") ||
		error.message.includes("SQLITE_FULL") ||
		error.message.toLowerCase().includes("no space left on device") ||
		error.message.toLowerCase().includes("database or disk is full")
	);
}

function measureDbSpace(dbPath: string, deps: DbSpaceDeps): DbSpaceMetrics | null {
	try {
		const dbBytes = deps.statSync(dbPath).size;
		const directory = dirname(dbPath);
		const stats = deps.statfsSync(directory);
		const freeBytes =
			Number.isFinite(stats.bavail) && stats.bavail >= 0 && Number.isFinite(stats.bsize) && stats.bsize > 0
				? stats.bavail * stats.bsize
				: null;
		return { dbBytes, freeBytes, requiredBytes: dbBytes * 2 };
	} catch {
		return null;
	}
}

function assertDbSpace(operation: DbSpaceOperation, dbPath: string, deps: DbSpaceDeps): DbSpaceMetrics | null {
	const metrics = measureDbSpace(dbPath, deps);
	if (metrics && metrics.freeBytes !== null && metrics.freeBytes < metrics.requiredBytes) {
		throw new DbSpacePreflightError(operation, metrics);
	}
	return metrics;
}

const UNKNOWN_DB_SPACE_METRICS: DbSpaceMetrics = { dbBytes: 0, freeBytes: null, requiredBytes: 0 };
export interface PragmaReadDb {
	prepare(sql: string): {
		get(...args: unknown[]): Record<string, unknown> | undefined;
		all(...args: unknown[]): Record<string, unknown>[];
	};
}
export interface PragmaDb extends PragmaReadDb {
	exec(sql: string): void;
	prepare(sql: string): {
		run(...args: unknown[]): unknown;
		get(...args: unknown[]): Record<string, unknown> | undefined;
		all(...args: unknown[]): Record<string, unknown>[];
	};
}

export type VacuumConversionState = "not_required" | "pending" | "running" | "completed" | "failed";

export interface VacuumConversionStatus {
	readonly state: VacuumConversionState;
	readonly attempts: number;
	readonly maxAttempts: number;
	readonly requestedAt: string | null;
	readonly startedAt: string | null;
	readonly completedAt: string | null;
	readonly updatedAt: string | null;
	readonly lastError: string | null;
}

const STATE_TABLE_SQL = `
	CREATE TABLE IF NOT EXISTS ${VACUUM_CONVERSION_STATE_TABLE} (
		id INTEGER PRIMARY KEY CHECK (id = 1),
		state TEXT NOT NULL CHECK (state IN ('pending', 'running', 'completed', 'failed')),
		attempts INTEGER NOT NULL DEFAULT 0,
		requested_at TEXT NOT NULL,
		started_at TEXT,
		completed_at TEXT,
		updated_at TEXT NOT NULL,
		last_error TEXT
	)
`;

function now(): string {
	return new Date().toISOString();
}

function stringValue(value: unknown): string | null {
	return typeof value === "string" && value.length > 0 ? value : null;
}

function numberValue(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;
}

function hasTable(db: PragmaReadDb, name: string): boolean {
	return db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").all(name).length > 0;
}

function getAutoVacuumMode(db: PragmaReadDb): number {
	const row = db.prepare("PRAGMA auto_vacuum").get() as { auto_vacuum?: number } | undefined;
	return typeof row?.auto_vacuum === "number" ? row.auto_vacuum : 0;
}

function stateFromRow(row: Record<string, unknown> | undefined): VacuumConversionStatus {
	if (!row) {
		return {
			state: "not_required",
			attempts: 0,
			maxAttempts: MAX_CONVERSION_ATTEMPTS,
			requestedAt: null,
			startedAt: null,
			completedAt: null,
			updatedAt: null,
			lastError: null,
		};
	}
	const rawState = row.state;
	const state: VacuumConversionState =
		rawState === "pending" || rawState === "running" || rawState === "completed" || rawState === "failed"
			? rawState
			: "failed";
	return {
		state,
		attempts: numberValue(row.attempts),
		maxAttempts: MAX_CONVERSION_ATTEMPTS,
		requestedAt: stringValue(row.requested_at),
		startedAt: stringValue(row.started_at),
		completedAt: stringValue(row.completed_at),
		updatedAt: stringValue(row.updated_at),
		lastError: stringValue(row.last_error),
	};
}

function readStateRow(db: PragmaReadDb): Record<string, unknown> | undefined {
	if (!hasTable(db, VACUUM_CONVERSION_STATE_TABLE)) return undefined;
	return db.prepare(`SELECT * FROM ${VACUUM_CONVERSION_STATE_TABLE} WHERE id = 1`).get();
}

function readStatusFromDb(db: PragmaReadDb): VacuumConversionStatus {
	return stateFromRow(readStateRow(db));
}

function toPragmaReadDb(db: ReadDb): PragmaReadDb {
	return {
		prepare(sql: string) {
			const stmt = db.prepare(sql);
			return {
				get(...args: unknown[]): Record<string, unknown> | undefined {
					return stmt.get(...args);
				},
				all(...args: unknown[]): Record<string, unknown>[] {
					return stmt.all<Record<string, unknown>>(...args);
				},
			};
		},
	};
}

function toPragmaDb(db: WriteDb): PragmaDb {
	return {
		exec(sql: string): void {
			db.exec(sql);
		},
		prepare(sql: string) {
			const stmt = db.prepare(sql);
			return {
				run(...args: unknown[]): unknown {
					return stmt.run(...args);
				},
				get(...args: unknown[]): Record<string, unknown> | undefined {
					return stmt.get(...args);
				},
				all(...args: unknown[]): Record<string, unknown>[] {
					return stmt.all<Record<string, unknown>>(...args);
				},
			};
		},
	};
}

function writeState(
	db: PragmaDb,
	state: "pending" | "running" | "completed" | "failed",
	fields: {
		readonly attempts: number;
		readonly requestedAt: string;
		readonly startedAt: string | null;
		readonly completedAt: string | null;
		readonly lastError: string | null;
	},
): void {
	const updatedAt = now();
	db.prepare(
		`INSERT INTO ${VACUUM_CONVERSION_STATE_TABLE}
			(id, state, attempts, requested_at, started_at, completed_at, updated_at, last_error)
			VALUES (1, ?, ?, ?, ?, ?, ?, ?)
			ON CONFLICT(id) DO UPDATE SET
				state = excluded.state,
				attempts = excluded.attempts,
				requested_at = excluded.requested_at,
				started_at = excluded.started_at,
				completed_at = excluded.completed_at,
				updated_at = excluded.updated_at,
				last_error = excluded.last_error`,
	).run(state, fields.attempts, fields.requestedAt, fields.startedAt, fields.completedAt, updatedAt, fields.lastError);
}
export function ensureVacuumConversionState(db: PragmaDb): VacuumConversionStatus {
	db.exec(STATE_TABLE_SQL);
	const mode = getAutoVacuumMode(db);
	const legacyMarker = hasTable(db, VACUUM_CONVERSION_TABLE);
	const existing = stateFromRow(readStateRow(db));

	if (mode === 2 || legacyMarker) {
		if (existing.state !== "completed") {
			writeState(db, "completed", {
				attempts: existing.attempts,
				requestedAt: existing.requestedAt ?? now(),
				startedAt: existing.startedAt,
				completedAt: existing.completedAt ?? now(),
				lastError: null,
			});
		}
		return readStatusFromDb(db);
	}

	if (existing.state === "running") {
		const interruptedState = existing.attempts >= MAX_CONVERSION_ATTEMPTS ? "failed" : "pending";
		writeState(db, interruptedState, {
			attempts: existing.attempts,
			requestedAt: existing.requestedAt ?? now(),
			startedAt: null,
			completedAt: null,
			lastError:
				existing.attempts >= MAX_CONVERSION_ATTEMPTS
					? "Conversion attempt budget exhausted after an interrupted conversion"
					: "Previous conversion did not complete; retrying after restart",
		});
	} else if (existing.state === "failed" && existing.attempts < MAX_CONVERSION_ATTEMPTS) {
		writeState(db, "pending", {
			attempts: existing.attempts,
			requestedAt: existing.requestedAt ?? now(),
			startedAt: null,
			completedAt: null,
			lastError: existing.lastError,
		});
	} else if (existing.state === "not_required") {
		writeState(db, "pending", {
			attempts: 0,
			requestedAt: now(),
			startedAt: null,
			completedAt: null,
			lastError: null,
		});
	}

	return readStatusFromDb(db);
}
export function getVacuumConversionStatus(accessor: DbAccessor): VacuumConversionStatus {
	// @ts-expect-error LEGACY_SYNC_DB_ACCESS: withReadDb migration site
	return accessor.withReadDb(
		(db: import("./db-accessor").ReadDb) => readStatusFromDb(toPragmaReadDb(db)),
		"db-vacuum.ts:303",
	);
}
export async function getVacuumConversionStatusAsync(accessor: DbAccessor): Promise<VacuumConversionStatus> {
	return await accessor.withReadDbAsync((db) => readStatusFromDb(toPragmaReadDb(db)), {
		siteToken: "db-vacuum.ts:309",
		operation: "maintenance.vacuum.status",
	});
}
export async function markVacuumConversionRunning(accessor: DbAccessor): Promise<void> {
	await accessor.withWriteTxAsync(
		(db) => {
			const state = stateFromRow(
				toPragmaReadDb(db).prepare(`SELECT * FROM ${VACUUM_CONVERSION_STATE_TABLE} WHERE id = 1`).get(),
			);
			if (state.state !== "pending") return;
			writeState(toPragmaDb(db), "running", {
				attempts: state.attempts + 1,
				requestedAt: state.requestedAt ?? now(),
				startedAt: now(),
				completedAt: null,
				lastError: null,
			});
		},
		{ siteToken: "db-vacuum.ts:315", operation: "maintenance.vacuum.mark-running" },
	);
}
export async function markVacuumConversionCompleted(accessor: DbAccessor): Promise<void> {
	await accessor.withWriteTxAsync(
		(db) => {
			const state = stateFromRow(
				toPragmaReadDb(db).prepare(`SELECT * FROM ${VACUUM_CONVERSION_STATE_TABLE} WHERE id = 1`).get(),
			);
			writeState(toPragmaDb(db), "completed", {
				attempts: state.attempts,
				requestedAt: state.requestedAt ?? now(),
				startedAt: state.startedAt,
				completedAt: now(),
				lastError: null,
			});
		},
		{ siteToken: "db-vacuum.ts:333", operation: "maintenance.vacuum.mark-completed" },
	);
}
export async function markVacuumConversionFailed(accessor: DbAccessor, message: string): Promise<void> {
	await accessor.withWriteTxAsync(
		(db) => {
			const state = stateFromRow(
				toPragmaReadDb(db).prepare(`SELECT * FROM ${VACUUM_CONVERSION_STATE_TABLE} WHERE id = 1`).get(),
			);
			writeState(toPragmaDb(db), "failed", {
				attempts: state.attempts,
				requestedAt: state.requestedAt ?? now(),
				startedAt: state.startedAt,
				completedAt: null,
				lastError: message.slice(0, 500),
			});
		},
		{ siteToken: "db-vacuum.ts:350", operation: "maintenance.vacuum.mark-failed" },
	);
}
export function getFreePageRatio(db: PragmaReadDb): number {
	const freelist = db.prepare("PRAGMA freelist_count").get() as { freelist_count?: number } | undefined;
	const pages = db.prepare("PRAGMA page_count").get() as { page_count?: number } | undefined;
	const free = typeof freelist?.freelist_count === "number" ? freelist.freelist_count : 0;
	const total = typeof pages?.page_count === "number" ? pages.page_count : 0;
	return total > 0 ? free / total : 0;
}
export function convertToIncrementalVacuum(db: PragmaDb, options: VacuumConversionOptions = {}): boolean {
	const mode = getAutoVacuumMode(db);
	const writeLog = options.log ?? ((message: string): void => logger.info("db-vacuum", message));
	if (mode === 2) return false;
	if (hasTable(db, VACUUM_CONVERSION_TABLE)) return false;

	const preflightMetrics = options.dbPath ? assertDbSpace("vacuum", options.dbPath, options.deps ?? dbSpaceDeps) : null;
	if (preflightMetrics?.freeBytes === null) {
		writeLog("VACUUM scratch free space is unknown; proceeding without the space preflight");
	}
	db.exec("PRAGMA auto_vacuum = INCREMENTAL");

	const freelistBefore = db.prepare("PRAGMA freelist_count").get() as { freelist_count?: number } | undefined;
	const freeBefore = typeof freelistBefore?.freelist_count === "number" ? freelistBefore.freelist_count : 0;

	writeLog(`Converting database to incremental auto_vacuum (current mode: ${mode}, free pages: ${freeBefore})`);
	writeLog("Running one-time VACUUM after readiness; large databases may take several minutes");

	const startedAt = Date.now();
	try {
		options.beforeVacuum?.();
		db.exec("VACUUM");
	} catch (error) {
		if (options.dbPath && isDbFullError(error)) {
			const metrics =
				measureDbSpace(options.dbPath, options.deps ?? dbSpaceDeps) ?? preflightMetrics ?? UNKNOWN_DB_SPACE_METRICS;
			throw new DbSpacePreflightError("vacuum", metrics, error);
		}
		throw error;
	}
	const elapsedMs = Date.now() - startedAt;

	const freelistAfter = db.prepare("PRAGMA freelist_count").get() as { freelist_count?: number } | undefined;
	const freeAfter = typeof freelistAfter?.freelist_count === "number" ? freelistAfter.freelist_count : 0;
	const modeAfter = getAutoVacuumMode(db);

	writeLog(
		`VACUUM complete in ${Math.round(elapsedMs / 1000)}s — free pages: ${freeBefore} -> ${freeAfter}, auto_vacuum: ${mode} -> ${modeAfter}`,
	);
	db.exec(`CREATE TABLE IF NOT EXISTS ${VACUUM_CONVERSION_TABLE} (converted_at TEXT)`);
	db.prepare(`INSERT INTO ${VACUUM_CONVERSION_TABLE} (converted_at) VALUES (?)`).run(now());
	return true;
}

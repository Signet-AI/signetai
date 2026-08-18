/**
 * SQLite free-page reclamation (#1139).
 *
 * Existing databases need a one-time VACUUM to switch from the legacy
 * auto_vacuum=0 mode to incremental mode. That rebuild can take minutes on a
 * large database, so startup only records durable work state. The conversion
 * runs after the daemon is ready and is single-flight across the worker. In
 * production the VACUUM executes in the DB-owner child so the rebuild cannot
 * block HTTP callbacks on the daemon event loop.
 */

import { statSync, statfsSync } from "node:fs";
import { dirname } from "node:path";
import type { DbAccessor, ReadDb, WriteDb } from "./db-accessor";
import type { DbOwnerClient } from "./db-owner-client";
import { dbOwnerIncrementalVacuum, dbOwnerVacuumConversion } from "./db-owner-runtime";
import { logger } from "./logger";

/** Marker table name for the one-time VACUUM conversion. */
const VACUUM_CONVERSION_TABLE = "_signet_vacuum_converted";
const VACUUM_CONVERSION_STATE_TABLE = "_signet_vacuum_conversion";
const MAX_CONVERSION_ATTEMPTS = 3;

export type DbSpaceOperation = "migration_backup" | "vacuum";

export interface DbSpaceMetrics {
	readonly dbBytes: number;
	readonly freeBytes: number;
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
	/** Test-only seam at the real VACUUM conversion boundary. */
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
		const freeBytes = stats.bavail * stats.bsize;
		// SQLite's VACUUM documentation says that as much as twice the original
		// database size may be required while the rebuilt file is in progress.
		return { dbBytes, freeBytes, requiredBytes: dbBytes * 2 };
	} catch {
		return null;
	}
}

function assertDbSpace(operation: DbSpaceOperation, dbPath: string, deps: DbSpaceDeps): DbSpaceMetrics | null {
	const metrics = measureDbSpace(dbPath, deps);
	if (metrics && metrics.freeBytes < metrics.requiredBytes) throw new DbSpacePreflightError(operation, metrics);
	return metrics;
}

const UNKNOWN_DB_SPACE_METRICS: DbSpaceMetrics = { dbBytes: 0, freeBytes: 0, requiredBytes: 0 };

/** Read-only pragma surface. */
export interface PragmaReadDb {
	prepare(sql: string): {
		get(...args: unknown[]): Record<string, unknown> | undefined;
		all(...args: unknown[]): Record<string, unknown>[];
	};
}

/** Read/write pragma surface for conversion operations. */
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

export interface VacuumConversionHandle {
	readonly running: boolean;
	stop(): void;
	run(): Promise<VacuumConversionStatus>;
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

/**
 * Create and reconcile the durable conversion state after schema migrations.
 * A killed conversion is made pending on the next boot. Failed conversions
 * retry only while the bounded attempt budget remains, preventing a crash loop.
 */
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

/** Read durable conversion state for status and readiness diagnostics. */
export function getVacuumConversionStatus(accessor: DbAccessor): VacuumConversionStatus {
	// @ts-expect-error LEGACY_SYNC_DB_ACCESS: withReadDb migration site
	return accessor.withReadDb((db: import("./db-accessor").ReadDb) => readStatusFromDb(toPragmaReadDb(db)));
}

/** Get the free-page ratio (freelist_count / page_count). */
export function getFreePageRatio(db: PragmaReadDb): number {
	const freelist = db.prepare("PRAGMA freelist_count").get() as { freelist_count?: number } | undefined;
	const pages = db.prepare("PRAGMA page_count").get() as { page_count?: number } | undefined;
	const free = typeof freelist?.freelist_count === "number" ? freelist.freelist_count : 0;
	const total = typeof pages?.page_count === "number" ? pages.page_count : 0;
	return total > 0 ? free / total : 0;
}

/**
 * One-time conversion of an existing database to incremental auto_vacuum.
 * This function must only be called by the post-ready worker. It deliberately
 * does not run from either synchronous or asynchronous DB initialization.
 */
export function convertToIncrementalVacuum(db: PragmaDb, options: VacuumConversionOptions = {}): boolean {
	const mode = getAutoVacuumMode(db);
	const writeLog = options.log ?? ((message: string): void => logger.info("db-vacuum", message));

	// 2 = INCREMENTAL. Already converted or fresh DB created after the fix.
	if (mode === 2) return false;
	if (hasTable(db, VACUUM_CONVERSION_TABLE)) return false;

	const preflightMetrics = options.dbPath ? assertDbSpace("vacuum", options.dbPath, options.deps ?? dbSpaceDeps) : null;

	// Set the desired mode BEFORE VACUUM so the rebuilt file uses it.
	db.exec("PRAGMA auto_vacuum = INCREMENTAL");

	const freelistBefore = db.prepare("PRAGMA freelist_count").get() as { freelist_count?: number } | undefined;
	const freeBefore = typeof freelistBefore?.freelist_count === "number" ? freelistBefore.freelist_count : 0;

	writeLog(`Converting database to incremental auto_vacuum (current mode: ${mode}, free pages: ${freeBefore})`);
	writeLog("Running one-time VACUUM after readiness; large databases may take several minutes");

	const startedAt = Date.now();
	try {
		// This is deliberately adjacent to the real SQLite statement, not in the
		// owner job dispatcher. Tests may pause here, proving they reached the
		// conversion boundary rather than an artificial pre-VACUUM hole.
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

	// Write marker so we never re-run VACUUM on this database.
	db.exec(`CREATE TABLE IF NOT EXISTS ${VACUUM_CONVERSION_TABLE} (converted_at TEXT)`);
	db.prepare(`INSERT INTO ${VACUUM_CONVERSION_TABLE} (converted_at) VALUES (?)`).run(now());
	return true;
}

export interface IncrementalReclaimOptions {
	readonly owner?: DbOwnerClient;
	readonly batchPages?: number;
	readonly maxBatches?: number;
	readonly onCheckpoint?: (reclaimed: number, remaining: number) => void;
}

/** Reclaim free pages in bounded, resumable batches. Conversion remains monolithic. */
export async function reclaimIncrementalVacuum(
	accessor: DbAccessor,
	opts: IncrementalReclaimOptions = {},
): Promise<{ readonly reclaimed: number; readonly remaining: number }> {
	const batchPages = Math.max(1, Math.min(10_000, Math.trunc(opts.batchPages ?? 1_000)));
	const maxBatches = Math.max(1, Math.min(100_000, Math.trunc(opts.maxBatches ?? 100_000)));
	let remaining = 0;
	// The checkpoint is durable SQLite state: a crash leaves the freelist itself
	// intact, so the next invocation resumes from the current count.
	let reclaimed = 0;
	let previousRemaining: number | null = null;
	for (let batch = 0; batch < maxBatches; batch += 1) {
		if (opts.owner) remaining = await dbOwnerIncrementalVacuum(opts.owner, batchPages);
		else {
			if (!accessor.incrementalVacuumAsync) throw new Error("incremental vacuum operation is unavailable");
			remaining = await accessor.incrementalVacuumAsync();
		}
		const progressed =
			previousRemaining === null ? Math.max(0, batchPages) : Math.max(0, previousRemaining - remaining);
		reclaimed += progressed;
		previousRemaining = remaining;
		opts.onCheckpoint?.(reclaimed, remaining);
		if (remaining <= 0 || progressed <= 0) break;
		await new Promise<void>((resolve) => setTimeout(resolve, 0));
	}
	return { reclaimed, remaining };
}

/**
 * Start the post-ready one-shot conversion worker. The timer yields once so
 * the listening callback can return and readiness can be recorded before work
 * begins.
 */
export function startVacuumConversionWorker(
	accessor: DbAccessor,
	opts: { readonly startImmediately?: boolean; readonly owner?: DbOwnerClient } = {},
): VacuumConversionHandle {
	let active = true;
	let timer: ReturnType<typeof setTimeout> | null = null;
	let inFlight: Promise<VacuumConversionStatus> | null = null;

	async function run(): Promise<VacuumConversionStatus> {
		if (inFlight) return inFlight;
		const cycle = (async (): Promise<VacuumConversionStatus> => {
			const before = getVacuumConversionStatus(accessor);
			if (before.state !== "pending" || before.attempts >= before.maxAttempts) return before;

			// @ts-expect-error LEGACY_SYNC_DB_ACCESS: withWriteTx migration site
			accessor.withWriteTx((db: import("./db-accessor").WriteDb) => {
				const state = stateFromRow(
					toPragmaReadDb(db).prepare(`SELECT * FROM ${VACUUM_CONVERSION_STATE_TABLE} WHERE id = 1`).get(),
				);
				if (state.state !== "pending") return;
				const requestedAt = state.requestedAt ?? now();
				writeState(toPragmaDb(db), "running", {
					attempts: state.attempts + 1,
					requestedAt,
					startedAt: now(),
					completedAt: null,
					lastError: null,
				});
			});

			const running = getVacuumConversionStatus(accessor);
			if (running.state !== "running") return running;
			logger.info("db-vacuum", "Post-ready conversion worker started", {
				attempt: running.attempts,
				maxAttempts: running.maxAttempts,
			});

			try {
				if (opts.owner !== undefined) {
					await dbOwnerVacuumConversion(opts.owner);
				} else {
					if (!accessor.vacuumConversionAsync) throw new Error("VACUUM conversion operation is unavailable");
					await accessor.vacuumConversionAsync();
				}
				// @ts-expect-error LEGACY_SYNC_DB_ACCESS: withWriteTx migration site
				accessor.withWriteTx((db: import("./db-accessor").WriteDb) => {
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
				});
				logger.info("db-vacuum", "Post-ready conversion worker completed");
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				// @ts-expect-error LEGACY_SYNC_DB_ACCESS: withWriteTx migration site
				accessor.withWriteTx((db: import("./db-accessor").WriteDb) => {
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
				});
				logger.error(
					"db-vacuum",
					"Post-ready conversion worker failed; retry is available on a later startup while the attempt budget remains",
					error instanceof Error ? error : undefined,
				);
			}
			return getVacuumConversionStatus(accessor);
		})();
		inFlight = cycle;
		void cycle.then(
			() => {
				if (inFlight === cycle) inFlight = null;
			},
			() => {
				if (inFlight === cycle) inFlight = null;
			},
		);
		return cycle;
	}

	if (opts.startImmediately !== false) {
		timer = setTimeout(() => {
			if (!active) return;
			void run().catch((error) => {
				logger.error("db-vacuum", "Post-ready conversion worker crashed", error instanceof Error ? error : undefined);
			});
		}, 0);
	}

	return {
		get running(): boolean {
			return active;
		},
		stop(): void {
			active = false;
			if (timer) clearTimeout(timer);
			timer = null;
		},
		run,
	};
}

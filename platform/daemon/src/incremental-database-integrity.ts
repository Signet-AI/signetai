/**
 * Checkpointed database integrity maintenance.
 *
 * SQLite's global `PRAGMA quick_check` is one synchronous native operation and
 * cannot be paused at a page boundary. The maintenance path therefore checks
 * one user table per owner job, commits its frontier, and yields back to the
 * owner queue before checking the next table. The existing global check stays
 * available to explicit operator repair flows, but is not used after readiness.
 * Every request goes through the maintenance helpers, so the owner-lane-classes
 * integration can move this work to its maintenance queue without changing the
 * checkpoint protocol.
 */

import { DbOwnerDeadlineError, type DbOwnerClient } from "./db-owner-client";
import {
	ownerQueryAll,
	ownerQueryOne,
	ownerTransaction,
	ownerRunStatement,
	type DbOwnerMaintenanceMetrics,
} from "./db-owner-maintenance";
import { updateDatabaseIntegrityStatus, type DatabaseIntegrityProgress } from "./database-integrity";

const CHECKPOINT_TABLE = "db_integrity_checkpoints";
const DEFAULT_CHECKPOINT_KEY = "database.quick-check";
const DEFAULT_TABLES_PER_RUN = 8;
const MAX_TABLES_PER_RUN = 64;
const DEFAULT_OWNER_DEADLINE_MS = 1_000;
const MAX_OWNER_DEADLINE_MS = 5_000;
const DEFAULT_RUN_BUDGET_MS = 5_000;
const MAX_RUN_BUDGET_MS = 60_000;
const DEFAULT_WORK_UNITS = 8;
const MAX_WORK_UNITS = 64;
const FTS_UNVERIFIABLE_STATUS = "degraded:fts-unverifiable" as const;
export const MIGRATION_VERIFY_PARKED_STATUS = "degraded:integrity-unverified" as const;
export const MIGRATION_VERIFY_FAILED_STATUS = "failed:integrity-unverified" as const;

export type IncrementalIntegrityPhase = "running" | "complete" | "cancelled" | "timed_out" | "unavailable" | "degraded";

const INCREMENTAL_INTEGRITY_RETRY_BASE_DELAY_MS = 1_000;
const INCREMENTAL_INTEGRITY_RETRY_MAX_DELAY_MS = 30_000;

/** Back off abandoned integrity slices so a blocked owner queue cannot self-fill. */
export function nextIncrementalIntegrityRetryDelay(phase: IncrementalIntegrityPhase, previousDelayMs: number): number {
	if (phase !== "timed_out" && phase !== "unavailable") return 0;
	const previous =
		Number.isFinite(previousDelayMs) && previousDelayMs >= INCREMENTAL_INTEGRITY_RETRY_BASE_DELAY_MS
			? previousDelayMs
			: 0;
	return Math.min(
		INCREMENTAL_INTEGRITY_RETRY_MAX_DELAY_MS,
		previous === 0 ? INCREMENTAL_INTEGRITY_RETRY_BASE_DELAY_MS : previous * 2,
	);
}

export interface IncrementalIntegrityProgress extends DatabaseIntegrityProgress {
	readonly checkpointKey: string;
	readonly phase: IncrementalIntegrityPhase;
	readonly checkedObjects: number;
	readonly failedObjects: number;
	readonly remainingObjects: number;
	readonly lastObject: string | null;
}

export interface IncrementalIntegrityResult extends IncrementalIntegrityProgress {
	readonly errors: readonly string[];
}

export interface IncrementalIntegrityOptions {
	readonly owner: DbOwnerClient;
	readonly checkpointKey?: string;
	readonly tablesPerRun?: number;
	readonly ownerDeadlineMs?: number;
	readonly runBudgetMs?: number;
	readonly maxWorkUnits?: number;
	readonly signal?: AbortSignal;
	readonly onProgress?: (progress: IncrementalIntegrityProgress) => void | Promise<void>;
	/** Test/diagnostic hook invoked after selecting an object and before scanning it. */
	readonly onObjectScan?: (object: { readonly name: string; readonly type: TableRow["type"] }) => void | Promise<void>;
	readonly onBeforeCheckpointCommit?: () => void | Promise<void>;
}

interface Checkpoint {
	readonly cursor: string;
	readonly checkedTables: number;
	readonly failedTables: number;
	readonly pagesChecked: number;
	readonly bytesChecked: number;
	readonly attemptCount: number;
	readonly status:
		| "running"
		| "complete"
		| typeof FTS_UNVERIFIABLE_STATUS
		| typeof MIGRATION_VERIFY_PARKED_STATUS
		| typeof MIGRATION_VERIFY_FAILED_STATUS;
}

interface TableRow {
	readonly name: string;
	readonly type: "table" | "index" | "view" | "trigger";
	readonly cursor: string;
	readonly sql?: string;
}

interface NumberRow {
	readonly value?: unknown;
}

interface PageCountRow {
	readonly page_count?: unknown;
	readonly page_size?: unknown;
}

interface QuickCheckRow {
	readonly quick_check?: unknown;
	readonly integrity_check?: unknown;
}

type OwnerMetricsCallback = (metrics: DbOwnerMaintenanceMetrics) => void | Promise<void>;

const TELEMETRY_INTEGRITY_CURSOR = "\uffff:telemetry_integrity";

function checkpointCursorToLastObject(cursor: string): string | null {
	if (cursor.length === 0) return null;
	if (cursor === TELEMETRY_INTEGRITY_CURSOR) return "table:telemetry_events";
	const separator = cursor.lastIndexOf(":");
	return separator < 1 || separator === cursor.length - 1
		? cursor
		: `${cursor.slice(separator + 1)}:${cursor.slice(0, separator)}`;
}

function boundedString(value: string | undefined): string {
	const key = value?.trim() || DEFAULT_CHECKPOINT_KEY;
	if (key.length > 200 || !/^[A-Za-z0-9._:-]+$/.test(key)) throw new RangeError("invalid integrity checkpoint key");
	return key;
}

function boundedPositive(value: number | undefined, defaultValue: number, maximum: number, label: string): number {
	if (value === undefined) return defaultValue;
	if (!Number.isFinite(value) || value <= 0) throw new RangeError(`${label} must be positive`);
	return Math.min(maximum, Math.floor(value));
}

function boundedTables(value: number | undefined): number {
	return boundedPositive(value, DEFAULT_TABLES_PER_RUN, MAX_TABLES_PER_RUN, "integrity table budget");
}

function boundedWorkUnits(value: number | undefined): number {
	return boundedPositive(value, DEFAULT_WORK_UNITS, MAX_WORK_UNITS, "integrity work budget");
}

function escapeIdentifier(value: string): string {
	return `"${value.replaceAll('"', '""')}"`;
}

function isUnchunkableFts(object: TableRow): boolean {
	return object.type === "table" && typeof object.sql === "string" && /\bUSING\s+fts5\s*\(/i.test(object.sql);
}

function scalar(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

function text(value: unknown): string {
	return typeof value === "string" ? value : String(value ?? "");
}

function isDeadline(error: unknown): boolean {
	return error instanceof DbOwnerDeadlineError || (error instanceof Error && error.name === "DbOwnerDeadlineError");
}

function isDuplicateColumnError(error: unknown): boolean {
	return error instanceof Error && /duplicate column name/i.test(error.message);
}

async function ensureCheckpoint(
	owner: DbOwnerClient,
	key: string,
	deadlineMs: number,
	onOwnerMetrics?: OwnerMetricsCallback,
): Promise<void> {
	await ownerTransaction(
		owner,
		"integrity.checkpoint.ensure",
		[
			ownerRunStatement(`CREATE TABLE IF NOT EXISTS ${CHECKPOINT_TABLE} (
					checkpoint_key TEXT PRIMARY KEY,
					cursor TEXT NOT NULL DEFAULT '',
					checked_tables INTEGER NOT NULL DEFAULT 0,
					failed_tables INTEGER NOT NULL DEFAULT 0,
					pages_checked INTEGER NOT NULL DEFAULT 0,
					bytes_checked INTEGER NOT NULL DEFAULT 0,
					attempt_count INTEGER NOT NULL DEFAULT 0,
					status TEXT NOT NULL DEFAULT 'running',
					updated_at TEXT NOT NULL
				)`),
		],
		{ deadlineMs, estimatedWorkUnits: 1, onOwnerMetrics },
	);
	// Upgrade the column before any statement references it: on a legacy table
	// (created before attempt_count existed) the INSERT below would otherwise
	// throw "table has no column named attempt_count" and kill integrity
	// maintenance on upgraded installs.
	const columns = await ownerQueryAll<{ readonly name?: unknown }>(
		owner,
		"integrity.checkpoint.columns",
		`PRAGMA table_info(${CHECKPOINT_TABLE})`,
		[],
		{ deadlineMs, onOwnerMetrics },
	);
	if (!columns.some((column) => column.name === "attempt_count")) {
		try {
			await ownerTransaction(
				owner,
				"integrity.checkpoint.attempt-count-column",
				[ownerRunStatement(`ALTER TABLE ${CHECKPOINT_TABLE} ADD COLUMN attempt_count INTEGER NOT NULL DEFAULT 0`)],
				{ deadlineMs, estimatedWorkUnits: 1, onOwnerMetrics },
			);
		} catch (error) {
			if (!isDuplicateColumnError(error)) throw error;
			const columnsAfterRace = await ownerQueryAll<{ readonly name?: unknown }>(
				owner,
				"integrity.checkpoint.columns.after-race",
				`PRAGMA table_info(${CHECKPOINT_TABLE})`,
				[],
				{ deadlineMs, onOwnerMetrics },
			);
			if (!columnsAfterRace.some((column) => column.name === "attempt_count")) throw error;
		}
	}
	await ownerTransaction(
		owner,
		"integrity.checkpoint.ensure",
		[
			ownerRunStatement(
				`INSERT OR IGNORE INTO ${CHECKPOINT_TABLE}
					(checkpoint_key, cursor, checked_tables, failed_tables, pages_checked, bytes_checked, attempt_count, status, updated_at)
					VALUES (?, '', 0, 0, 0, 0, 0, 'running', ?)`,
				[key, new Date().toISOString()],
			),
		],
		{ deadlineMs, estimatedWorkUnits: 1, onOwnerMetrics },
	);
}

async function readCheckpoint(
	owner: DbOwnerClient,
	key: string,
	deadlineMs: number,
	onOwnerMetrics?: OwnerMetricsCallback,
): Promise<Checkpoint> {
	const row = await ownerQueryOne<Checkpoint>(
		owner,
		"integrity.checkpoint.read",
		`SELECT cursor, checked_tables AS checkedTables, failed_tables AS failedTables,
			pages_checked AS pagesChecked, bytes_checked AS bytesChecked,
			attempt_count AS attemptCount, status
		 FROM ${CHECKPOINT_TABLE} WHERE checkpoint_key = ?`,
		[key],
		{ deadlineMs, onOwnerMetrics },
	);
	if (
		row === undefined ||
		(row.status !== "running" &&
			row.status !== "complete" &&
			row.status !== FTS_UNVERIFIABLE_STATUS &&
			row.status !== MIGRATION_VERIFY_PARKED_STATUS &&
			row.status !== MIGRATION_VERIFY_FAILED_STATUS) ||
		typeof row.attemptCount !== "number" ||
		typeof row.cursor !== "string"
	) {
		throw new Error(`integrity checkpoint ${key} is missing or invalid`);
	}
	return row;
}

async function resetCompleteCheckpoint(
	owner: DbOwnerClient,
	key: string,
	deadlineMs: number,
	onOwnerMetrics?: OwnerMetricsCallback,
): Promise<void> {
	await ownerTransaction(
		owner,
		"integrity.checkpoint.reset",
		[
			ownerRunStatement(
				`UPDATE ${CHECKPOINT_TABLE}
				 SET cursor = '', checked_tables = 0, failed_tables = 0,
				     pages_checked = 0, bytes_checked = 0, attempt_count = 0,
				     status = 'running', updated_at = ?
				 WHERE checkpoint_key = ?`,
				[new Date().toISOString(), key],
			),
		],
		{ deadlineMs, estimatedWorkUnits: 1, onOwnerMetrics },
	);
}

async function readPageMetrics(
	owner: DbOwnerClient,
	deadlineMs: () => number,
	onOwnerMetrics?: OwnerMetricsCallback,
): Promise<{ readonly pages: number; readonly bytes: number }> {
	const pageCount = await ownerQueryOne<PageCountRow>(owner, "integrity.page-count", "PRAGMA page_count", [], {
		deadlineMs: deadlineMs(),
		onOwnerMetrics,
	});
	const pageSize = await ownerQueryOne<PageCountRow>(owner, "integrity.page-size", "PRAGMA page_size", [], {
		deadlineMs: deadlineMs(),
		onOwnerMetrics,
	});
	const pages = scalar(pageCount?.page_count);
	return { pages, bytes: pages * scalar(pageSize?.page_size) };
}

async function nextObject(
	owner: DbOwnerClient,
	cursor: string,
	deadlineMs: () => number,
	onOwnerMetrics?: OwnerMetricsCallback,
): Promise<TableRow | undefined> {
	const object = await ownerQueryOne<TableRow>(
		owner,
		"integrity.objects.next",
		`SELECT name, type, sql, name || ':' || type AS cursor FROM sqlite_schema
		 WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%'
		   AND name <> ? AND (name || ':' || type) > ?
		   AND type IN ('table', 'index', 'view', 'trigger')
		 ORDER BY name, type LIMIT 1`,
		[CHECKPOINT_TABLE, cursor],
		{ deadlineMs: deadlineMs(), onOwnerMetrics },
	);
	if (object !== undefined) return object;
	if (cursor >= TELEMETRY_INTEGRITY_CURSOR) return undefined;
	const telemetry = await ownerQueryOne<{ readonly name: string }>(
		owner,
		"integrity.telemetry.exists",
		"SELECT name FROM sqlite_schema WHERE type = 'table' AND name = 'telemetry_events'",
		[],
		{ deadlineMs: deadlineMs(), onOwnerMetrics },
	);
	return telemetry === undefined
		? undefined
		: { name: "telemetry_events", type: "table", cursor: TELEMETRY_INTEGRITY_CURSOR };
}

async function remainingObjects(
	owner: DbOwnerClient,
	cursor: string,
	deadlineMs: number,
	onOwnerMetrics?: OwnerMetricsCallback,
): Promise<number> {
	const row = await ownerQueryOne<NumberRow>(
		owner,
		"integrity.objects.remaining",
		`SELECT COUNT(*) + CASE WHEN ? < ? AND EXISTS (SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'telemetry_events') THEN 1 ELSE 0 END AS value FROM sqlite_schema
		 WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%'
		   AND name <> ? AND (name || ':' || type) > ?
		   AND type IN ('table', 'index', 'view', 'trigger')`,
		[cursor, TELEMETRY_INTEGRITY_CURSOR, CHECKPOINT_TABLE, cursor],
		{ deadlineMs, onOwnerMetrics },
	);
	return scalar(row?.value);
}

async function persistTable(
	owner: DbOwnerClient,
	key: string,
	object: string,
	checkpoint: Checkpoint,
	metrics: { readonly pages: number; readonly bytes: number },
	failed: boolean,
	deadlineMs: number,
	onOwnerMetrics?: OwnerMetricsCallback,
): Promise<Checkpoint> {
	const next: Checkpoint = {
		cursor: object,
		checkedTables: checkpoint.checkedTables + 1,
		failedTables: checkpoint.failedTables + (failed ? 1 : 0),
		// PRAGMA page_count is a database-wide snapshot, not per-object work.
		// Adding it for every table multiplies the database size by the object
		// count (the 765M-page integrity report was this exact bug).
		pagesChecked: metrics.pages,
		bytesChecked: metrics.bytes,
		attemptCount: checkpoint.attemptCount,
		status: "running",
	};
	await ownerTransaction(
		owner,
		"integrity.checkpoint.commit",
		[
			ownerRunStatement(
				`UPDATE ${CHECKPOINT_TABLE}
				 SET cursor = ?, checked_tables = ?, failed_tables = ?, pages_checked = ?,
				     bytes_checked = ?, attempt_count = ?, status = 'running', updated_at = ?
				 WHERE checkpoint_key = ? AND cursor = ?`,
				[
					next.cursor,
					next.checkedTables,
					next.failedTables,
					next.pagesChecked,
					next.bytesChecked,
					next.attemptCount,
					new Date().toISOString(),
					key,
					checkpoint.cursor,
				],
			),
		],
		{ deadlineMs, estimatedWorkUnits: 1, onOwnerMetrics },
	);
	return next;
}

async function markComplete(
	owner: DbOwnerClient,
	key: string,
	deadlineMs: number,
	onOwnerMetrics?: OwnerMetricsCallback,
): Promise<void> {
	await ownerTransaction(
		owner,
		"integrity.checkpoint.complete",
		[
			ownerRunStatement(`UPDATE ${CHECKPOINT_TABLE} SET status = 'complete', updated_at = ? WHERE checkpoint_key = ?`, [
				new Date().toISOString(),
				key,
			]),
		],
		{ deadlineMs, estimatedWorkUnits: 1, onOwnerMetrics },
	);
}

async function markDegraded(
	owner: DbOwnerClient,
	key: string,
	object: string,
	checkpoint: Checkpoint,
	deadlineMs: number,
	onOwnerMetrics?: OwnerMetricsCallback,
): Promise<Checkpoint> {
	const next: Checkpoint = { ...checkpoint, cursor: object, status: FTS_UNVERIFIABLE_STATUS };
	await ownerTransaction(
		owner,
		"integrity.checkpoint.degraded",
		[
			ownerRunStatement(
				`UPDATE ${CHECKPOINT_TABLE}
				 SET cursor = ?, status = ?, updated_at = ?
				 WHERE checkpoint_key = ? AND cursor = ? AND status = 'running'`,
				[next.cursor, next.status, new Date().toISOString(), key, checkpoint.cursor],
			),
		],
		{ deadlineMs, estimatedWorkUnits: 1, onOwnerMetrics },
	);
	return next;
}

function progressFrom(
	key: string,
	phase: IncrementalIntegrityPhase,
	checkpoint: Checkpoint,
	remaining: number,
	lastObject: string | null,
	elapsedMs: number,
	ownerQueueAdmissionMs: number,
	ownerExecutionMs: number,
	cancellationReason: string | null,
	degradationReason: string | null,
): IncrementalIntegrityProgress {
	return {
		checkpointKey: key,
		phase,
		checkedObjects: checkpoint.checkedTables,
		failedObjects: checkpoint.failedTables,
		remainingObjects: remaining,
		lastObject,
		databasePagesObserved: checkpoint.pagesChecked,
		databaseBytesObserved: checkpoint.bytesChecked,
		elapsedMs,
		ownerQueueAdmissionMs,
		ownerExecutionMs,
		cancellationReason,
		degradationReason,
	};
}

/** Run at most one bounded maintenance slice and leave a durable resume point. */
export async function runIncrementalDatabaseIntegrityCheck(
	options: IncrementalIntegrityOptions,
): Promise<IncrementalIntegrityResult> {
	const key = boundedString(options.checkpointKey);
	const tablesPerRun = Math.min(boundedTables(options.tablesPerRun), boundedWorkUnits(options.maxWorkUnits));
	const ownerDeadlineMs = boundedPositive(
		options.ownerDeadlineMs,
		DEFAULT_OWNER_DEADLINE_MS,
		MAX_OWNER_DEADLINE_MS,
		"integrity owner deadline",
	);
	const runBudgetMs = boundedPositive(
		options.runBudgetMs,
		DEFAULT_RUN_BUDGET_MS,
		MAX_RUN_BUDGET_MS,
		"integrity run budget",
	);
	const startedAt = Date.now();
	let ownerQueueAdmissionMs = 0;
	let ownerExecutionMs = 0;
	const recordOwnerMetrics = (metrics: DbOwnerMaintenanceMetrics): void => {
		ownerQueueAdmissionMs += metrics.queueAdmissionMs;
		ownerExecutionMs += metrics.ownerExecutionMs;
	};
	let phase: IncrementalIntegrityPhase = "running";
	let cancellationReason: string | null = null;
	let degradationReason: string | null = null;
	let checkpoint: Checkpoint = {
		cursor: "",
		checkedTables: 0,
		failedTables: 0,
		pagesChecked: 0,
		bytesChecked: 0,
		attemptCount: 0,
		status: "running",
	};
	let lastTable: string | null = null;
	const errors: string[] = [];
	class IntegrityRunBudgetError extends Error {
		constructor() {
			super("incremental integrity run budget exhausted");
			this.name = "IntegrityRunBudgetError";
		}
	}
	const remainingBudget = (): number => {
		const remaining = runBudgetMs - (Date.now() - startedAt);
		if (remaining < 1) throw new IntegrityRunBudgetError();
		return Math.min(ownerDeadlineMs, Math.floor(remaining));
	};
	const emit = async (phase: IncrementalIntegrityPhase, reason: string | null): Promise<void> => {
		const remaining =
			phase === "degraded"
				? 0
				: await remainingObjects(options.owner, checkpoint.cursor, remainingBudget(), recordOwnerMetrics).catch(
						() => 0,
					);
		const progress = progressFrom(
			key,
			phase,
			checkpoint,
			remaining,
			lastTable,
			Date.now() - startedAt,
			ownerQueueAdmissionMs,
			ownerExecutionMs,
			reason,
			degradationReason,
		);
		updateDatabaseIntegrityStatus(progress, errors, options.owner);
		await options.onProgress?.(progress);
	};
	const progressSnapshot = async (): Promise<IncrementalIntegrityProgress> => {
		const remaining =
			phase === "degraded"
				? 0
				: await remainingObjects(options.owner, checkpoint.cursor, remainingBudget(), recordOwnerMetrics).catch(
						() => 0,
					);
		return progressFrom(
			key,
			phase,
			checkpoint,
			remaining,
			lastTable,
			Date.now() - startedAt,
			ownerQueueAdmissionMs,
			ownerExecutionMs,
			cancellationReason,
			degradationReason,
		);
	};

	try {
		await ensureCheckpoint(options.owner, key, remainingBudget(), recordOwnerMetrics);
		checkpoint = await readCheckpoint(options.owner, key, remainingBudget(), recordOwnerMetrics);
		lastTable = checkpointCursorToLastObject(checkpoint.cursor);
		if (checkpoint.status === FTS_UNVERIFIABLE_STATUS) {
			phase = "degraded";
			degradationReason = FTS_UNVERIFIABLE_STATUS;
			await emit("degraded", FTS_UNVERIFIABLE_STATUS);
			return { ...(await progressSnapshot()), errors };
		}
		if (checkpoint.status === "complete") {
			await resetCompleteCheckpoint(options.owner, key, remainingBudget(), recordOwnerMetrics);
			checkpoint = await readCheckpoint(options.owner, key, remainingBudget(), recordOwnerMetrics);
			lastTable = checkpointCursorToLastObject(checkpoint.cursor);
		}
		await emit("running", null);

		let processedInRun = 0;
		while (processedInRun < tablesPerRun) {
			if (options.signal?.aborted) {
				phase = "cancelled";
				cancellationReason = "aborted before the next table checkpoint";
				await emit("cancelled", "aborted before the next table checkpoint");
				return { ...(await progressSnapshot()), errors };
			}
			if (runBudgetMs - (Date.now() - startedAt) < 1) {
				phase = "timed_out";
				cancellationReason = "maintenance run budget exhausted at an object checkpoint";
				await emit("timed_out", cancellationReason);
				return { ...(await progressSnapshot()), errors };
			}
			const table = await nextObject(options.owner, checkpoint.cursor, remainingBudget, recordOwnerMetrics);
			if (table === undefined) {
				await markComplete(options.owner, key, remainingBudget(), recordOwnerMetrics);
				checkpoint = { ...checkpoint, status: "complete" };
				phase = "complete";
				await emit("complete", null);
				return { ...(await progressSnapshot()), errors };
			}
			lastTable = `${table.type}:${table.name}`;
			if (isUnchunkableFts(table)) {
				// SQLite's FTS5 integrity-check is one monolithic native operation;
				// it has no segment/rowid-range cursor. Persist the named park state
				// instead of re-entering the same virtual table on every slice.
				await options.onObjectScan?.(table);
				checkpoint = await markDegraded(
					options.owner,
					key,
					table.cursor,
					checkpoint,
					remainingBudget(),
					recordOwnerMetrics,
				);
				phase = "degraded";
				degradationReason = FTS_UNVERIFIABLE_STATUS;
				await emit("degraded", FTS_UNVERIFIABLE_STATUS);
				return { ...(await progressSnapshot()), errors };
			}
			await options.onObjectScan?.(table);
			const row =
				table.type === "table"
					? await ownerQueryOne<QuickCheckRow>(
							options.owner,
							`integrity.${table.type}.check`,
							table.cursor === TELEMETRY_INTEGRITY_CURSOR
								? `PRAGMA integrity_check(${escapeIdentifier(table.name)})`
								: `PRAGMA quick_check(${escapeIdentifier(table.name)})`,
							[],
							{ deadlineMs: remainingBudget(), estimatedWorkUnits: 1, onOwnerMetrics: recordOwnerMetrics },
						)
					: await ownerQueryOne<{ sql?: unknown }>(
							options.owner,
							`integrity.${table.type}.check`,
							"SELECT sql FROM sqlite_schema WHERE type = ? AND name = ?",
							[table.type, table.name],
							{ deadlineMs: remainingBudget(), estimatedWorkUnits: 1, onOwnerMetrics: recordOwnerMetrics },
						);
			let message =
				table.type === "table"
					? text((row as QuickCheckRow | undefined)?.quick_check ?? (row as QuickCheckRow | undefined)?.integrity_check)
					: (row as { sql?: unknown } | undefined)?.sql === undefined
						? ""
						: "ok";
			let failed = message !== "ok";
			if (table.cursor === TELEMETRY_INTEGRITY_CURSOR) {
				const indexes = await ownerQueryAll<{ readonly name: string }>(
					options.owner,
					"integrity.telemetry.indexes",
					"SELECT name FROM sqlite_schema WHERE type = 'index' AND tbl_name = 'telemetry_events' AND sql IS NOT NULL ORDER BY name",
					[],
					{ deadlineMs: remainingBudget(), estimatedWorkUnits: 1, onOwnerMetrics: recordOwnerMetrics },
				);
				if (failed && indexes.length > 0) {
					await ownerTransaction(
						options.owner,
						"integrity.telemetry.reindex",
						indexes.map((index) => ownerRunStatement(`REINDEX ${escapeIdentifier(index.name)}`)),
						{
							deadlineMs: remainingBudget(),
							estimatedWorkUnits: Math.min(MAX_WORK_UNITS, indexes.length + 2),
							onOwnerMetrics: recordOwnerMetrics,
						},
					);
					const verification = await ownerQueryOne<QuickCheckRow>(
						options.owner,
						"integrity.telemetry.verify",
						`PRAGMA integrity_check(${escapeIdentifier(table.name)})`,
						[],
						{ deadlineMs: remainingBudget(), estimatedWorkUnits: 1, onOwnerMetrics: recordOwnerMetrics },
					);
					message = text(verification?.integrity_check);
					failed = message !== "ok";
				}
			}
			if (failed && message.length > 0) errors.push(`${table.name}: ${message}`);
			const metrics = await readPageMetrics(options.owner, remainingBudget, recordOwnerMetrics);
			await options.onBeforeCheckpointCommit?.();
			checkpoint = await persistTable(
				options.owner,
				key,
				table.cursor,
				checkpoint,
				metrics,
				failed,
				remainingBudget(),
				recordOwnerMetrics,
			);
			processedInRun += 1;
			await emit("running", null);
		}
		const remaining = await remainingObjects(options.owner, checkpoint.cursor, remainingBudget(), recordOwnerMetrics);
		if (remaining === 0) {
			await markComplete(options.owner, key, remainingBudget(), recordOwnerMetrics);
			checkpoint = { ...checkpoint, status: "complete" };
			phase = "complete";
			await emit("complete", null);
			return { ...(await progressSnapshot()), errors };
		}
		cancellationReason = "maintenance object budget exhausted at an object checkpoint";
		await emit("running", cancellationReason);
		return { ...(await progressSnapshot()), errors };
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		phase = isDeadline(error) || error instanceof IntegrityRunBudgetError ? "timed_out" : "unavailable";
		cancellationReason = reason;
		try {
			await emit(phase, reason);
		} catch {
			const progress = progressFrom(
				key,
				phase,
				checkpoint,
				0,
				lastTable,
				Date.now() - startedAt,
				ownerQueueAdmissionMs,
				ownerExecutionMs,
				reason,
				degradationReason,
			);
			updateDatabaseIntegrityStatus(progress, [...errors, reason], options.owner);
			return { ...progress, errors: [...errors, reason] };
		}
		return { ...(await progressSnapshot()), errors: [...errors, reason] };
	}
}

export interface MigrationVerifyCheckpoint {
	readonly attemptCount: number;
	readonly status: Checkpoint["status"];
}

export async function readMigrationVerifyCheckpoint(
	owner: DbOwnerClient,
	checkpointKey = "database.migration-verify",
	deadlineMs = 5_000,
): Promise<MigrationVerifyCheckpoint> {
	const key = boundedString(checkpointKey);
	await ensureCheckpoint(owner, key, deadlineMs);
	const checkpoint = await readCheckpoint(owner, key, deadlineMs);
	return { attemptCount: checkpoint.attemptCount, status: checkpoint.status };
}

export async function incrementMigrationVerifyAttempt(
	owner: DbOwnerClient,
	checkpointKey = "database.migration-verify",
	deadlineMs = 5_000,
): Promise<number> {
	const key = boundedString(checkpointKey);
	await ensureCheckpoint(owner, key, deadlineMs);
	await ownerTransaction(
		owner,
		"integrity.migration-verify.attempt",
		[
			ownerRunStatement(
				`UPDATE ${CHECKPOINT_TABLE}
				 SET attempt_count = attempt_count + 1, status = 'running', updated_at = ?
				 WHERE checkpoint_key = ?`,
				[new Date().toISOString(), key],
			),
		],
		{ deadlineMs, estimatedWorkUnits: 1 },
	);
	return (await readCheckpoint(owner, key, deadlineMs)).attemptCount;
}

export async function markMigrationVerifyTerminal(
	owner: DbOwnerClient,
	status: typeof MIGRATION_VERIFY_PARKED_STATUS | typeof MIGRATION_VERIFY_FAILED_STATUS | "complete",
	checkpointKey = "database.migration-verify",
	deadlineMs = 5_000,
): Promise<void> {
	const key = boundedString(checkpointKey);
	await ensureCheckpoint(owner, key, deadlineMs);
	await ownerTransaction(
		owner,
		"integrity.migration-verify.terminal",
		[
			ownerRunStatement(`UPDATE ${CHECKPOINT_TABLE} SET status = ?, updated_at = ? WHERE checkpoint_key = ?`, [
				status,
				new Date().toISOString(),
				key,
			]),
		],
		{ deadlineMs, estimatedWorkUnits: 1 },
	);
}

export const INCREMENTAL_INTEGRITY_CHECKPOINT_TABLE = CHECKPOINT_TABLE;

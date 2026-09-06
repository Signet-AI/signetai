/**
 * Bounded maintenance operations executed by the database owner.
 *
 * The daemon only submits serializable SQL jobs. Each FTS chunk is a separate
 * owner transaction and advances a durable keyset checkpoint in the same
 * transaction as the index writes. If the owner dies, the last committed
 * checkpoint is the resume point and a partially applied chunk is rolled back.
 */

import { randomUUID } from "node:crypto";
import {
	DbOwnerDeadlineError,
	DbOwnerDiedError,
	type DbOwnerClient,
	type DbOwnerHealth,
	type DbOwnerJobHandle,
} from "./db-owner-client";
import { createDbOwnerClient } from "./db-owner-client";
import type {
	DbOwnerDreamingEpisodicBacklog,
	DbOwnerDreamingEpisodicBacklogExists,
	DbOwnerDreamingEpisodicBacklogProbe,
	DbOwnerDreamingHygieneAttention,
	DbOwnerDreamingSurprisalAttention,
	DbOwnerParameter,
	DbOwnerRequest,
	DbOwnerStatement,
	DbOwnerVectorRepairInput,
	DbOwnerVectorRepairResult,
} from "./db-owner-protocol";
import {
	DB_OWNER_MAX_RESULT_BYTES,
	DB_OWNER_MAX_WORK_UNITS,
	VECTOR_REPAIR_MAX_BATCH_DEADLINE_MS,
	VECTOR_REPAIR_MAX_WORK_UNITS_PER_BATCH,
} from "./db-owner-protocol";
import { setFtsIndexIncomplete } from "./fts-index-state";
import type { EmbeddingIndexMigrationProgress } from "./embedding-index-state";
import type { DiagnosticsReport, ProviderTracker, QueueHealth } from "./diagnostics";
import type { DreamingEpisodicBacklogProbe } from "./pipeline/dreaming";
import type { DreamingSurprisalSelection } from "./pipeline/dreaming-surprisal";

export interface DbOwnerMaintenanceOptions {
	readonly deadlineMs?: number;
	readonly estimatedWorkUnits?: number;
	/** Abort queued or active maintenance before its next owner commit. */
	readonly signal?: AbortSignal;
	/** Verification maintenance is admitted while application writes are blocked. */
	readonly lane?: "maintenance" | "verify";
	readonly onOwnerMetrics?: (metrics: DbOwnerMaintenanceMetrics) => void | Promise<void>;
	/** Called when the owner worker has emitted its terminal result. */
	readonly onOwnerJobSettled?: () => void | Promise<void>;
	/** Called when admission rejects before an owner job is created. */
	readonly onOwnerJobAdmissionFailure?: (error: unknown) => void;
}

export interface DbOwnerMaintenanceMetrics {
	/** Time admitted in the daemon queue before the owner child started work. */
	readonly queueAdmissionMs: number;
	/** Execution time measured inside the owner child process. */
	readonly ownerExecutionMs: number;
}

const DEFAULT_OWNER_DEADLINE_MS = 5_000;

function submitOptions(
	operation: string,
	lane: "read" | "write" | "maintenance" | "verify",
	options: DbOwnerMaintenanceOptions,
): {
	readonly operation: string;
	readonly lane: "read" | "write" | "maintenance" | "verify";
	readonly deadlineMs: number;
	readonly estimatedWorkUnits?: number;
} {
	return {
		operation,
		lane,
		deadlineMs: options.deadlineMs ?? DEFAULT_OWNER_DEADLINE_MS,
		estimatedWorkUnits: options.estimatedWorkUnits,
	};
}

async function runOwnerJob<Result>(
	owner: DbOwnerClient,
	request: DbOwnerRequest,
	operation: string,
	lane: "read" | "write" | "maintenance",
	options: DbOwnerMaintenanceOptions = {},
): Promise<Result> {
	let handle: DbOwnerJobHandle<Result>;
	try {
		// Integrity checks and their durable checkpoints are the recovery path
		// that must remain usable while application writes are fail-closed.
		const effectiveLane = options.lane ?? (operation.startsWith("integrity.") ? "verify" : lane);
		handle = owner.submit<Result>(request, submitOptions(operation, effectiveLane, options));
	} catch (error) {
		options.onOwnerJobAdmissionFailure?.(error);
		throw error;
	}
	let notified = false;
	const notifySettled = (): void => {
		if (notified) return;
		notified = true;
		void Promise.resolve(options.onOwnerJobSettled?.()).catch(() => {
			// Completion notification is advisory and must not alter the owner result.
		});
	};
	void handle.metrics?.then(notifySettled, () => {
		// A dead owner has no worker left to wait for.
		notifySettled();
	});
	void handle.result.catch((error: unknown) => {
		// Deadline rejection abandons the client promise but not a dispatched
		// synchronous worker; its metrics promise remains the completion fence.
		if (!(error instanceof DbOwnerDeadlineError)) notifySettled();
	});
	const onAbort = (): void => handle.cancel();
	if (options.signal !== undefined) {
		if (options.signal.aborted) onAbort();
		else options.signal.addEventListener("abort", onAbort, { once: true });
	}
	try {
		const result = await handle.result;
		const metrics = await handle.metrics;
		if (metrics !== undefined) {
			await options.onOwnerMetrics?.({
				queueAdmissionMs: Math.max(0, metrics.startedAt - handle.job.enqueuedAt),
				ownerExecutionMs: Math.max(0, metrics.finishedAt - metrics.startedAt),
			});
		}
		return result;
	} finally {
		options.signal?.removeEventListener("abort", onAbort);
	}
}

async function startOwnerWithinDeadline(owner: DbOwnerClient, deadlineAt: number, operation: string): Promise<void> {
	const remainingMs = Math.floor(deadlineAt - Date.now());
	if (remainingMs < 1) throw new DbOwnerDeadlineError(operation);
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		await Promise.race([
			owner.start(),
			new Promise<never>((_, reject) => {
				timer = setTimeout(() => reject(new DbOwnerDeadlineError(operation)), remainingMs);
			}),
		]);
	} finally {
		if (timer !== undefined) clearTimeout(timer);
	}
}

/** Run an idempotent maintenance request once more after an owner crash. */
export async function runOwnerMaintenanceWithRetry<Result>(
	owner: DbOwnerClient,
	request: DbOwnerRequest,
	operation: string,
	options: DbOwnerMaintenanceOptions = {},
): Promise<Result> {
	const runBudgetMs = options.deadlineMs ?? DEFAULT_OWNER_DEADLINE_MS;
	const deadlineAt = Date.now() + runBudgetMs;
	const attemptOptions = (): DbOwnerMaintenanceOptions => {
		const remainingMs = Math.floor(deadlineAt - Date.now());
		if (remainingMs < 1) throw new DbOwnerDeadlineError(operation);
		return { ...options, deadlineMs: remainingMs };
	};
	try {
		return await runOwnerJob(owner, request, operation, "maintenance", attemptOptions());
	} catch (error) {
		if (!(error instanceof DbOwnerDiedError)) throw error;
		await startOwnerWithinDeadline(owner, deadlineAt, operation);
		return await runOwnerJob(owner, request, operation, "maintenance", attemptOptions());
	}
}

export async function ownerQueryAll<Row extends object>(
	owner: DbOwnerClient,
	operation: string,
	sql: string,
	params: readonly DbOwnerParameter[] = [],
	options: DbOwnerMaintenanceOptions = {},
): Promise<readonly Row[]> {
	return await runOwnerMaintenanceWithRetry<readonly Row[]>(
		owner,
		{ kind: "query", statement: { sql, params, result: "all", readonly: true } },
		operation,
		options,
	);
}

export async function ownerQueryOne<Row extends object>(
	owner: DbOwnerClient,
	operation: string,
	sql: string,
	params: readonly DbOwnerParameter[] = [],
	options: DbOwnerMaintenanceOptions = {},
): Promise<Row | undefined> {
	const result = await runOwnerMaintenanceWithRetry<Row | null | undefined>(
		owner,
		{ kind: "query", statement: { sql, params, result: "get", readonly: true } },
		operation,
		options,
	);
	return result ?? undefined;
}

/** Run a returning statement on the owner's write connection. */
export async function ownerWriteQueryOne<Row extends object>(
	owner: DbOwnerClient,
	operation: string,
	sql: string,
	params: readonly DbOwnerParameter[] = [],
	options: DbOwnerMaintenanceOptions = {},
): Promise<Row | undefined> {
	const result = await runOwnerMaintenanceWithRetry<Row | null | undefined>(
		owner,
		{ kind: "query", statement: { sql, params, result: "get", readonly: false } },
		operation,
		options,
	);
	return result ?? undefined;
}

export async function ownerTransaction(
	owner: DbOwnerClient,
	operation: string,
	statements: readonly DbOwnerStatement[],
	options: DbOwnerMaintenanceOptions = {},
): Promise<readonly unknown[]> {
	return await runOwnerMaintenanceWithRetry<readonly unknown[]>(
		owner,
		{ kind: "transaction", transaction: { statements } },
		operation,
		options,
	);
}

/** Execute a bounded write batch with optional compare-and-set preconditions. */
export async function ownerBatch(
	owner: DbOwnerClient,
	operation: string,
	statements: readonly DbOwnerStatement[],
	options: DbOwnerMaintenanceOptions = {},
	requireChanges = false,
): Promise<readonly unknown[]> {
	return await runOwnerMaintenanceWithRetry<readonly unknown[]>(
		owner,
		{ kind: "batch", statements, requireChanges },
		operation,
		options,
	);
}

/** Execute one autocommit write statement through the owner. */
export async function ownerRun(
	owner: DbOwnerClient,
	operation: string,
	sql: string,
	params: readonly DbOwnerParameter[] = [],
	options: DbOwnerMaintenanceOptions = {},
): Promise<void> {
	await runOwnerMaintenanceWithRetry(
		owner,
		{ kind: "query", statement: { sql, params, result: "run", transactional: false } },
		operation,
		options,
	);
}

export function ownerRunStatement(sql: string, params: readonly DbOwnerParameter[] = []): DbOwnerStatement {
	return { sql, params, result: "run" };
}

export function ownerChanges(result: unknown): number {
	if (typeof result !== "object" || result === null || !("changes" in result)) return 0;
	const changes = result.changes;
	return typeof changes === "number" && Number.isFinite(changes) ? changes : 0;
}

export async function ownerDreamingHygieneAttention(
	owner: DbOwnerClient,
	input: DbOwnerDreamingHygieneAttention,
	options: DbOwnerMaintenanceOptions = {},
): Promise<number> {
	return await runOwnerMaintenanceWithRetry<number>(
		owner,
		{ kind: "dreaming_hygiene_attention", input },
		"maintenance.dreaming.hygiene-attention",
		{ ...options, estimatedWorkUnits: options.estimatedWorkUnits ?? 100 },
	);
}

export async function ownerDreamingSurprisalAttention(
	owner: DbOwnerClient,
	input: DbOwnerDreamingSurprisalAttention,
	options: DbOwnerMaintenanceOptions = {},
): Promise<DreamingSurprisalSelection | null> {
	return await runOwnerMaintenanceWithRetry<DreamingSurprisalSelection | null>(
		owner,
		{ kind: "dreaming_surprisal_attention", input },
		"maintenance.dreaming.surprisal-attention",
		{ ...options, estimatedWorkUnits: options.estimatedWorkUnits ?? 500 },
	);
}

export async function ownerDreamingEpisodicBacklog(
	owner: DbOwnerClient,
	input: DbOwnerDreamingEpisodicBacklog,
	options: DbOwnerMaintenanceOptions = {},
): Promise<number> {
	return await runOwnerMaintenanceWithRetry<number>(
		owner,
		{ kind: "dreaming_episodic_backlog", input },
		"maintenance.dreaming.episodic-backlog",
		{ ...options, estimatedWorkUnits: options.estimatedWorkUnits ?? DB_OWNER_MAX_WORK_UNITS },
	);
}

export async function ownerDreamingEpisodicBacklogProbe(
	owner: DbOwnerClient,
	input: DbOwnerDreamingEpisodicBacklogProbe,
	options: DbOwnerMaintenanceOptions = {},
): Promise<DreamingEpisodicBacklogProbe> {
	return await runOwnerMaintenanceWithRetry<DreamingEpisodicBacklogProbe>(
		owner,
		{ kind: "dreaming_episodic_backlog_probe", input },
		"maintenance.dreaming.episodic-backlog-probe",
		{ ...options, estimatedWorkUnits: options.estimatedWorkUnits ?? input.maxSources * 10 },
	);
}

export async function ownerDreamingEpisodicBacklogExists(
	owner: DbOwnerClient,
	input: DbOwnerDreamingEpisodicBacklogExists,
	options: DbOwnerMaintenanceOptions = {},
): Promise<boolean> {
	return await runOwnerMaintenanceWithRetry<boolean>(
		owner,
		{ kind: "dreaming_episodic_backlog_exists", input },
		"maintenance.dreaming.episodic-backlog-exists",
		{ ...options, estimatedWorkUnits: options.estimatedWorkUnits ?? 10 },
	);
}

const DEFAULT_FTS_CHUNK_SIZE = 100;
const MAX_FTS_CHUNK_SIZE = 500;
const DEFAULT_FTS_DEADLINE_MS = 10_000;
const DEFAULT_FTS_RUN_BUDGET_MS = 60_000;
const MAX_FTS_RUN_BUDGET_MS = 10 * 60_000;
const DEFAULT_FTS_RUN_WORK_UNITS = DB_OWNER_MAX_WORK_UNITS;
const CHECKPOINT_TABLE = "db_owner_maintenance_checkpoints";
const FTS_STATE_TABLE = "memories_fts_state";

interface SqliteRunResult {
	readonly changes: number;
}

interface FtsCheckpoint {
	readonly job_key: string;
	readonly cursor: number;
	readonly processed: number;
	readonly status: "running" | "complete";
	readonly memoryCount: number;
	readonly indexedCount: number;
	readonly hasIndexedRows: number;
	readonly firstMemoryIndexed: number;
	readonly lastMemoryIndexed: number;
	readonly cursorIndexed: number;
}

export interface FtsBackfillProgress {
	readonly checkpointKey: string;
	readonly cursor: number;
	readonly inserted: number;
	readonly chunks: number;
	readonly processed: number;
}

export interface FtsBackfillResult {
	readonly checkpointKey: string;
	readonly status: "complete" | "running";
	readonly cursor: number;
	readonly chunks: number;
	readonly processed: number;
}

export interface FtsBackfillOptions {
	readonly checkpointKey?: string;
	readonly chunkSize?: number;
	readonly deadlineMs?: number;
	/** Stop after this many chunks. Omit to drain within the run budget. */
	readonly maxChunks?: number;
	/** Maximum wall-clock time for the complete backfill invocation. */
	readonly runBudgetMs?: number;
	/** Maximum estimated owner work units for the complete invocation. */
	readonly maxWorkUnits?: number;
	/** Cooperatively stop before submitting another chunk. */
	readonly signal?: AbortSignal;
	readonly onChunk?: (progress: FtsBackfillProgress) => void | Promise<void>;
	readonly audit?: FtsRepairAudit;
}

export interface FtsRepairAudit {
	readonly action: string;
	readonly actor: string;
	readonly reason: string;
	readonly actorType: "operator" | "agent" | "daemon";
	readonly requestId?: string;
	readonly message: string;
}

export interface DbOwnerMaintenance {
	readonly owner: DbOwnerClient;
	readonly backfillFts: (options?: FtsBackfillOptions) => Promise<FtsBackfillResult>;
	readonly rebuildFts: (options?: FtsBackfillOptions) => Promise<FtsBackfillResult>;
	readonly queueIsHealthy: () => Promise<boolean>;
	readonly dreamingHygieneAttention: (
		input: DbOwnerDreamingHygieneAttention,
		options?: DbOwnerMaintenanceOptions,
	) => Promise<number>;
	readonly dreamingSurprisalAttention: (
		input: DbOwnerDreamingSurprisalAttention,
		options?: DbOwnerMaintenanceOptions,
	) => Promise<DreamingSurprisalSelection | null>;
	readonly dreamingEpisodicBacklog: (
		input: DbOwnerDreamingEpisodicBacklog,
		options?: DbOwnerMaintenanceOptions,
	) => Promise<number>;
	readonly dreamingEpisodicBacklogProbe: (
		input: DbOwnerDreamingEpisodicBacklogProbe,
		options?: DbOwnerMaintenanceOptions,
	) => Promise<DreamingEpisodicBacklogProbe>;
	readonly dreamingEpisodicBacklogExists: (
		input: DbOwnerDreamingEpisodicBacklogExists,
		options?: DbOwnerMaintenanceOptions,
	) => Promise<boolean>;
	readonly embeddingMigrationProgress: (
		configuredBaseUrl?: string,
		options?: DbOwnerMaintenanceOptions,
	) => Promise<EmbeddingIndexMigrationProgress | null>;
	readonly vectorRepair: (
		input: DbOwnerVectorRepairInput,
		options?: DbOwnerMaintenanceOptions,
	) => Promise<DbOwnerVectorRepairResult>;
	readonly healthReady: (
		options?: DbOwnerMaintenanceOptions,
	) => Promise<{ readonly migrationsOk: boolean; readonly queueHealth: QueueHealth }>;
	readonly diagnostics: (
		stats: ProviderTracker["stats"],
		options?: DbOwnerMaintenanceOptions,
	) => Promise<DiagnosticsReport>;
	readonly health: () => DbOwnerHealth;
	readonly close: () => Promise<void>;
}

function boundedChunkSize(chunkSize: number | undefined): number {
	if (chunkSize === undefined) return DEFAULT_FTS_CHUNK_SIZE;
	if (!Number.isFinite(chunkSize)) throw new RangeError("FTS chunk size must be finite");
	return Math.min(MAX_FTS_CHUNK_SIZE, Math.max(1, Math.floor(chunkSize)));
}

function boundedDeadline(deadlineMs: number | undefined): number {
	if (deadlineMs === undefined) return DEFAULT_FTS_DEADLINE_MS;
	if (!Number.isFinite(deadlineMs) || deadlineMs <= 0) throw new RangeError("FTS owner deadline must be positive");
	return Math.min(60_000, Math.floor(deadlineMs));
}

function boundedRunBudget(value: number | undefined): number {
	if (value === undefined) return DEFAULT_FTS_RUN_BUDGET_MS;
	if (!Number.isFinite(value) || value <= 0) throw new RangeError("FTS run budget must be positive");
	return Math.min(MAX_FTS_RUN_BUDGET_MS, Math.floor(value));
}

function boundedRunWorkUnits(value: number | undefined): number {
	if (value === undefined) return DEFAULT_FTS_RUN_WORK_UNITS;
	if (!Number.isFinite(value) || value <= 0) throw new RangeError("FTS run work budget must be positive");
	return Math.min(DB_OWNER_MAX_WORK_UNITS, Math.floor(value));
}

function checkpointKey(value: string | undefined): string {
	const key = value?.trim() || "fts.memories.backfill";
	if (key.length > 200 || !/^[A-Za-z0-9._:-]+$/.test(key)) throw new RangeError("invalid FTS checkpoint key");
	return key;
}

function queryStatement(sql: string, params: readonly DbOwnerParameter[] = []): DbOwnerStatement {
	return { sql, params, result: "get", maxResultBytes: DB_OWNER_MAX_RESULT_BYTES };
}

function runStatement(sql: string, params: readonly DbOwnerParameter[] = []): DbOwnerStatement {
	return { sql, params, result: "run" };
}

async function submit<Result>(
	client: DbOwnerClient,
	request:
		| { readonly kind: "query"; readonly statement: DbOwnerStatement }
		| { readonly kind: "batch"; readonly statements: readonly DbOwnerStatement[] }
		| { readonly kind: "transaction"; readonly transaction: { readonly statements: readonly DbOwnerStatement[] } },
	operation: string,
	deadlineMs: number,
	estimatedWorkUnits: number,
): Promise<Result> {
	const handle = client.submit<Result>(request, {
		operation,
		lane: "maintenance",
		deadlineMs,
		estimatedWorkUnits,
	});
	return await handle.result;
}

async function ensureFtsSchema(client: DbOwnerClient, deadlineMs: number): Promise<void> {
	await submit<readonly SqliteRunResult[]>(
		client,
		{
			kind: "batch",
			statements: [
				runStatement(
					"CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(content, content='memories', content_rowid='rowid', tokenize='unicode61')",
				),
				runStatement(
					`CREATE TABLE IF NOT EXISTS ${FTS_STATE_TABLE} (
							id INTEGER PRIMARY KEY CHECK (id = 1),
							memory_count INTEGER NOT NULL,
							indexed_count INTEGER NOT NULL,
							updated_at TEXT NOT NULL
						)`,
				),
				runStatement("DROP TRIGGER IF EXISTS memories_ai"),
				runStatement("DROP TRIGGER IF EXISTS memories_ad"),
				runStatement("DROP TRIGGER IF EXISTS memories_au"),
				runStatement(
					"CREATE TRIGGER memories_ai AFTER INSERT ON memories BEGIN INSERT INTO memories_fts(rowid, content) VALUES (new.rowid, new.content); UPDATE memories_fts_state SET memory_count = CASE WHEN memory_count < 0 THEN -1 ELSE memory_count + 1 END, indexed_count = CASE WHEN indexed_count < 0 THEN 0 ELSE indexed_count + 1 END, updated_at = datetime('now') WHERE id = 1; END",
				),
				runStatement(
					"CREATE TRIGGER memories_ad AFTER DELETE ON memories BEGIN UPDATE memories_fts_state SET memory_count = CASE WHEN memory_count < 0 THEN -1 ELSE MAX(0, memory_count - 1) END, indexed_count = CASE WHEN indexed_count < 0 THEN 0 ELSE MAX(0, indexed_count - CASE WHEN EXISTS (SELECT 1 FROM memories_fts_docsize WHERE id = old.rowid) THEN 1 ELSE 0 END) END, updated_at = datetime('now') WHERE id = 1; INSERT INTO memories_fts(memories_fts, rowid, content) VALUES ('delete', old.rowid, old.content); END",
				),
				runStatement(
					"CREATE TRIGGER memories_au AFTER UPDATE OF content ON memories BEGIN UPDATE memories_fts_state SET indexed_count = CASE WHEN indexed_count < 0 THEN CASE WHEN EXISTS (SELECT 1 FROM memories_fts_docsize WHERE id = old.rowid) THEN 0 ELSE 1 END ELSE indexed_count + CASE WHEN EXISTS (SELECT 1 FROM memories_fts_docsize WHERE id = old.rowid) THEN 0 ELSE 1 END END, updated_at = datetime('now') WHERE id = 1; INSERT INTO memories_fts(memories_fts, rowid, content) VALUES ('delete', old.rowid, old.content); INSERT INTO memories_fts(rowid, content) VALUES (new.rowid, new.content); END",
				),
			],
		},
		"maintenance.fts.schema.ensure",
		deadlineMs,
		8,
	);
}

async function ensureCheckpoint(client: DbOwnerClient, key: string, deadlineMs: number): Promise<void> {
	await ensureFtsSchema(client, deadlineMs);
	await submit<readonly SqliteRunResult[]>(
		client,
		{
			kind: "batch",
			statements: [
				runStatement(
					`CREATE TABLE IF NOT EXISTS ${FTS_STATE_TABLE} (
							id INTEGER PRIMARY KEY CHECK (id = 1),
							memory_count INTEGER NOT NULL,
							indexed_count INTEGER NOT NULL,
							updated_at TEXT NOT NULL
						)`,
				),
				runStatement(
					`INSERT OR IGNORE INTO ${FTS_STATE_TABLE} (id, memory_count, indexed_count, updated_at)
						 VALUES (1, (SELECT COUNT(*) FROM memories), (SELECT COUNT(*) FROM memories_fts_docsize), ?)`,
					[new Date().toISOString()],
				),
				runStatement(
					`UPDATE ${FTS_STATE_TABLE}
					 SET memory_count = (SELECT COUNT(*) FROM memories),
					     indexed_count = (SELECT COUNT(*) FROM memories_fts_docsize),
					     updated_at = ?
					 WHERE id = 1 AND (memory_count < 0 OR indexed_count < 0)`,
					[new Date().toISOString()],
				),
				runStatement(
					`CREATE TABLE IF NOT EXISTS ${CHECKPOINT_TABLE} (
							job_key TEXT PRIMARY KEY,
							cursor INTEGER NOT NULL DEFAULT 0,
							processed INTEGER NOT NULL DEFAULT 0,
							status TEXT NOT NULL DEFAULT 'running',
							updated_at TEXT NOT NULL
						)`,
				),
				runStatement(
					`INSERT OR IGNORE INTO ${CHECKPOINT_TABLE} (job_key, cursor, processed, status, updated_at)
						 VALUES (?, 0, 0, 'running', ?)`,
					[key, new Date().toISOString()],
				),
			],
		},
		"maintenance.fts.checkpoint.init",
		deadlineMs,
		5,
	);
}

async function readCheckpoint(client: DbOwnerClient, key: string, deadlineMs: number): Promise<FtsCheckpoint> {
	const row = await submit<FtsCheckpoint | null>(
		client,
		{
			kind: "query",
			statement: queryStatement(
				`SELECT c.job_key, c.cursor, c.processed, c.status,
						s.memory_count AS memoryCount,
						s.indexed_count AS indexedCount,
						EXISTS(SELECT 1 FROM memories_fts_docsize LIMIT 1) AS hasIndexedRows,
						CASE WHEN NOT EXISTS(SELECT 1 FROM memories) THEN 1 ELSE EXISTS(
							SELECT 1 FROM memories_fts_docsize
							WHERE id = (SELECT rowid FROM memories ORDER BY rowid LIMIT 1)
						) END AS firstMemoryIndexed,
						CASE WHEN NOT EXISTS(SELECT 1 FROM memories) THEN 1 ELSE EXISTS(
							SELECT 1 FROM memories_fts_docsize
							WHERE id = (SELECT rowid FROM memories ORDER BY rowid DESC LIMIT 1)
						) END AS lastMemoryIndexed,
						CASE WHEN c.cursor <= 0 OR NOT EXISTS(SELECT 1 FROM memories WHERE rowid = c.cursor) THEN 1
							ELSE EXISTS(SELECT 1 FROM memories_fts_docsize WHERE id = c.cursor) END AS cursorIndexed
					 FROM ${CHECKPOINT_TABLE} AS c
					 CROSS JOIN ${FTS_STATE_TABLE} AS s
					 WHERE c.job_key = ? AND s.id = 1`,
				[key],
			),
		},
		"maintenance.fts.checkpoint.read",
		deadlineMs,
		1,
	);
	if (row == null || (row.status !== "running" && row.status !== "complete")) {
		throw new Error(`FTS checkpoint ${key} is missing or invalid`);
	}
	return row;
}

function sqliteProbeTrue(value: number): boolean {
	return value === 1;
}

function ftsIndexNeedsRecovery(checkpoint: FtsCheckpoint): boolean {
	if (checkpoint.status === "complete") {
		if (checkpoint.memoryCount < 0 || checkpoint.indexedCount < 0) return true;
		if (checkpoint.memoryCount !== checkpoint.indexedCount) return true;
		if (checkpoint.memoryCount === 0) return sqliteProbeTrue(checkpoint.hasIndexedRows);
		return (
			!sqliteProbeTrue(checkpoint.hasIndexedRows) ||
			!sqliteProbeTrue(checkpoint.firstMemoryIndexed) ||
			!sqliteProbeTrue(checkpoint.lastMemoryIndexed)
		);
	}
	if (checkpoint.cursor <= 0) return false;
	return !sqliteProbeTrue(checkpoint.firstMemoryIndexed) || !sqliteProbeTrue(checkpoint.cursorIndexed);
}

async function resetCheckpointForRecovery(client: DbOwnerClient, key: string, deadlineMs: number): Promise<void> {
	await submit<readonly SqliteRunResult[]>(
		client,
		{
			kind: "batch",
			statements: [
				runStatement(
					`UPDATE ${CHECKPOINT_TABLE}
					 SET cursor = 0, processed = 0, status = 'running', updated_at = ?
					 WHERE job_key = ?`,
					[new Date().toISOString(), key],
				),
				runStatement(
					`UPDATE ${FTS_STATE_TABLE}
					 SET indexed_count = 0, updated_at = ?
					 WHERE id = 1`,
					[new Date().toISOString()],
				),
			],
		},
		"maintenance.fts.checkpoint.recover",
		deadlineMs,
		2,
	);
}

async function markComplete(client: DbOwnerClient, key: string, deadlineMs: number): Promise<void> {
	await submit<readonly SqliteRunResult[]>(
		client,
		{
			kind: "batch",
			statements: [
				runStatement(`UPDATE ${CHECKPOINT_TABLE} SET status = 'complete', updated_at = ? WHERE job_key = ?`, [
					new Date().toISOString(),
					key,
				]),
				runStatement(`UPDATE ${FTS_STATE_TABLE} SET indexed_count = memory_count, updated_at = ? WHERE id = 1`, [
					new Date().toISOString(),
				]),
			],
		},
		"maintenance.fts.checkpoint.complete",
		deadlineMs,
		1,
	);
}

async function backfillFts(client: DbOwnerClient, options: FtsBackfillOptions = {}): Promise<FtsBackfillResult> {
	const key = checkpointKey(options.checkpointKey);
	const chunkSize = boundedChunkSize(options.chunkSize);
	const deadlineMs = boundedDeadline(options.deadlineMs);
	const runBudgetMs = boundedRunBudget(options.runBudgetMs);
	const maxWorkUnits = boundedRunWorkUnits(options.maxWorkUnits);
	const maxChunks =
		options.maxChunks === undefined ? Number.POSITIVE_INFINITY : Math.max(0, Math.floor(options.maxChunks));
	const startedAt = Date.now();
	if (maxChunks === 0) {
		await ensureCheckpoint(client, key, deadlineMs);
		let checkpoint = await readCheckpoint(client, key, deadlineMs);
		if (ftsIndexNeedsRecovery(checkpoint)) {
			await resetCheckpointForRecovery(client, key, deadlineMs);
			checkpoint = await readCheckpoint(client, key, deadlineMs);
		}
		setFtsIndexIncomplete(checkpoint.status !== "complete");
		return {
			checkpointKey: key,
			status: checkpoint.status,
			cursor: checkpoint.cursor,
			chunks: 0,
			processed: checkpoint.processed,
		};
	}

	await ensureCheckpoint(client, key, deadlineMs);
	let checkpoint = await readCheckpoint(client, key, deadlineMs);
	if (ftsIndexNeedsRecovery(checkpoint)) {
		await resetCheckpointForRecovery(client, key, deadlineMs);
		checkpoint = await readCheckpoint(client, key, deadlineMs);
	}
	setFtsIndexIncomplete(checkpoint.status !== "complete");
	let chunks = 0;
	let workUnits = 0;
	while (checkpoint.status === "running" && chunks < maxChunks) {
		if (options.signal?.aborted) break;
		const elapsedMs = Date.now() - startedAt;
		const remainingMs = runBudgetMs - elapsedMs;
		if (remainingMs < 1 || workUnits + chunkSize > maxWorkUnits) break;
		const chunkDeadlineMs = Math.min(deadlineMs, remainingMs);
		checkpoint = await readCheckpoint(client, key, chunkDeadlineMs);
		if (ftsIndexNeedsRecovery(checkpoint)) {
			await resetCheckpointForRecovery(client, key, chunkDeadlineMs);
			checkpoint = await readCheckpoint(client, key, chunkDeadlineMs);
		}
		setFtsIndexIncomplete(checkpoint.status !== "complete");
		if (checkpoint.memoryCount >= 0 && checkpoint.indexedCount === checkpoint.memoryCount) {
			await markComplete(client, key, chunkDeadlineMs);
			checkpoint = await readCheckpoint(client, key, chunkDeadlineMs);
			setFtsIndexIncomplete(checkpoint.status !== "complete");
			break;
		}
		const cursor = checkpoint.cursor;
		const now = new Date().toISOString();
		const statements: readonly DbOwnerStatement[] = [
			runStatement(
				`UPDATE ${CHECKPOINT_TABLE}
				 SET cursor = COALESCE((
					 SELECT MAX(rowid) FROM (
						 SELECT m.rowid AS rowid
						 FROM memories AS m
						 LEFT JOIN memories_fts_docsize AS f ON f.id = m.rowid
						 WHERE m.rowid > ? AND f.id IS NULL
						 ORDER BY m.rowid
						 LIMIT ?
					 )
				 ), cursor),
				 processed = processed + COALESCE((
					 SELECT COUNT(*) FROM (
						 SELECT m.rowid AS rowid
						 FROM memories AS m
						 LEFT JOIN memories_fts_docsize AS f ON f.id = m.rowid
						 WHERE m.rowid > ? AND f.id IS NULL
						 ORDER BY m.rowid
						 LIMIT ?
					 )
				 ), 0),
				     updated_at = ?
				 WHERE job_key = ? AND cursor = ?`,
				[cursor, chunkSize, cursor, chunkSize, now, key, cursor],
			),
			runStatement(
				`UPDATE ${FTS_STATE_TABLE}
				 SET indexed_count = indexed_count + COALESCE((
					 SELECT COUNT(*) FROM (
						 SELECT m.rowid AS rowid
						 FROM memories AS m
						 LEFT JOIN memories_fts_docsize AS f ON f.id = m.rowid
						 WHERE m.rowid > ? AND f.id IS NULL
						 ORDER BY m.rowid
						 LIMIT ?
					 )
				 ), 0), updated_at = ?
				 WHERE id = 1`,
				[cursor, chunkSize, now],
			),
			runStatement(
				`INSERT INTO memories_fts(rowid, content)
				 SELECT m.rowid, m.content
				 FROM memories AS m
				 LEFT JOIN memories_fts_docsize AS f ON f.id = m.rowid
				 WHERE m.rowid > ? AND f.id IS NULL
				 ORDER BY m.rowid
				 LIMIT ?`,
				[cursor, chunkSize],
			),
		];
		const previousProcessed = checkpoint.processed;
		await submit<readonly SqliteRunResult[]>(
			client,
			{ kind: "batch", statements },
			"maintenance.fts.backfill.chunk",
			chunkDeadlineMs,
			chunkSize,
		);
		checkpoint = await readCheckpoint(client, key, chunkDeadlineMs);
		setFtsIndexIncomplete(checkpoint.status !== "complete");
		const inserted = Math.max(0, checkpoint.processed - previousProcessed);
		chunks += 1;
		workUnits += chunkSize;
		await options.onChunk?.({
			checkpointKey: key,
			cursor: checkpoint.cursor,
			inserted,
			chunks,
			processed: checkpoint.processed,
		});
		if (inserted === 0 && checkpoint.cursor === cursor && checkpoint.status === "running") {
			throw new Error(`FTS backfill made no progress at cursor ${cursor}`);
		}
	}

	return {
		checkpointKey: key,
		status: checkpoint.status,
		cursor: checkpoint.cursor,
		chunks,
		processed: checkpoint.processed,
	};
}

export interface CreateDbOwnerMaintenanceOptions {
	readonly dbPath: string;
	readonly owner?: DbOwnerClient;
}

let registeredMaintenance: DbOwnerMaintenance | null = null;

export function registerDbOwnerMaintenance(maintenance: DbOwnerMaintenance | null): void {
	registeredMaintenance = maintenance;
}

export function getDbOwnerMaintenance(): DbOwnerMaintenance | null {
	return registeredMaintenance;
}

export function createDbOwnerMaintenance(options: CreateDbOwnerMaintenanceOptions): DbOwnerMaintenance {
	const owner = options.owner ?? createDbOwnerClient({ dbPath: options.dbPath });
	const ownsOwner = options.owner === undefined;
	const queueIsHealthy = async (): Promise<boolean> => {
		const now = Date.now();
		const row = await submit<{
			readonly depth: number;
			readonly oldest: string | null;
			readonly dead: number;
			readonly total: number;
			readonly leaseAnomalies: number;
		} | null>(
			owner,
			{
				kind: "query",
				statement: queryStatement(
					`SELECT
						(SELECT COUNT(*) FROM memory_jobs WHERE status = 'pending' AND job_type <> 'extract') AS depth,
						(SELECT MIN(created_at) FROM memory_jobs WHERE status = 'pending' AND job_type <> 'extract') AS oldest,
						(SELECT COUNT(*) FROM memory_jobs WHERE status = 'dead' AND updated_at >= ? AND job_type <> 'extract') AS dead,
						(SELECT COUNT(*) FROM memory_jobs WHERE status IN ('completed', 'dead') AND updated_at >= ? AND job_type <> 'extract') AS total,
						(SELECT COUNT(*) FROM memory_jobs WHERE status = 'leased' AND job_type <> 'extract' AND created_at < ?) AS leaseAnomalies`,
					[
						new Date(now - 60 * 60 * 1000).toISOString(),
						new Date(now - 60 * 60 * 1000).toISOString(),
						new Date(now - 10 * 60 * 1000).toISOString(),
					],
				),
			},
			"maintenance.queue.health",
			10_000,
			1,
		);
		if (row == null) return false;
		const oldestAgeSec = row.oldest ? Math.max(0, (now - new Date(row.oldest).getTime()) / 1000) : 0;
		const deadRate = row.total > 0 ? row.dead / row.total : 0;
		return row.depth <= 50 && oldestAgeSec <= 300 && deadRate <= 0.01 && row.leaseAnomalies === 0;
	};
	const dreamingHygieneAttention = (
		input: DbOwnerDreamingHygieneAttention,
		maintenanceOptions?: DbOwnerMaintenanceOptions,
	): Promise<number> => ownerDreamingHygieneAttention(owner, input, maintenanceOptions);
	const dreamingSurprisalAttention = (
		input: DbOwnerDreamingSurprisalAttention,
		maintenanceOptions?: DbOwnerMaintenanceOptions,
	): Promise<DreamingSurprisalSelection | null> => ownerDreamingSurprisalAttention(owner, input, maintenanceOptions);
	const dreamingEpisodicBacklog = (
		input: DbOwnerDreamingEpisodicBacklog,
		maintenanceOptions?: DbOwnerMaintenanceOptions,
	): Promise<number> => ownerDreamingEpisodicBacklog(owner, input, maintenanceOptions);
	const dreamingEpisodicBacklogProbe = (
		input: DbOwnerDreamingEpisodicBacklogProbe,
		maintenanceOptions?: DbOwnerMaintenanceOptions,
	): Promise<DreamingEpisodicBacklogProbe> => ownerDreamingEpisodicBacklogProbe(owner, input, maintenanceOptions);
	const dreamingEpisodicBacklogExists = (
		input: DbOwnerDreamingEpisodicBacklogExists,
		maintenanceOptions?: DbOwnerMaintenanceOptions,
	): Promise<boolean> => ownerDreamingEpisodicBacklogExists(owner, input, maintenanceOptions);
	const embeddingMigrationProgress = (
		configuredBaseUrl?: string,
		maintenanceOptions?: DbOwnerMaintenanceOptions,
	): Promise<EmbeddingIndexMigrationProgress | null> =>
		runOwnerMaintenanceWithRetry<EmbeddingIndexMigrationProgress | null>(
			owner,
			{
				kind: "embedding_migration_progress",
				...(configuredBaseUrl === undefined ? {} : { configuredBaseUrl }),
			},
			"maintenance.embedding.migration-progress",
			maintenanceOptions,
		);
	const vectorRepair = (
		input: DbOwnerVectorRepairInput,
		maintenanceOptions: DbOwnerMaintenanceOptions = {},
	): Promise<DbOwnerVectorRepairResult> => {
		const requestedDeadline = maintenanceOptions.deadlineMs ?? VECTOR_REPAIR_MAX_BATCH_DEADLINE_MS;
		if (!Number.isFinite(requestedDeadline) || requestedDeadline <= 0) {
			throw new RangeError("vector repair owner deadline must be positive");
		}
		const deadlineMs = Math.min(VECTOR_REPAIR_MAX_BATCH_DEADLINE_MS, Math.floor(requestedDeadline));
		const estimatedWorkUnits = Math.min(
			VECTOR_REPAIR_MAX_WORK_UNITS_PER_BATCH,
			Math.max(1, Math.floor(maintenanceOptions.estimatedWorkUnits ?? input.batchSize ?? 50)),
		);
		return runOwnerMaintenanceWithRetry<DbOwnerVectorRepairResult>(
			owner,
			{ kind: "vector_repair", input },
			`maintenance.vector-repair.${input.operation}`,
			{ ...maintenanceOptions, lane: "maintenance", deadlineMs, estimatedWorkUnits },
		);
	};
	const healthReady = (
		maintenanceOptions?: DbOwnerMaintenanceOptions,
	): Promise<{ readonly migrationsOk: boolean; readonly queueHealth: QueueHealth }> =>
		runOwnerMaintenanceWithRetry(owner, { kind: "health_ready" }, "maintenance.health.ready", maintenanceOptions);
	const diagnostics = (
		stats: ProviderTracker["stats"],
		maintenanceOptions?: DbOwnerMaintenanceOptions,
	): Promise<DiagnosticsReport> =>
		runOwnerMaintenanceWithRetry(
			owner,
			{ kind: "diagnostics", trackerStats: stats },
			"maintenance.diagnostics",
			maintenanceOptions,
		);
	const backfill = (backfillOptions?: FtsBackfillOptions): Promise<FtsBackfillResult> =>
		backfillFts(owner, backfillOptions);
	const rebuild = async (rebuildOptions: FtsBackfillOptions = {}): Promise<FtsBackfillResult> => {
		const deadlineMs = boundedDeadline(rebuildOptions.deadlineMs);
		const key = checkpointKey(rebuildOptions.checkpointKey);
		setFtsIndexIncomplete(true);
		await ensureCheckpoint(owner, key, deadlineMs);
		await submit<readonly SqliteRunResult[]>(
			owner,
			{
				kind: "batch",
				statements: [
					runStatement("DROP TRIGGER IF EXISTS memories_ai"),
					runStatement("DROP TRIGGER IF EXISTS memories_ad"),
					runStatement("DROP TRIGGER IF EXISTS memories_au"),
					runStatement("DROP TABLE IF EXISTS memories_fts"),
					runStatement("DROP TABLE IF EXISTS memories_fts_state"),
					runStatement(
						`CREATE VIRTUAL TABLE memories_fts USING fts5(content, content='memories', content_rowid='rowid', tokenize='unicode61')`,
					),
					runStatement(
						`CREATE TABLE memories_fts_state (id INTEGER PRIMARY KEY CHECK (id = 1), memory_count INTEGER NOT NULL, indexed_count INTEGER NOT NULL, updated_at TEXT NOT NULL)`,
					),
					runStatement(
						`INSERT INTO memories_fts_state (id, memory_count, indexed_count, updated_at) VALUES (1, (SELECT COUNT(*) FROM memories), 0, ?)`,
						[new Date().toISOString()],
					),
					runStatement(
						"CREATE TRIGGER memories_ai AFTER INSERT ON memories BEGIN INSERT INTO memories_fts(rowid, content) VALUES (new.rowid, new.content); UPDATE memories_fts_state SET memory_count = CASE WHEN memory_count < 0 THEN -1 ELSE memory_count + 1 END, indexed_count = CASE WHEN indexed_count < 0 THEN 0 ELSE indexed_count + 1 END, updated_at = datetime('now') WHERE id = 1; END",
					),
					runStatement(
						"CREATE TRIGGER memories_ad AFTER DELETE ON memories BEGIN UPDATE memories_fts_state SET memory_count = CASE WHEN memory_count < 0 THEN -1 ELSE MAX(0, memory_count - 1) END, indexed_count = CASE WHEN indexed_count < 0 THEN 0 ELSE MAX(0, indexed_count - CASE WHEN EXISTS (SELECT 1 FROM memories_fts_docsize WHERE id = old.rowid) THEN 1 ELSE 0 END) END, updated_at = datetime('now') WHERE id = 1; INSERT INTO memories_fts(memories_fts, rowid, content) VALUES ('delete', old.rowid, old.content); END",
					),
					runStatement(
						"CREATE TRIGGER memories_au AFTER UPDATE OF content ON memories BEGIN UPDATE memories_fts_state SET indexed_count = CASE WHEN indexed_count < 0 THEN CASE WHEN EXISTS (SELECT 1 FROM memories_fts_docsize WHERE id = old.rowid) THEN 0 ELSE 1 END ELSE indexed_count + CASE WHEN EXISTS (SELECT 1 FROM memories_fts_docsize WHERE id = old.rowid) THEN 0 ELSE 1 END END, updated_at = datetime('now') WHERE id = 1; INSERT INTO memories_fts(memories_fts, rowid, content) VALUES ('delete', old.rowid, old.content); INSERT INTO memories_fts(rowid, content) VALUES (new.rowid, new.content); END",
					),
					runStatement(
						`INSERT OR REPLACE INTO ${CHECKPOINT_TABLE} (job_key, cursor, processed, status, updated_at) VALUES (?, 0, 0, 'running', ?)`,
						[key, new Date().toISOString()],
					),
				],
			},
			"maintenance.fts.rebuild.schema",
			deadlineMs,
			9,
		);
		const result = await backfillFts(owner, { ...rebuildOptions, checkpointKey: key });
		if (rebuildOptions.audit && result.status === "complete") {
			const audit = rebuildOptions.audit;
			await submit<SqliteRunResult>(
				owner,
				{
					kind: "query",
					statement: runStatement(
						`INSERT INTO memory_history
						 (id, memory_id, event, old_content, new_content, changed_by, reason,
						  metadata, created_at, actor_type, session_id, request_id)
						 VALUES (?, 'system', 'none', NULL, NULL, ?, ?, ?, ?, ?, NULL, ?)`,
						[
							randomUUID(),
							audit.actor,
							audit.reason,
							JSON.stringify({ repairAction: audit.action, affected: 1, message: audit.message }),
							new Date().toISOString(),
							audit.actorType,
							audit.requestId ?? null,
						],
					),
				},
				"maintenance.fts.rebuild.audit",
				deadlineMs,
				1,
			);
		}
		return result;
	};
	return {
		owner,
		backfillFts: backfill,
		rebuildFts: rebuild,
		queueIsHealthy,
		dreamingHygieneAttention,
		dreamingSurprisalAttention,
		dreamingEpisodicBacklog,
		dreamingEpisodicBacklogProbe,
		dreamingEpisodicBacklogExists,
		embeddingMigrationProgress,
		vectorRepair,
		healthReady,
		diagnostics,
		health: () => owner.health(),
		close: async () => {
			if (ownsOwner) await owner.close();
		},
	};
}

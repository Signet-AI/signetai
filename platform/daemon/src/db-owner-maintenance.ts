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
	DbOwnerDiedError,
	type DbOwnerClient,
	type DbOwnerHealth,
	type DbOwnerJobHandle,
} from "./db-owner-client";
import { createDbOwnerClient } from "./db-owner-client";
import type { DbOwnerParameter, DbOwnerRequest, DbOwnerStatement } from "./db-owner-protocol";
import { DB_OWNER_MAX_RESULT_BYTES } from "./db-owner-protocol";

export interface DbOwnerMaintenanceOptions {
	readonly deadlineMs?: number;
	readonly estimatedWorkUnits?: number;
}

const DEFAULT_OWNER_DEADLINE_MS = 5_000;

function submitOptions(
	operation: string,
	lane: "read" | "write" | "maintenance",
	options: DbOwnerMaintenanceOptions,
): {
	readonly operation: string;
	readonly lane: "read" | "write" | "maintenance";
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
	const handle: DbOwnerJobHandle<Result> = owner.submit<Result>(request, submitOptions(operation, lane, options));
	return await handle.result;
}

/** Run an idempotent maintenance request once more after an owner crash. */
export async function runOwnerMaintenanceWithRetry<Result>(
	owner: DbOwnerClient,
	request: DbOwnerRequest,
	operation: string,
	options: DbOwnerMaintenanceOptions = {},
): Promise<Result> {
	try {
		return await runOwnerJob(owner, request, operation, "maintenance", options);
	} catch (error) {
		if (!(error instanceof DbOwnerDiedError)) throw error;
		await owner.start();
		return await runOwnerJob(owner, request, operation, "maintenance", options);
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
		{ kind: "query", statement: { sql, params, result: "all" } },
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
		{ kind: "query", statement: { sql, params, result: "get" } },
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

export function ownerRunStatement(sql: string, params: readonly DbOwnerParameter[] = []): DbOwnerStatement {
	return { sql, params, result: "run" };
}

export function ownerChanges(result: unknown): number {
	if (typeof result !== "object" || result === null || !("changes" in result)) return 0;
	const changes = result.changes;
	return typeof changes === "number" && Number.isFinite(changes) ? changes : 0;
}

const DEFAULT_FTS_CHUNK_SIZE = 100;
const MAX_FTS_CHUNK_SIZE = 500;
const DEFAULT_FTS_DEADLINE_MS = 10_000;
const CHECKPOINT_TABLE = "db_owner_maintenance_checkpoints";

interface SqliteRunResult {
	readonly changes: number;
}

interface FtsCheckpoint {
	readonly job_key: string;
	readonly cursor: number;
	readonly processed: number;
	readonly status: "running" | "complete";
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
	/** Stop after this many chunks. Omit to drain the checkpoint. */
	readonly maxChunks?: number;
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

async function ensureCheckpoint(client: DbOwnerClient, key: string, deadlineMs: number): Promise<void> {
	await submit<readonly SqliteRunResult[]>(
		client,
		{
			kind: "batch",
			statements: [
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
		2,
	);
}

async function readCheckpoint(client: DbOwnerClient, key: string, deadlineMs: number): Promise<FtsCheckpoint> {
	const row = await submit<FtsCheckpoint | null>(
		client,
		{
			kind: "query",
			statement: queryStatement(
				`SELECT job_key, cursor, processed, status FROM ${CHECKPOINT_TABLE} WHERE job_key = ?`,
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

async function hasMissingRows(client: DbOwnerClient, cursor: number, deadlineMs: number): Promise<boolean> {
	const row = await submit<{ readonly present: number } | null>(
		client,
		{
			kind: "query",
			statement: queryStatement(
				`SELECT 1 AS present
				 FROM memories AS m
				 LEFT JOIN memories_fts_docsize AS f ON f.id = m.rowid
				 WHERE m.rowid > ? AND f.id IS NULL
				 LIMIT 1`,
				[cursor],
			),
		},
		"maintenance.fts.missing.check",
		deadlineMs,
		1,
	);
	return row != null;
}

async function markComplete(client: DbOwnerClient, key: string, deadlineMs: number): Promise<void> {
	await submit<SqliteRunResult>(
		client,
		{
			kind: "query",
			statement: runStatement(`UPDATE ${CHECKPOINT_TABLE} SET status = 'complete', updated_at = ? WHERE job_key = ?`, [
				new Date().toISOString(),
				key,
			]),
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
	const maxChunks =
		options.maxChunks === undefined ? Number.POSITIVE_INFINITY : Math.max(0, Math.floor(options.maxChunks));
	if (maxChunks === 0) {
		await ensureCheckpoint(client, key, deadlineMs);
		const checkpoint = await readCheckpoint(client, key, deadlineMs);
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
	let chunks = 0;
	while (checkpoint.status === "running" && chunks < maxChunks) {
		const cursor = checkpoint.cursor;
		if (!(await hasMissingRows(client, cursor, deadlineMs))) {
			await markComplete(client, key, deadlineMs);
			checkpoint = await readCheckpoint(client, key, deadlineMs);
			break;
		}
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
			{ kind: "batch", batch: { statements } },
			"maintenance.fts.backfill.chunk",
			deadlineMs,
			chunkSize,
		);
		checkpoint = await readCheckpoint(client, key, deadlineMs);
		const inserted = Math.max(0, checkpoint.processed - previousProcessed);
		chunks += 1;
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
	const backfill = (backfillOptions?: FtsBackfillOptions): Promise<FtsBackfillResult> =>
		backfillFts(owner, backfillOptions);
	const rebuild = async (rebuildOptions: FtsBackfillOptions = {}): Promise<FtsBackfillResult> => {
		const deadlineMs = boundedDeadline(rebuildOptions.deadlineMs);
		const key = checkpointKey(rebuildOptions.checkpointKey);
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
						runStatement(
							"CREATE VIRTUAL TABLE memories_fts USING fts5(content, content='memories', content_rowid='rowid', tokenize='unicode61')",
						),
						runStatement(
							"CREATE TRIGGER memories_ai AFTER INSERT ON memories BEGIN INSERT INTO memories_fts(rowid, content) VALUES (new.rowid, new.content); END",
						),
						runStatement(
							"CREATE TRIGGER memories_ad AFTER DELETE ON memories BEGIN INSERT INTO memories_fts(memories_fts, rowid, content) VALUES ('delete', old.rowid, old.content); END",
						),
						runStatement(
							"CREATE TRIGGER memories_au AFTER UPDATE OF content ON memories BEGIN INSERT INTO memories_fts(memories_fts, rowid, content) VALUES ('delete', old.rowid, old.content); INSERT INTO memories_fts(rowid, content) VALUES (new.rowid, new.content); END",
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
		health: () => owner.health(),
		close: async () => {
			if (ownsOwner) await owner.close();
		},
	};
}

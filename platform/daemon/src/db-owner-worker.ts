import { executeEmbeddingProjectionInTx } from "./embedding-projection-owner";
import { DbOwnerLineBuffer } from "./db-owner-line-buffer";
import { ScopedHeadCache } from "./scoped-head-cache";
import type { Database as BunDatabase } from "bun:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { AUTHORITY_TABLES } from "./auth/authority-epoch";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolveWriteCompartmentParameterInTx } from "./db-helpers";
import { dirname, resolve } from "node:path";
import {
	compartmentForWrite,
	configureEvidencePurgeConnection,
	withWritePrincipal,
	syncEmbeddingCompartment,
	deleteCompartmentVectors,
	activeVectorProjectionTable,
	inFlightClassificationSql,
	findSqliteVecExtension,
	requireReadScope,
	readScopeSql,
	resolveWorkspaceLayout,
	vectorSearchWithMetadata,
} from "@signet/core";
import { removeAgentInTx } from "./agent-removal";
import type { ReadDb, WriteDb } from "./db-accessor";
import { vectorToBlob } from "./db-helpers";
import type {
	DbOwnerCommand,
	DbOwnerEvent,
	DbOwnerJob,
	DbOwnerJobMetrics,
	DbOwnerNativeMemoryIndex,
	DbOwnerParameter,
	DbOwnerRecallPayload,
	DbOwnerStatement,
	DbOwnerVectorSearchPayload,
} from "./db-owner-protocol";
import {
	DB_OWNER_MAX_DEADLINE_MS,
	DB_OWNER_MAX_MAINTENANCE_DEADLINE_MS,
	DB_OWNER_MAX_QUEUE_DEPTH,
	DB_OWNER_MAX_RESULT_BYTES,
	DB_OWNER_MAX_TRANSACTION_STATEMENTS,
	DB_OWNER_MAX_WORK_UNITS,
	serializeError,
} from "./db-owner-protocol";
import type { PragmaDb } from "./db-vacuum";
import { awaitEmbeddingProviderAvailable, recordEmbeddingProviderFailure } from "./embedding-circuit-breaker";
import { getDreamingHygieneCandidatesInDb } from "./knowledge-graph-hygiene";
import type { EmbeddingConfig } from "./memory-config";
import { type MemoryArtifactUpsertFields, upsertMemoryArtifactInTx } from "./memory-lineage";
import { NATIVE_MEMORY_BRIDGE_SOURCE_NODE_ID } from "./native-memory-constants";
import {
	applyObsidianSourceStructureInTx,
	applyObsidianSourceStructurePurgeInTx,
	isObsidianSourceFileIndexedInTx,
	purgeObsidianSourceFileStructureInTx,
} from "./obsidian-source-graph";
import { enqueueDreamingAttentionInTx } from "./pipeline/dreaming-attention";
import { sourceHasEligibleUnconsumedEvidence } from "./pipeline/dreaming-evidence-consumption";
import { DREAMING_SURPRISAL_SELECTOR_VERSION, selectDreamingSurprisalInDb } from "./pipeline/dreaming-surprisal";
import type { writeSessionTranscriptRow } from "./session-transcripts";
import { indexSourceArtifactStructureInTx, purgeSourceArtifactStructureInTx } from "./source-artifact-graph";
import { purgeSourceOwnedRowsInTx } from "./source-purge-tx";
import { applySourceSnapshotImportInTx } from "./source-snapshots";
import { commitTranscriptImportBatchInTx, purgeTranscriptImportSourceInTx } from "./transcript-import-commit";
import { applyVectorRepairBatch, VectorRepairAbortError } from "./vector-repair-owner";

interface SqliteRunResult {
	readonly changes: number;
	readonly lastInsertRowid?: number | bigint;
}

interface SqliteStatement {
	finalize?(): void;
	all<Row = unknown>(...params: readonly unknown[]): Row[];
	get(...params: readonly unknown[]): Record<string, unknown> | undefined;
	run(...params: readonly unknown[]): SqliteRunResult;
}

interface SqliteDatabase {
	prepare(sql: string): SqliteStatement;
	exec(sql: string): void;
	loadExtension?(path: string): void;
	close(throwOnError?: boolean): void;
}

interface SqliteDatabaseConstructor {
	new (path: string, options?: Record<string, unknown>): SqliteDatabase;
	setCustomSQLite?: (path: string) => void;
}

interface JobExecutionContext {
	readonly jobId: string;
	readonly deadlineAt: number;
	committed: boolean;
}

class DbOwnerCancellationRequested extends Error {
	constructor() {
		super("DB owner job cancelled before commit");
		this.name = "DB_OWNER_CANCELLED";
	}
}

const require = createRequire(import.meta.url);
const Database = (
	typeof (globalThis as Record<string, unknown>).Bun !== "undefined"
		? require("bun:sqlite").Database
		: (() => {
				try {
					return require("node:sqlite").DatabaseSync;
				} catch {
					return require("better-sqlite3");
				}
			})()
) as SqliteDatabaseConstructor;

export function loadSqliteVecIfAvailable(db: SqliteDatabase, extension: string): boolean {
	try {
		if (typeof db.loadExtension !== "function") throw new Error("SQLite loadExtension API unavailable");
		db.loadExtension(extension);
		return true;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		console.warn(
			`sqlite-vec extension could not be loaded on ${process.platform}: ${message}; continuing with bounded canonical-vector fallback, KNN throughput is degraded`,
		);
		return false;
	}
}

export function shouldRecordDbOwnerCancellation(
	jobId: string,
	activeJobId: string | null,
	foregroundJobs: readonly Pick<DbOwnerJob, "id">[],
	maintenanceJobs: readonly Pick<DbOwnerJob, "id">[],
): boolean {
	if (jobId === activeJobId) return false;
	return foregroundJobs.some((job) => job.id === jobId) || maintenanceJobs.some((job) => job.id === jobId);
}

export function runDbOwnerWorker(): void {
	const dbPath = process.env.SIGNET_DB_OWNER_DB_PATH;
	if (dbPath === undefined) throw new Error("DB owner requires SIGNET_DB_OWNER_DB_PATH");
	const ownerDbPath = dbPath;
	const cancellationRegistryPath = process.env.SIGNET_DB_OWNER_CANCEL_REGISTRY;
	function cancellationRequested(jobId: string): boolean {
		if (cancellationRegistryPath === undefined) return false;
		try {
			return readFileSync(cancellationRegistryPath, "utf8").includes(`${jobId}\n`);
		} catch {
			return false;
		}
	}
	const authorityInstance = randomUUID();
	let authorityEpoch = 0n;
	let authorityEpochReady = false;
	const parentPid = process.ppid;
	let db = undefined as unknown as SqliteDatabase;
	let readDb: SqliteDatabase | undefined;
	const scopedHeads = new ScopedHeadCache((key) => {
		db.prepare("DELETE FROM temp.signet_head_dependencies WHERE cache_key=?").run(key);
		db.prepare("DELETE FROM temp.signet_head_scopes WHERE cache_key=?").run(key);
	});
	let headDataVersion: unknown;
	const headClassificationScopes = new Map<string, string>();
	let parentWatch: ReturnType<typeof setInterval> | undefined;
	let workspaceRoot: string | undefined;
	function bindTranscriptWorkspace(candidate: string): string {
		if (!candidate) throw new Error("Transcript operation requires an explicit workspace");
		const layout = resolveWorkspaceLayout(candidate);
		if (resolve(layout.database) !== resolve(ownerDbPath))
			throw new Error("Transcript workspace does not match its database owner");
		if (workspaceRoot && workspaceRoot !== layout.root)
			throw new Error("Transcript workspace changed within one owner");
		workspaceRoot = layout.root;
		return workspaceRoot;
	}
	const closeAndExit = (code: number): never => {
		if (parentWatch !== undefined) clearInterval(parentWatch);
		try {
			try {
				readDb?.close(true);
			} finally {
				if (db !== undefined) db.close(true);
			}
		} finally {
			process.exit(code);
		}
	};

	function send(event: DbOwnerEvent): void {
		if (authorityEpochReady && event.type === "result") {
			const epoch = db.prepare("SELECT epoch FROM temp.signet_authority_epoch WHERE id=1").get()?.epoch;
			if (typeof epoch !== "number" || !Number.isSafeInteger(epoch) || epoch < 0)
				throw new Error("Invalid authority epoch");
			if (BigInt(epoch) !== authorityEpoch) {
				scopedHeads.clear();
				headClassificationScopes.clear();
			}
			authorityEpoch = BigInt(epoch);
			for (const row of db.prepare("SELECT cache_key FROM temp.signet_head_dirty").all<{ cache_key: string }>())
				scopedHeads.invalidate(row.cache_key);
			db.exec("DELETE FROM temp.signet_head_dirty");
		}
		process.stdout.write(
			`${JSON.stringify({ ...event, authorityVersion: `${authorityInstance}:${authorityEpoch}` })}\n`,
		);
	}
	function writeDiagnostic(message: string): void {
		process.stderr.write(`${message}\n`);
	}
	send({ type: "ready", pid: process.pid });

	const startupStarted = process.env.SIGNET_DB_OWNER_TEST_STARTUP_STARTED;
	const startupRelease = process.env.SIGNET_DB_OWNER_TEST_STARTUP_RELEASE;
	if (startupStarted !== undefined && startupRelease !== undefined) {
		writeFileSync(startupStarted, "started\n");
		const signal = new Int32Array(new SharedArrayBuffer(4));
		while (!existsSync(startupRelease)) Atomics.wait(signal, 0, 0, 5);
	}

	const sqlitePath = process.env.SIGNET_DB_OWNER_SQLITE_PATH ?? process.env.SIGNET_SQLITE_PATH;
	try {
		if (sqlitePath !== undefined && existsSync(sqlitePath) && typeof Database.setCustomSQLite === "function") {
			Database.setCustomSQLite(sqlitePath);
		}
		db = new Database(dbPath);
		configureEvidencePurgeConnection(db);
		db.exec("PRAGMA busy_timeout = 5000");
		db.exec("PRAGMA synchronous = FULL");
		const vecExtension = findSqliteVecExtension();
		if (vecExtension !== null) loadSqliteVecIfAvailable(db, vecExtension);
		installAuthorityEpoch();
		installHeadInvalidation();
	} catch (error) {
		send({ type: "fatal", error: serializeError(error) });
		closeAndExit(1);
	}
	if (db === undefined) closeAndExit(1);
	parentWatch = setInterval(() => {
		if (process.ppid !== parentPid) closeAndExit(0);
	}, 50);
	parentWatch.unref();

	const BUSY_RETRIES = 3;
	const BUSY_BACKOFF_MS = 50;
	const isBusyError = (error: unknown): boolean => {
		const code = error !== null && typeof error === "object" && "code" in error ? error.code : undefined;
		const message = error instanceof Error ? error.message : String(error);
		return code === "SQLITE_BUSY" || message.includes("SQLITE_BUSY") || message.includes("database is locked");
	};
	const wait = (milliseconds: number): void => {
		const signal = new Int32Array(new SharedArrayBuffer(4));
		Atomics.wait(signal, 0, 0, milliseconds);
	};
	const commit = (context?: JobExecutionContext): void => {
		if (context !== undefined && cancellationRequested(context.jobId)) {
			throw new DbOwnerCancellationRequested();
		}
		const commitMarker = process.env.SIGNET_DB_OWNER_TEST_COMMIT_STARTED;
		const commitPauseMs = Number.parseInt(process.env.SIGNET_DB_OWNER_TEST_COMMIT_PAUSE_MS ?? "0", 10);
		const commitResultPauseMs = Number.parseInt(process.env.SIGNET_DB_OWNER_TEST_COMMIT_RESULT_PAUSE_MS ?? "0", 10);
		const commitResultGate = process.env.SIGNET_DB_OWNER_TEST_COMMIT_RESULT_GATE;

		if (commitMarker !== undefined) writeFileSync(commitMarker, commitPauseMs > 0 ? "waiting\n" : "started\n");
		if (Number.isFinite(commitPauseMs) && commitPauseMs > 0) {
			Reflect.deleteProperty(process.env, "SIGNET_DB_OWNER_TEST_COMMIT_PAUSE_MS");
			wait(Math.min(commitPauseMs, 60_000));
		}
		db.exec("COMMIT");
		if (context !== undefined) context.committed = true;
		if (commitMarker !== undefined && Number.isFinite(commitPauseMs) && commitPauseMs > 0) {
			writeFileSync(commitMarker, "completed\n");
			Reflect.deleteProperty(process.env, "SIGNET_DB_OWNER_TEST_COMMIT_STARTED");
		}
		if (
			Number.isFinite(commitResultPauseMs) &&
			commitResultPauseMs > 0 &&
			commitResultGate !== undefined &&
			existsSync(commitResultGate)
		) {
			rmSync(commitResultGate, { force: true });
			Reflect.deleteProperty(process.env, "SIGNET_DB_OWNER_TEST_COMMIT_RESULT_PAUSE_MS");
			if (commitMarker !== undefined) writeFileSync(commitMarker, "result-wait\n");
			wait(Math.min(commitResultPauseMs, 60_000));
		}
	};
	const withBusyRetry = <Result>(operation: () => Result, context?: JobExecutionContext): Result => {
		for (let attempt = 0; ; attempt += 1) {
			try {
				db.exec("BEGIN IMMEDIATE");
				const result = operation();
				commit(context);
				return result;
			} catch (error) {
				try {
					db.exec("ROLLBACK");
				} catch {}
				if (!isBusyError(error) || attempt >= BUSY_RETRIES) throw error;
				wait(BUSY_BACKOFF_MS * 2 ** attempt);
			}
		}
	};

	const cancelled = new Set<string>();
	const foregroundQueue: DbOwnerJob[] = [];
	const maintenanceQueue: DbOwnerJob[] = [];
	let foregroundStreak = 0;
	const MAX_FOREGROUND_BURST = 32;
	let activeJobId: string | null = null;
	let writeBlocked = false;
	let draining = false;

	let metadataStreak = 0;
	function metadataRead(job: DbOwnerJob): boolean {
		return job.lane === "read" && job.request.kind === "query" && job.request.statement.readonly === true;
	}
	function nextForeground(): DbOwnerJob | undefined {
		const metadataIndex = foregroundQueue.findIndex(metadataRead);
		const corpusIndex = foregroundQueue.findIndex((job) => !metadataRead(job));
		if (metadataIndex >= 0 && (metadataStreak < 8 || corpusIndex < 0)) {
			metadataStreak = Math.min(8, metadataStreak + 1);
			return foregroundQueue.splice(metadataIndex, 1)[0];
		}
		metadataStreak = 0;
		return foregroundQueue.splice(Math.max(0, corpusIndex), 1)[0];
	}
	function nextJob(): DbOwnerJob | undefined {
		if (foregroundQueue.length > 0 && (maintenanceQueue.length === 0 || foregroundStreak < MAX_FOREGROUND_BURST)) {
			foregroundStreak += 1;
			return nextForeground();
		}
		if (maintenanceQueue.length > 0) {
			foregroundStreak = 0;
			return maintenanceQueue.shift();
		}
		if (foregroundQueue.length > 0) {
			foregroundStreak += 1;
			return nextForeground();
		}
		return undefined;
	}

	function bindParameter(value: DbOwnerParameter, writeBatch = false): unknown {
		if (typeof value === "object" && value !== null && value.type === "compartment") {
			if (!writeBatch) throw new Error("compartment_parameter_requires_batch");
			return resolveWriteCompartmentParameterInTx(db, value);
		}
		if (typeof value === "object" && value !== null && value.type === "bytes") {
			return Buffer.from(value.base64, "base64");
		}
		return value;
	}

	function resultLimitError(name: string, message: string): Error {
		const error = new Error(message);
		error.name = name;
		return error;
	}

	function enforceResultLimit(statement: DbOwnerStatement, value: unknown): unknown {
		const maxResultBytes = statement.maxResultBytes ?? DB_OWNER_MAX_RESULT_BYTES;
		if (!Number.isInteger(maxResultBytes) || maxResultBytes <= 0 || maxResultBytes > DB_OWNER_MAX_RESULT_BYTES) {
			throw resultLimitError(
				"DB_OWNER_RESULT_LIMIT_INVALID",
				`DB owner maxResultBytes must be an integer from 1 to ${DB_OWNER_MAX_RESULT_BYTES}`,
			);
		}
		const serialized = JSON.stringify(value) ?? "null";
		const resultBytes = Buffer.byteLength(serialized, "utf8");
		if (resultBytes > maxResultBytes) {
			throw resultLimitError(
				"DB_OWNER_RESULT_TOO_LARGE",
				`DB owner result is ${resultBytes} bytes, above the ${maxResultBytes}-byte limit; page the query or reduce its columns (${statement.sql.replace(/\s+/g, " ").trim().slice(0, 160)})`,
			);
		}
		return value;
	}

	function executeStatement(
		statement: DbOwnerStatement,
		context?: JobExecutionContext,
		writeTransaction = false,
	): unknown {
		const params = (statement.params ?? []).map((value) => bindParameter(value, writeTransaction));
		const prepared = db.prepare(statement.sql);
		if (statement.result === "all" && statement.readonly !== false)
			return enforceResultLimit(statement, prepared.all(...params));
		if (statement.result === "get" && statement.readonly !== false)
			return enforceResultLimit(statement, prepared.get(...params));
		if (statement.result === "all" || statement.result === "get") {
			return withBusyRetry(
				() =>
					enforceResultLimit(statement, statement.result === "all" ? prepared.all(...params) : prepared.get(...params)),
				context,
			);
		}
		if (statement.transactional === false) {
			const result = prepared.run(...params);
			if (context !== undefined) context.committed = true;
			return enforceResultLimit(statement, result);
		}

		return withBusyRetry(() => enforceResultLimit(statement, prepared.run(...params)), context);
	}

	function executeReadOnlyStatement(statement: DbOwnerStatement): unknown {
		if (statement.result === "run") throw new Error("DB owner readonly statements must return rows");
		const reuse = /^(SELECT|WITH)\b/i.test(statement.sql.trimStart());
		const readonlyDb = (reuse ? readDb : undefined) ?? new Database(ownerDbPath, { readonly: true });
		try {
			if (readonlyDb !== readDb) {
				configureEvidencePurgeConnection(readonlyDb);
				if (reuse) readDb = readonlyDb;
			}
			const params = (statement.params ?? []).map((value) => bindParameter(value));
			const prepared = readonlyDb.prepare(statement.sql);
			try {
				return statement.result === "all"
					? enforceResultLimit(statement, prepared.all(...params))
					: enforceResultLimit(statement, prepared.get(...params));
			} finally {
				prepared.finalize?.();
			}
		} finally {
			if (readonlyDb !== readDb) readonlyDb.close(true);
		}
	}

	function executeTransaction(
		statements: readonly DbOwnerStatement[],
		context?: JobExecutionContext,
	): readonly unknown[] {
		if (statements.length === 0 || statements.length > DB_OWNER_MAX_TRANSACTION_STATEMENTS) {
			throw new Error(`DB owner transaction must contain 1 to ${DB_OWNER_MAX_TRANSACTION_STATEMENTS} statements`);
		}
		return withBusyRetry(() => {
			const results: unknown[] = [];
			for (const statement of statements) {
				const result = executeStatement({ ...statement, transactional: false }, context, true);
				results.push(result);
				if (
					statement?.requireChanges === true &&
					typeof result === "object" &&
					result !== null &&
					"changes" in result &&
					result.changes === 0
				) {
					throw new Error("DB owner transaction precondition changed zero rows");
				}
			}
			return enforceResultLimit({ sql: "DB_OWNER_TRANSACTION", result: "all" }, results) as readonly unknown[];
		}, context);
	}

	function executeBatch(
		statements: readonly DbOwnerStatement[],
		requireChanges: boolean,
		context?: JobExecutionContext,
		embeddingProjection?: import("./embedding-projection").EmbeddingProjectionRequest,
	): readonly unknown[] {
		if (statements.length === 0) throw new Error("DB owner batch must contain at least one statement");
		db.exec("BEGIN IMMEDIATE");
		try {
			const results: unknown[] = [];
			for (const statement of statements) {
				if (statement.result !== "run") throw new Error("DB owner batches only support run statements");
				const result = executeStatementWithoutTransaction(statement);
				if ((requireChanges || statement.requireChanges === true) && result.changes === 0) {
					const error = new Error("DB owner batch precondition changed zero rows");
					error.name = "DB_OWNER_NO_CHANGES";
					throw error;
				}
				results.push(result);
			}
			if (embeddingProjection) executeEmbeddingProjectionInTx(db, embeddingProjection);
			commit(context);
			return enforceResultLimit({ sql: "db-owner-batch", result: "all" }, results) as readonly unknown[];
		} catch (error) {
			try {
				db.exec("ROLLBACK");
			} catch {}
			throw error;
		}
	}

	function executeStatementWithoutTransaction(statement: DbOwnerStatement): SqliteRunResult {
		const params = (statement.params ?? []).map((value) => bindParameter(value, true));
		return db.prepare(statement.sql).run(...params);
	}

	async function executeSessionTranscriptWrite(
		request: Extract<DbOwnerJob["request"], { readonly kind: "session_transcript_write" }>,
		context: JobExecutionContext,
	): Promise<ReturnType<typeof writeSessionTranscriptRow>> {
		const { writeSessionTranscriptRow } = await import("./session-transcripts");
		db.exec("BEGIN IMMEDIATE");
		try {
			const result = writeSessionTranscriptRow(db as never, request.input);
			commit(context);
			return result;
		} catch (error) {
			db.exec("ROLLBACK");
			throw error;
		}
	}

	async function executeSessionCompactionSummary(
		request: Extract<DbOwnerJob["request"], { readonly kind: "session_compaction_summary" }>,
		context: JobExecutionContext,
	): Promise<boolean> {
		const { commitCompactionSummaryInTx } = await import("./session-transcripts");
		return withBusyRetry(() => commitCompactionSummaryInTx(db, request.input), context);
	}

	function executeTranscriptBulkCommit(
		request: Extract<DbOwnerJob["request"], { readonly kind: "transcript_bulk_commit" }>,
		context: JobExecutionContext,
	): unknown {
		db.exec("BEGIN IMMEDIATE");
		try {
			const result = commitTranscriptImportBatchInTx(db as never, request.input);
			commit(context);
			return result;
		} catch (error) {
			try {
				db.exec("ROLLBACK");
			} catch {}
			throw error;
		}
	}

	function executeSourceSnapshotImport(
		job: Extract<DbOwnerJob["request"], { readonly kind: "source_snapshot_import" }>,
		context?: JobExecutionContext,
	): unknown {
		db.exec("BEGIN IMMEDIATE");
		try {
			const result = applySourceSnapshotImportInTx(db as unknown as BunDatabase, job.input);
			commit(context);
			return result;
		} catch (error) {
			try {
				db.exec("ROLLBACK");
			} catch {}
			throw error;
		}
	}

	function executeVectorRepair(
		request: Extract<DbOwnerJob["request"], { readonly kind: "vector_repair" }>,
		context: JobExecutionContext,
	): unknown {
		db.exec("BEGIN IMMEDIATE");
		try {
			const result = applyVectorRepairBatch(db as never, request.input, {
				shouldAbort: () => {
					if (cancellationRequested(context.jobId)) throw new VectorRepairAbortError();
					if (Date.now() >= context.deadlineAt)
						throw new VectorRepairAbortError("vector repair owner deadline exceeded");
					return false;
				},
			});
			commit(context);
			return result;
		} catch (error) {
			try {
				db.exec("ROLLBACK");
			} catch {}
			if (error instanceof VectorRepairAbortError) throw new DbOwnerCancellationRequested();
			throw error;
		}
	}

	function executeDreamingHygieneAttention(
		request: Extract<DbOwnerJob["request"], { readonly kind: "dreaming_hygiene_attention" }>,
		context?: JobExecutionContext,
	): number {
		const candidates = getDreamingHygieneCandidatesInDb(db as never, request.input);
		db.exec("BEGIN IMMEDIATE");
		try {
			for (const candidate of candidates) {
				enqueueDreamingAttentionInTx(db as never, {
					agentId: request.input.agentId,
					kind: "hygiene",
					compartmentId: request.input.compartmentId,
					subjectRef: candidate.subjectRef,
					details: candidate.details,
					priority: candidate.priority,
					reopen: false,
				});
			}
			commit(context);
			return candidates.length;
		} catch (error) {
			try {
				db.exec("ROLLBACK");
			} catch {}
			throw error;
		}
	}

	function executeDreamingSurprisalAttention(
		request: Extract<DbOwnerJob["request"], { readonly kind: "dreaming_surprisal_attention" }>,
		context?: JobExecutionContext,
	): unknown {
		if (request.input.config.enabled === false) return null;
		const selection = selectDreamingSurprisalInDb(
			db as never,
			request.input.agentId,
			request.input.config,
			null,
			request.input.compartmentId,
		);
		if (selection.candidates.length === 0) return selection;
		db.exec("BEGIN IMMEDIATE");
		try {
			for (const candidate of selection.candidates) {
				enqueueDreamingAttentionInTx(db as never, {
					agentId: request.input.agentId,
					kind: "surprisal",
					compartmentId: request.input.compartmentId,
					subjectRef: `memory:${candidate.id}`,
					details: {
						selector: DREAMING_SURPRISAL_SELECTOR_VERSION,
						score: candidate.score.toFixed(6),
						rank: String(candidate.rank),
						sampleSize: String(candidate.sampleSize),
						dimensions: String(candidate.dimensions),
						capturedAt: candidate.capturedAt,
					},
					priority: Math.round(60 + candidate.score * 40),
					reopen: false,
				});
			}
			commit(context);
			return selection;
		} catch (error) {
			try {
				db.exec("ROLLBACK");
			} catch {}
			throw error;
		}
	}

	async function executeDreamingEpisodicBacklog(
		request: Extract<DbOwnerJob["request"], { readonly kind: "dreaming_episodic_backlog" }>,
	): Promise<number> {
		const { getDreamingEpisodicTokenBacklogInDb } = await import("./pipeline/dreaming");
		return await getDreamingEpisodicTokenBacklogInDb(
			db as never,
			request.input.agentId,
			request.input.compartmentId ?? null,
		);
	}

	async function executeDreamingEpisodicBacklogProbe(
		request: Extract<DbOwnerJob["request"], { readonly kind: "dreaming_episodic_backlog_probe" }>,
	): Promise<unknown> {
		const { probeDreamingEpisodicBacklogInDb } = await import("./pipeline/dreaming");
		return await probeDreamingEpisodicBacklogInDb(
			db as never,
			request.input.agentId,
			request.input.tokenThreshold,
			request.input.maxSources,
			request.input.compartmentId ?? null,
		);
	}

	async function executeDreamingEpisodicBacklogExists(
		request: Extract<DbOwnerJob["request"], { readonly kind: "dreaming_episodic_backlog_exists" }>,
	): Promise<boolean> {
		const { hasDreamingEpisodicBacklogInDb } = await import("./pipeline/dreaming");
		return hasDreamingEpisodicBacklogInDb(db as never, request.input.agentId, request.input.compartmentId ?? null);
	}

	async function executeDreamingEvidenceSearch(
		request: Extract<DbOwnerJob["request"], { readonly kind: "dreaming_evidence_search" }>,
	): Promise<unknown> {
		const { searchDreamingEvidenceInDb } = await import("./pipeline/dreaming-capabilities");
		return searchDreamingEvidenceInDb(db, request.input);
	}

	async function executeDreamingEvidenceSource(
		request: Extract<DbOwnerJob["request"], { readonly kind: "dreaming_evidence_source" }>,
	): Promise<unknown> {
		const { readDreamingEvidenceSourceInDb } = await import("./pipeline/dreaming-capabilities");
		return readDreamingEvidenceSourceInDb(db as never, request.input);
	}

	async function executeDreamingEvidenceReview(
		request: Extract<DbOwnerJob["request"], { readonly kind: "dreaming_evidence_review" }>,
	): Promise<unknown> {
		const { reviewDreamingEvidenceInDb } = await import("./pipeline/dreaming-evidence-consumption");
		return reviewDreamingEvidenceInDb(db as never, request.input);
	}

	async function executeDreamingPassFinalize(
		request: Extract<DbOwnerJob["request"], { readonly kind: "dreaming_pass_finalize" }>,
		context: JobExecutionContext,
	): Promise<null> {
		const { finalizeDreamingPassInDb } = await import("./pipeline/dreaming");
		withBusyRetry(() => {
			finalizeDreamingPassInDb(db as never, request.input);
			return null;
		}, context);
		if (request.input.mode === "incremental-content") {
			try {
				const { executeMemoryHead } = await import("./memory-head-owner");
				const publication = withBusyRetry(() =>
					executeMemoryHead(db, dirname(dirname(ownerDbPath)), {
						action: "publish",
						agentId: request.input.agentId,
					}),
				);
				if (publication.publication === "pending") {
					console.warn(
						`Dreaming pass ${request.input.passId} completed; MEMORY.md projection remains pending for agent ${request.input.agentId}`,
					);
				}
			} catch (error) {
				console.warn(
					`Dreaming pass ${request.input.passId} completed; MEMORY.md projection retry failed for agent ${request.input.agentId}: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
		}
		return null;
	}

	async function executeDreamingReviewDue(
		request: Extract<DbOwnerJob["request"], { readonly kind: "dreaming_review_due" }>,
	): Promise<unknown> {
		const { collectDreamingReviewDueInDb } = await import("./pipeline/dreaming-capabilities");
		return collectDreamingReviewDueInDb(db as never, request.input);
	}

	async function executeDreamingEvidenceClassify(
		request: Extract<DbOwnerJob["request"], { readonly kind: "dreaming_evidence_classify" }>,
	): Promise<unknown> {
		const { collectRejectedDreamingEvidenceInDb } = await import("./pipeline/dreaming-evidence-retry");
		return collectRejectedDreamingEvidenceInDb(
			db as never,
			request.input.agentId,
			request.input.result as never,
			request.input.operations as never,
			request.input.passId,
		);
	}

	async function executeDreamingEvidenceRequeue(
		request: Extract<DbOwnerJob["request"], { readonly kind: "dreaming_evidence_requeue" }>,
		context: JobExecutionContext,
	): Promise<number> {
		db.exec("BEGIN IMMEDIATE");
		try {
			const { autoRequeueRepairedDreamingEvidenceInDb } = await import("./pipeline/dreaming-evidence-retry");
			const affected = autoRequeueRepairedDreamingEvidenceInDb(db as never, request.input.policy, request.input.nowMs);
			commit(context);
			return affected;
		} catch (error) {
			try {
				db.exec("ROLLBACK");
			} catch {}
			throw error;
		}
	}

	function executeSourceArtifactUpsert(
		request: Extract<
			DbOwnerJob["request"],
			{ readonly kind: "source_artifact_upsert" | "source_artifact_upsert_batch" }
		>,
		context?: JobExecutionContext,
	): { readonly upserted: number } {
		const inputs = request.kind === "source_artifact_upsert" ? [request.input] : request.input;
		if (inputs.length === 0 || inputs.length > 50) throw new Error("DB owner artifact batch must contain 1 to 50 rows");
		db.exec("BEGIN IMMEDIATE");
		try {
			for (const input of inputs) {
				upsertMemoryArtifactInTx(db as unknown as BunDatabase, input.fields, {
					conflictGuardSourceId: input.conflictGuardSourceId,
				});
			}
			commit(context);
			return { upserted: inputs.length };
		} catch (error) {
			try {
				db.exec("ROLLBACK");
			} catch {}
			throw error;
		}
	}

	function executeSourceEvidenceEligibility(
		request: Extract<DbOwnerJob["request"], { readonly kind: "source_evidence_eligibility" }>,
	): boolean {
		return sourceHasEligibleUnconsumedEvidence(
			db as unknown as ReadDb,
			request.input.agentId,
			request.input.sourceEntryId,
			request.input.legacyObsidianRoot,
		);
	}

	async function executeDreamingEvidenceCoverage(
		request: Extract<DbOwnerJob["request"], { readonly kind: "dreaming_evidence_coverage" }>,
	): Promise<unknown> {
		const { scanDreamingEvidenceCoverageStep } = await import("./pipeline/dreaming-evidence-coverage");
		return scanDreamingEvidenceCoverageStep(db as unknown as ReadDb, request.input);
	}

	function executeSourceGraph(
		request: Extract<
			DbOwnerJob["request"],
			{ readonly kind: "source_graph_index" | "source_graph_file_purge" | "source_graph_purge" }
		>,
		context?: JobExecutionContext,
	): unknown {
		db.exec("BEGIN IMMEDIATE");
		try {
			let result: unknown;
			if (request.kind === "source_graph_index") {
				result = applyObsidianSourceStructureInTx(db as unknown as WriteDb, request.input);
			} else if (request.kind === "source_graph_file_purge") {
				result = purgeObsidianSourceFileStructureInTx(db as unknown as WriteDb, request.input);
			} else {
				result = applyObsidianSourceStructurePurgeInTx(db as unknown as WriteDb, request.input);
			}
			commit(context);
			return result;
		} catch (error) {
			try {
				db.exec("ROLLBACK");
			} catch {}
			throw error;
		}
	}

	function nativeMemoryArtifactFields(input: DbOwnerNativeMemoryIndex): MemoryArtifactUpsertFields {
		const sourcePath = input.sourcePath.replace(/\\/g, "/");
		const capturedAt = Number.isFinite(input.sourceMtimeMs)
			? new Date(input.sourceMtimeMs).toISOString()
			: new Date().toISOString();
		return {
			agentId: input.agentId,
			sourcePath,
			sourceSha256: input.sourceHash,
			author: input.author,
			sourceKind: input.sourceKind,
			sessionId: `native:${input.harness}:${sourcePath}`,
			sessionKey: `native:${input.harness}`,
			sessionToken: `native:${input.harness}`,
			project: null,
			harness: input.harness,
			capturedAt,
			startedAt: capturedAt,
			endedAt: capturedAt,
			manifestPath: null,
			sourceNodeId: NATIVE_MEMORY_BRIDGE_SOURCE_NODE_ID,
			memorySentence: `Indexed ${input.harness} native memory from ${sourcePath.split("/").at(-1) ?? sourcePath}.`,
			memorySentenceQuality: "fallback",
			content: input.content,
			updatedAt: new Date().toISOString(),
			sourceMtimeMs: input.sourceMtimeMs,
			sourceId: input.sourceId,
			sourceRoot: input.sourceRoot,
			sourceExternalId: input.sourceExternalId,
			sourceParentPath: input.sourceParentPath,
			sourceMetaJson: input.sourceMetaJson,
		};
	}

	interface NativeMemoryEmbeddingResult {
		readonly embedded: number;
		readonly skipped: number;
		readonly providerUnavailable: boolean;
	}

	async function executeNativeMemoryEmbeddings(
		input: DbOwnerNativeMemoryIndex,
		database: SqliteDatabase,
		context?: JobExecutionContext,
	): Promise<NativeMemoryEmbeddingResult> {
		const embedding = input.embedding;
		if (embedding === undefined || input.sourceId === null || embedding.config.provider === "none")
			return { embedded: 0, skipped: 0, providerUnavailable: false };
		const { fetchEmbedding } = await import("./embedding-fetch");
		const providerKey = `${embedding.config.provider}:${embedding.config.model}:${embedding.config.base_url ?? ""}`;
		let providerGate: Awaited<ReturnType<typeof awaitEmbeddingProviderAvailable>> | null = null;
		const ensureProviderAvailable = async (): Promise<boolean> => {
			if (providerGate !== null) return providerGate.available;
			providerGate = await awaitEmbeddingProviderAvailable(providerKey, undefined, 10_000);
			return providerGate.available;
		};
		const vecTable = activeVectorProjectionTable(database);
		const vecSchema = database
			.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?")
			.get(vecTable) as { sql?: string } | null;
		const vecAvailable = vecSchema !== null;
		const vecDimensions = vecSchema?.sql?.match(/float\\s*\\[\\s*(\\d+)\\s*\\]/i)?.[1];
		const currentHashes = new Set<string>();
		let embedded = 0;
		let skipped = 0;
		for (const chunk of embedding.chunks) {
			const contentHash = createHash("sha256")
				.update(`${input.agentId}\n${chunk.id}\n${chunk.chunkText}`)
				.digest("hex");
			const embeddingId = createHash("sha256")
				.update(`source_chunk:${input.agentId}:${chunk.id}`)
				.digest("hex")
				.slice(0, 32);
			currentHashes.add(contentHash);
			const existing = database
				.prepare(
					"SELECT id, content_hash FROM embeddings WHERE source_type IN (?, ?) AND source_id = ? AND agent_id = ? LIMIT 1",
				)
				.get("source_chunk", "obsidian_chunk", chunk.id, input.agentId) as { id: string; content_hash: string } | null;
			if (existing?.content_hash === contentHash) {
				skipped++;
				continue;
			}
			if (!(await ensureProviderAvailable()))
				return {
					embedded,
					skipped: embedding.chunks.length - embedded,
					providerUnavailable: true,
				};
			let failureCause = "provider_unavailable";
			const timeoutMs = context === undefined ? 30_000 : Math.max(1, Math.min(30_000, context.deadlineAt - Date.now()));
			const vector = await fetchEmbedding(chunk.chunkText, embedding.config as EmbeddingConfig, "document", {
				usage: { source: "artifact-index", agentId: input.agentId },
				timeoutMs,
				onFailure: (cause) => {
					failureCause = cause;
				},
			});
			if (vector === null || vector.length === 0) {
				if (failureCause === "provider_unavailable" || failureCause === "timeout") {
					recordEmbeddingProviderFailure(providerKey, 10_000);
					return {
						embedded,
						skipped: embedding.chunks.length - embedded,
						providerUnavailable: true,
					};
				}
				skipped++;
				continue;
			}
			database.exec("BEGIN IMMEDIATE");
			try {
				if (existing !== null) {
					if (vecAvailable) deleteCompartmentVectors(database, [existing.id]);
					database.prepare("DELETE FROM embeddings WHERE id = ?").run(existing.id);
				}
				database
					.prepare(
						`INSERT INTO embeddings
					 (id, content_hash, vector, dimensions, source_type, source_id, chunk_text, created_at, agent_id,compartment_id)
					 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?,?)
					 ON CONFLICT(id) DO UPDATE SET vector = excluded.vector, dimensions = excluded.dimensions,
					 source_type = excluded.source_type, source_id = excluded.source_id, chunk_text = excluded.chunk_text,
					 created_at = excluded.created_at, agent_id = excluded.agent_id,compartment_id=excluded.compartment_id`,
					)
					.run(
						embeddingId,
						contentHash,
						vectorToBlob(vector),
						vector.length,
						"source_chunk",
						chunk.id,
						chunk.chunkText,
						new Date().toISOString(),
						input.agentId,
						compartmentForWrite(database, { agentId: input.agentId, sourceId: chunk.id }),
					);
				if (vecAvailable && vecDimensions === String(vector.length)) {
					for (const stored of database.prepare("SELECT id FROM embeddings WHERE id=?").all(embeddingId))
						if (typeof stored === "object" && stored !== null && "id" in stored && typeof stored.id === "string")
							syncEmbeddingCompartment(database, "embeddings", stored.id, vecTable);
				}
				database.exec("COMMIT");
				if (context) context.committed = true;
			} catch (error) {
				database.exec("ROLLBACK");
				throw error;
			}
			embedded++;
		}
		const prefix = `${input.sourceId}:${input.sourceExternalId ?? input.sourcePath}#`;
		const stale = database
			.prepare(
				"SELECT id, content_hash, source_type FROM embeddings WHERE source_type IN (?, ?) AND source_id LIKE ? AND agent_id = ?",
			)
			.all("source_chunk", "obsidian_chunk", `${prefix}%`, input.agentId) as Array<{
			id: string;
			content_hash: string;
			source_type: string;
		}>;
		for (const row of stale) {
			if (row.source_type === "obsidian_chunk" || currentHashes.has(row.content_hash)) continue;
			if (vecAvailable) database.prepare(`DELETE FROM ${vecTable} WHERE id = ?`).run(row.id);
			database.prepare("DELETE FROM embeddings WHERE id = ?").run(row.id);
		}
		return { embedded, skipped, providerUnavailable: false };
	}

	async function executeNativeMemoryIndex(
		request: Extract<DbOwnerJob["request"], { readonly kind: "source_native_memory_index" }>,
		context?: JobExecutionContext,
	): Promise<{
		readonly artifactChanged: boolean;
		readonly graphIndexed: boolean;
		readonly embeddingProviderUnavailable: boolean;
	}> {
		const input = request.input;
		const sourcePath = input.sourcePath.replace(/\\/g, "/");
		const embeddingResult = await executeNativeMemoryEmbeddings(input, db, context);

		const checkpoint = embeddingResult.providerUnavailable
			? (input.checkpointOnProviderFailure ?? input.checkpoint)
			: input.checkpoint;
		const existing = db
			.prepare(
				"SELECT source_sha256 FROM memory_artifacts WHERE agent_id = ? AND source_path = ? AND COALESCE(is_deleted, 0) = 0 LIMIT 1",
			)
			.get(input.agentId, sourcePath) as { source_sha256: string } | null | undefined;
		const artifactChanged = existing?.source_sha256 !== input.sourceHash;
		const graphCurrent =
			input.graph !== undefined &&
			!artifactChanged &&
			isObsidianSourceFileIndexedInTx(db as unknown as WriteDb, {
				agentId: input.agentId,
				sourceId: input.graph.sourceId,
				filePath: sourcePath,
			});
		const graphIndexed = input.graph !== undefined && !graphCurrent;
		db.exec("BEGIN IMMEDIATE");
		try {
			if (artifactChanged) upsertMemoryArtifactInTx(db as unknown as BunDatabase, nativeMemoryArtifactFields(input));
			if (checkpoint !== undefined) {
				db.prepare(
					`UPDATE source_sync_failures
					 SET resolved_at = datetime('now'), last_observed_at = datetime('now')
					 WHERE agent_id = ? AND source_key = ? AND phase = 'content'
					   AND item_path = ? AND resolved_at IS NULL`,
				).run(input.agentId, checkpoint.sourceKey, sourcePath);
			}
			if (graphIndexed && input.graph !== undefined) {
				applyObsidianSourceStructureInTx(db as unknown as WriteDb, {
					agentId: input.agentId,
					sourceId: input.graph.sourceId,
					sourceName: input.graph.sourceName,
					root: input.graph.root,
					filePath: sourcePath,
					content: input.content,
				});
			}
			if (checkpoint !== undefined) {
				db.prepare(
					`INSERT INTO source_sync_checkpoints
					 (agent_id, source_key, phase, cursor, frontier, scanned, complete, updated_at)
					 VALUES (?, ?, 'content', ?, ?, ?, ?, datetime('now'))
					 ON CONFLICT(agent_id, source_key, phase) DO UPDATE SET
					 cursor = excluded.cursor,
					 frontier = excluded.frontier,
					 scanned = excluded.scanned,
					 complete = excluded.complete,
					 updated_at = excluded.updated_at`,
				).run(
					input.agentId,
					checkpoint.sourceKey,
					checkpoint.cursor,
					checkpoint.frontier === null ? null : JSON.stringify(checkpoint.frontier),
					checkpoint.scanned,
					checkpoint.complete ? 1 : 0,
				);
			}
			commit(context);
			return {
				artifactChanged,
				graphIndexed,
				embeddingProviderUnavailable: embeddingResult.providerUnavailable,
			};
		} catch (error) {
			try {
				db.exec("ROLLBACK");
			} catch {}
			throw error;
		}
	}

	function executeSourceArtifactIndex(
		request: Extract<DbOwnerJob["request"], { readonly kind: "source_artifact_index" }>,
		context?: JobExecutionContext,
	): unknown {
		db.exec("BEGIN IMMEDIATE");
		try {
			const result = indexSourceArtifactStructureInTx(db as unknown as WriteDb, request.input);
			commit(context);
			return result;
		} catch (error) {
			try {
				db.exec("ROLLBACK");
			} catch {}
			throw error;
		}
	}

	function executeSourceArtifactPurge(
		request: Extract<DbOwnerJob["request"], { readonly kind: "source_artifact_purge" }>,
		context?: JobExecutionContext,
	): unknown {
		db.exec("BEGIN IMMEDIATE");
		try {
			const result = purgeSourceArtifactStructureInTx(db as unknown as WriteDb, request.input);
			commit(context);
			return result;
		} catch (error) {
			try {
				db.exec("ROLLBACK");
			} catch {}
			throw error;
		}
	}

	let recallAccessorReady = false;

	async function executeRecall(payload: DbOwnerRecallPayload): Promise<unknown> {
		if (writeBlocked) {
			const error = new Error("DB owner writes are blocked while database integrity is unresolved");
			error.name = "DB_OWNER_WRITES_BLOCKED";
			throw error;
		}
		if (!recallAccessorReady) {
			const { initDbAccessorAsync } = await import("./db-accessor");
			await initDbAccessorAsync(ownerDbPath);
			recallAccessorReady = true;
		}
		const { getDbAccessor } = await import("./db-accessor");
		const { resolveActiveEmbeddingConfig } = await import("./embedding-index-state");
		const { hybridRecall } = await import("./memory-search");
		const config = payload.config as Parameters<typeof hybridRecall>[1];
		const agentId = payload.agentId ?? (await import("./agent-id")).resolveDaemonAgentId();
		if (config.pipelineV2.reranker.enabled && config.pipelineV2.reranker.useExtractionModel) {
			const { resolveDefaultBasePath } = await import("@signet/core");
			const { getOrCreateInferenceRouter } = await import("./inference-router");
			const { initInferenceProviderResolver } = await import("./llm");
			const router = getOrCreateInferenceRouter(resolveDefaultBasePath());
			initInferenceProviderResolver((workload) => {
				switch (workload) {
					case "memoryExtraction":
						return router.createWorkloadProvider("memory_extraction", agentId);
					case "sessionSynthesis":
						return router.createWorkloadProvider("session_synthesis", agentId);
					case "aggregateRecall":
						return router.createWorkloadProvider("aggregate_recall", agentId);
					case "repair":
						return router.createWorkloadProvider("repair", agentId);
					case "interactive":
						return router.createWorkloadProvider("interactive", agentId);
					case "default":
						return router.createWorkloadProvider("default", agentId);
				}
			});
		}
		const embedding = await getDbAccessor().withReadDbAsync(
			async (db) => resolveActiveEmbeddingConfig(db, config.embedding),
			{ siteToken: "db:recall.embedding.config.read", operation: "recall.resolve-active-embedding" },
		);
		const query = payload.query;
		const queryEmbedding: Promise<readonly number[] | null> =
			payload.queryEmbedding !== undefined
				? Promise.resolve(payload.queryEmbedding)
				: query === undefined
					? Promise.resolve(null)
					: import("./embedding-fetch").then(({ fetchEmbedding }) =>
							fetchEmbedding(query, embedding, "query", {
								usage: { source: "recall", agentId },
							}),
						);
		queryEmbedding.catch(() => undefined);
		return await hybridRecall(
			payload.params as Parameters<typeof hybridRecall>[0],
			{ ...config, embedding },
			async () => {
				const vector = await queryEmbedding;
				return vector === null ? null : [...vector];
			},
		);
	}

	async function executeVectorSearch(payload: DbOwnerVectorSearchPayload): Promise<unknown> {
		if (!recallAccessorReady) {
			const { initDbAccessorAsync } = await import("./db-accessor");
			await initDbAccessorAsync(ownerDbPath);
			recallAccessorReady = true;
		}
		const { getDbAccessor } = await import("./db-accessor");
		return await getDbAccessor().withReadDbAsync(
			(db) =>
				vectorSearchWithMetadata(db, new Float32Array(payload.queryEmbedding), {
					...payload.options,
					readScope: requireReadScope(payload.options.readScope),
				}),
			{ siteToken: "db:recall.vector.search.read", operation: "recall.vector-search" },
		);
	}

	async function executeInitialization(agentsDir: string | undefined, context?: JobExecutionContext): Promise<unknown> {
		const startedMarker = process.env.SIGNET_DB_OWNER_TEST_INIT_STARTED;
		const releaseMarker = process.env.SIGNET_DB_OWNER_TEST_INIT_RELEASE;
		if (startedMarker !== undefined && releaseMarker !== undefined) {
			writeFileSync(startedMarker, "started\n");
			while (!existsSync(releaseMarker)) await new Promise((resolve) => setTimeout(resolve, 5));
		}
		const { initDbAccessorAsync } = await import("./db-accessor");
		const initialization = await initDbAccessorAsync(ownerDbPath, { agentsDir, deadlineAt: context?.deadlineAt });
		recallAccessorReady = true;
		try {
			const { refreshQueryPlannerStatisticsOnOpen } = await import("./query-planner-statistics");
			refreshQueryPlannerStatisticsOnOpen(db);
		} catch (error) {
			writeDiagnostic(
				`[db-owner] query planner statistics refresh failed: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
		if (context !== undefined) context.committed = true;
		return {
			initialized: true,
			pendingVecBackfill: initialization.pendingVecBackfill,
			...(initialization.extensionPath !== undefined ? { extensionPath: initialization.extensionPath } : {}),
			...(initialization.deferredMigrationVerification ? { deferredMigrationVerification: true } : {}),
		};
	}

	function installAuthorityEpoch(): void {
		db.exec(
			"CREATE TEMP TABLE IF NOT EXISTS signet_authority_epoch (id INTEGER PRIMARY KEY CHECK(id=1), epoch INTEGER NOT NULL); INSERT OR IGNORE INTO signet_authority_epoch VALUES (1,0)",
		);
		authorityEpochReady = true;
		for (const table of [
			...AUTHORITY_TABLES,
			"classifications",
			"classification_audience",
			"classification_assignments",
			"compartments",
			"compartment_members",
			"org_jobs",
		]) {
			const columns = db
				.prepare(`PRAGMA table_info("${table}")`)
				.all()
				.flatMap((row) => {
					if (typeof row !== "object" || row === null || !("name" in row) || typeof row.name !== "string") return [];
					return [row.name];
				});
			if (columns.length === 0) continue;
			for (const event of ["INSERT", "DELETE", "UPDATE"])
				db.exec(`DROP TRIGGER IF EXISTS temp."signet_authority_${table}_${event}"`);
			for (const event of ["INSERT", "DELETE"])
				db.exec(
					`CREATE TEMP TRIGGER IF NOT EXISTS "signet_authority_${table}_${event}" AFTER ${event} ON main."${table}" BEGIN UPDATE signet_authority_epoch SET epoch=epoch+1 WHERE id=1; END`,
				);
			const changed = columns
				.filter(
					(column) =>
						![
							"last_used_at",
							"last_seen_at",
							"updated_at",
							...(table === "org_jobs" ? ["progress_json"] : []),
						].includes(column),
				)
				.map((column) => {
					const quoted = `"${column.replaceAll('"', '""')}"`;
					return `OLD.${quoted} IS NOT NEW.${quoted}`;
				})
				.join(" OR ");
			if (changed)
				db.exec(
					`CREATE TEMP TRIGGER IF NOT EXISTS "signet_authority_${table}_UPDATE" AFTER UPDATE ON main."${table}" WHEN ${changed} BEGIN UPDATE signet_authority_epoch SET epoch=epoch+1 WHERE id=1; END`,
				);
		}
	}

	function installHeadInvalidation(): void {
		db.exec(
			"CREATE TEMP TABLE IF NOT EXISTS signet_head_dependencies(cache_key TEXT NOT NULL, agent_id TEXT NOT NULL, kind TEXT NOT NULL, source_id TEXT NOT NULL, compartment_id INTEGER, PRIMARY KEY(cache_key,kind,source_id,compartment_id)); CREATE INDEX IF NOT EXISTS temp.signet_head_dependency_source ON signet_head_dependencies(kind,source_id,agent_id,compartment_id); CREATE TEMP TABLE IF NOT EXISTS signet_head_scopes(cache_key TEXT PRIMARY KEY,agent_id TEXT NOT NULL,compartments_json TEXT); CREATE TEMP TABLE IF NOT EXISTS signet_head_dirty(cache_key TEXT PRIMARY KEY)",
		);
		for (const [table, kind, id] of [
			["memories", "memory", "id"],
			["memory_artifacts", "artifact", "source_path"],
			["session_transcripts", "transcript", "session_key"],
			["session_summaries", "summary", "id"],
		]) {
			if (
				table === undefined ||
				kind === undefined ||
				id === undefined ||
				!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)
			)
				continue;
			const columns = db
				.prepare(`PRAGMA table_info("${table}")`)
				.all<{ name: string }>()
				.map((row) => row.name);
			if (
				![
					"agent_id",
					"compartment_id",
					id,
					...(table === "memory_artifacts" ? ["source_node_id", "session_id", "session_key", "session_token"] : []),
				].every((column) => columns.includes(column))
			)
				continue;
			for (const operation of ["INSERT", "UPDATE", "DELETE"]) {
				const readable = (reference: string) =>
					`d.source_id IN (${(table === "memory_artifacts" ? ["source_path", "source_node_id", "session_id", "session_key", "session_token"] : [id]).map((column) => `${reference}.${column}`).join(",")}) AND d.agent_id=${reference}.agent_id AND (${reference}.compartment_id IS NULL OR s.compartments_json IS NULL OR EXISTS(SELECT 1 FROM json_each(s.compartments_json) WHERE value=${reference}.compartment_id))`;
				const changed =
					operation === "DELETE"
						? readable("OLD")
						: operation === "INSERT"
							? readable("NEW")
							: `((${readable("OLD")}) OR (${readable("NEW")}))`;
				db.exec(
					`CREATE TEMP TRIGGER IF NOT EXISTS signet_head_${table}_${operation} AFTER ${operation} ON main.${table} BEGIN INSERT INTO signet_head_dirty SELECT DISTINCT d.cache_key FROM signet_head_dependencies d JOIN signet_head_scopes s ON s.cache_key=d.cache_key WHERE d.kind='${kind}' AND (${changed}) AND NOT EXISTS(SELECT 1 FROM signet_head_dirty WHERE cache_key=d.cache_key); END`,
				);
			}
		}
		for (const table of [
			"memory_md_heads",
			"memory_head_revisions",
			"memory_head_entries",
			"memory_head_revision_entries",
		]) {
			if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)) continue;
			const columns = db
				.prepare(`PRAGMA table_info("${table}")`)
				.all<{ name: string }>()
				.map((row) => row.name);
			if (!columns.includes("agent_id") || (table !== "memory_md_heads" && !columns.includes("compartment_id")))
				continue;
			for (const operation of ["INSERT", "UPDATE", "DELETE"]) {
				const reference = operation === "DELETE" ? "OLD" : "NEW";
				const readable = (row: string) =>
					`s.agent_id=${row}.agent_id AND (${table === "memory_md_heads" ? "1=1" : `${row}.compartment_id IS NULL OR s.compartments_json IS NULL OR EXISTS(SELECT 1 FROM json_each(s.compartments_json) WHERE value=${row}.compartment_id)`})`;
				const agentMatch =
					operation === "UPDATE" ? `((${readable("OLD")}) OR (${readable("NEW")}))` : readable(reference);
				db.exec(
					`CREATE TEMP TRIGGER IF NOT EXISTS signet_head_${table}_${operation} AFTER ${operation} ON main.${table} BEGIN INSERT INTO signet_head_dirty SELECT cache_key FROM signet_head_scopes s WHERE ${agentMatch} AND NOT EXISTS(SELECT 1 FROM signet_head_dirty WHERE cache_key=s.cache_key); END`,
				);
			}
		}
	}

	async function execute(job: DbOwnerJob, context: JobExecutionContext): Promise<unknown> {
		if (job.request.kind === "session_start_candidates") {
			if (job.lane !== "read") throw new Error("Candidate pools require the read lane");
			const scope = requireReadScope(job.request.scope);
			const limit = job.request.limit;
			if (!Number.isSafeInteger(limit) || limit < 0 || limit > 10000) throw new Error("Invalid candidate pool limit");
			const { currentMemorySql } = await import("./memory-search");
			const visible = readScopeSql("m", scope);
			return executeReadOnlyStatement({
				readonly: true,
				result: "all",
				params: [...visible.args, limit],
				sql: `WITH candidate_window AS MATERIALIZED (
			 SELECT m.rowid AS candidate_rowid,m.created_at FROM memories m
			 WHERE 1=1${currentMemorySql("m")}${visible.sql}
			 ORDER BY m.created_at DESC LIMIT ?
			) SELECT m.id,m.content,m.type,m.importance,m.tags,m.pinned,m.project,m.created_at,
			 m.source_type,m.source_id,COALESCE(m.access_count,0) AS access_count
			 FROM candidate_window c JOIN memories m ON m.rowid=c.candidate_rowid ORDER BY c.created_at DESC`,
			});
		}
		if (job.request.kind === "initialize") {
			const value = await executeInitialization(job.request.agentsDir, context);
			installAuthorityEpoch();
			installHeadInvalidation();
			return value;
		}
		if (job.request.kind === "auth_observations") {
			if (job.lane === "read" || job.request.observations.length > 128)
				throw new Error("Invalid authentication observation batch");
			const until = performance.now() + 20;
			let applied = 0;
			db.exec("BEGIN IMMEDIATE");
			try {
				for (const observation of job.request.observations) {
					if (applied > 0 && performance.now() >= until) break;
					if (!/^[a-zA-Z0-9_-]{1,128}$/.test(observation.id) || !Number.isFinite(Date.parse(observation.at)))
						throw new Error("Invalid authentication observation");
					const table =
						observation.kind === "api_key"
							? "api_keys"
							: observation.kind === "session"
								? "auth_sessions"
								: observation.kind === "device"
									? "devices"
									: null;
					if (table === null) throw new Error("Invalid authentication observation kind");
					const column = table === "devices" ? "last_seen_at" : "last_used_at";
					db.prepare(`UPDATE ${table} SET ${column}=? WHERE id=? AND (${column} IS NULL OR ${column}<=?)`).run(
						observation.at,
						observation.id,
						new Date(Date.parse(observation.at) - 60000).toISOString(),
					);
					applied++;
				}
				commit(context);
				return applied;
			} catch (error) {
				db.exec("ROLLBACK");
				throw error;
			}
		}
		if (job.request.kind === "query") {
			return job.request.statement.readonly
				? executeReadOnlyStatement(job.request.statement)
				: executeStatement(job.request.statement, context);
		}
		if (job.request.kind === "content_read") {
			const { executeContentRead } = await import("./content-read-owner");
			return executeContentRead(db, job.request.request, () => {
				if (cancellationRequested(job.id)) throw new DbOwnerCancellationRequested();
				if (job.lane === "read" && Date.now() >= job.deadlineAt)
					throw Object.assign(new Error("DB owner content read exceeded its deadline"), { code: "DB_OWNER_DEADLINE" });
			});
		}
		if (job.request.kind === "embedding_projection") {
			const { executeEmbeddingProjection } = await import("./embedding-projection-owner");
			const result = executeEmbeddingProjection(db, job.request.request);
			context.committed = true;
			return result;
		}
		if (job.request.kind === "fts_partition") {
			const { createMemoriesFts, recreateMemoriesFtsSchema } = await import("@signet/core");
			db.exec("BEGIN IMMEDIATE");
			try {
				if (job.request.action === "rebuild") recreateMemoriesFtsSchema(db);
				else createMemoriesFts(db);
				db.exec("COMMIT");
				context.committed = true;
				return { ok: true };
			} catch (error) {
				db.exec("ROLLBACK");
				throw error;
			}
		}
		if (job.request.kind === "operator_job") {
			const { executeOperatorJob } = await import("./operator-jobs-owner");
			const result = executeOperatorJob(db, job.request.request);
			context.committed = true;
			return result;
		}
		if (job.request.kind === "database_probe") {
			if (job.lane !== "read") throw new Error("Database probes require the read lane");
			return db.prepare("SELECT 1").get();
		}
		if (job.request.kind === "classification") {
			const { executeClassification } = await import("./classification-owner");
			const request = job.request.request;
			const result =
				request.op === "execute" || request.op === "rebuild"
					? withWritePrincipal(undefined, () => executeClassification(db, request))
					: executeClassification(db, request);
			context.committed = true;
			return result;
		}
		if (job.request.kind === "memory_head") {
			const { executeMemoryHead } = await import("./memory-head-owner");
			const request = job.request.request;
			if (request.action === "inspect") {
				if (Buffer.byteLength(request.content) > 262144) throw new Error("Memory file exceeds inspection budget");
				const scope = requireReadScope(request.readScope);
				const version = db.prepare("PRAGMA data_version").get()?.data_version;
				if (version !== headDataVersion) {
					scopedHeads.clear();
					headClassificationScopes.clear();
					headDataVersion = version;
				}
				const head = db
					.prepare("SELECT revision,revision_id,content_hash,is_current FROM memory_md_heads WHERE agent_id=?")
					.get(request.agentId);
				const epoch = db.prepare("SELECT epoch FROM temp.signet_authority_epoch WHERE id=1").get()?.epoch;
				const { inFlightUserId, ...readerScope } = scope;
				let classificationScope = "";
				if (inFlightUserId !== undefined) {
					const scopeKey = JSON.stringify([request.agentId, inFlightUserId, epoch]);
					if (Buffer.byteLength(scopeKey) > 512) return executeMemoryHead(db, dirname(dirname(ownerDbPath)), request);
					const known = headClassificationScopes.get(scopeKey);
					if (known !== undefined) classificationScope = known;
					else {
						const blocked = db
							.prepare(
								`SELECT j.id FROM org_jobs j WHERE ${inFlightClassificationSql("j")} AND json_extract(CASE WHEN json_valid(j.params_json) THEN j.params_json ELSE '{}' END,'$.target.agentId')=? ORDER BY j.id LIMIT 129`,
							)
							.all<{ id: string }>(inFlightUserId, inFlightUserId, request.agentId);
						if (
							blocked.length > 128 ||
							blocked.some((row) => typeof row.id !== "string" || Buffer.byteLength(row.id) > 128)
						)
							return executeMemoryHead(db, dirname(dirname(ownerDbPath)), request);
						classificationScope =
							blocked.length === 0 ? "" : createHash("sha256").update(JSON.stringify(blocked)).digest("hex");
						if (headClassificationScopes.size >= 2048) headClassificationScopes.clear();
						headClassificationScopes.set(scopeKey, classificationScope);
					}
				}
				const key = createHash("sha256")
					.update(JSON.stringify([request.agentId, readerScope, classificationScope]))
					.digest("hex");
				const fence = JSON.stringify([head, epoch, createHash("sha256").update(request.content).digest("hex")]);
				const cached = scopedHeads.get(key, fence);
				if (cached !== undefined) return cached;
				const dependencies = new Set<string>();
				const result = executeMemoryHead(db, dirname(dirname(ownerDbPath)), request, dependencies);
				if (
					result.generated === true &&
					(result.status === "current" || result.status === "stale") &&
					(typeof result.content === "string" || result.content === null) &&
					dependencies.size <= 12800 &&
					[...dependencies].reduce((bytes, value) => bytes + Buffer.byteLength(value), 0) <= 262144 &&
					Buffer.byteLength(JSON.stringify(scope)) <= 32768 &&
					scope.projects === null
				) {
					scopedHeads.set(key, fence, { generated: true, status: result.status, content: result.content });
					try {
						if (scopedHeads.get(key, fence) !== undefined) {
							db.prepare("INSERT INTO temp.signet_head_scopes(cache_key,agent_id,compartments_json) VALUES(?,?,?)").run(
								key,
								request.agentId,
								scope.compartments === "all" ? null : JSON.stringify(scope.compartments),
							);
							db.prepare(
								"INSERT INTO temp.signet_head_dependencies(cache_key,agent_id,kind,source_id) VALUES(?,?,'head',?)",
							).run(key, request.agentId, request.agentId);
							for (const reference of dependencies) {
								const dependency: unknown = JSON.parse(reference);
								if (
									!Array.isArray(dependency) ||
									typeof dependency[0] !== "string" ||
									typeof dependency[1] !== "string" ||
									!(dependency[2] === null || typeof dependency[2] === "number")
								)
									throw new Error("Invalid scoped head dependency");
								db.prepare(
									"INSERT INTO temp.signet_head_dependencies(cache_key,agent_id,kind,source_id,compartment_id) VALUES(?,?,?,?,?)",
								).run(key, request.agentId, dependency[0], dependency[1], dependency[2]);
							}
						}
					} catch (error) {
						scopedHeads.invalidate(key);
						throw error;
					}
				}
				return result;
			}
			if (request.action === "read") return executeMemoryHead(db, dirname(dirname(ownerDbPath)), request);
			if (job.lane !== "write") throw new Error("Memory head mutation requires the write lane");
			return withBusyRetry(() => executeMemoryHead(db, dirname(dirname(ownerDbPath)), request), context);
		}
		if (job.request.kind === "transaction") return executeTransaction(job.request.transaction.statements, context);
		if (job.request.kind === "batch")
			return executeBatch(
				job.request.statements,
				job.request.requireChanges === true,
				context,
				job.request.embeddingProjection,
			);
		if (job.request.kind === "source_snapshot_import") return executeSourceSnapshotImport(job.request, context);
		if (job.request.kind === "vector_repair") return executeVectorRepair(job.request, context);
		if (job.request.kind === "session_transcript_lifecycle") {
			const { updateTranscriptLifecycleInTx } = await import("./session-transcripts");
			const input = job.request.input;
			return withBusyRetry(() => updateTranscriptLifecycleInTx(db, input), context);
		}
		if (job.request.kind === "transcript_capture_transition") {
			const { transitionTranscriptCaptureInTx } = await import("./transcript-capture-owner");
			const input = job.request.input;
			return withBusyRetry(() => transitionTranscriptCaptureInTx(db, input), context);
		}
		if (job.request.kind === "transcript_capture_enqueue") {
			const { enqueueTranscriptCaptureInTx } = await import("./transcript-capture-owner");
			const input = job.request.input;
			return withBusyRetry(() => enqueueTranscriptCaptureInTx(db, input), context);
		}

		if (job.request.kind === "session_transcript_capture") {
			const { captureSessionTranscriptOwned } = await import("./session-transcripts");
			const root = bindTranscriptWorkspace(job.request.input.input.basePath);
			const result = await captureSessionTranscriptOwned(db, job.request.input, root);
			context.committed = true;
			return result;
		}
		if (job.request.kind === "session_transcript_delete") {
			const { deleteSessionTranscriptOwned } = await import("./session-transcripts");
			const root = bindTranscriptWorkspace(job.request.input.basePath);
			return await deleteSessionTranscriptOwned(
				db,
				job.request.input,
				root,
				(operation) => withBusyRetry(operation, context),
				context.deadlineAt,
			);
		}
		if (job.request.kind === "transcript_bulk_commit") return executeTranscriptBulkCommit(job.request, context);
		if (job.request.kind === "filesystem_document_write") {
			const { writeFilesystemDocumentInTx } = await import("./embedding-projection-owner");
			const request = job.request;
			return withBusyRetry(() => writeFilesystemDocumentInTx(db, request.input), context);
		}
		if (job.request.kind === "session_finalizer_author") {
			const { readSessionFinalizerAuthorInTx } = await import("./db-helpers");
			return readSessionFinalizerAuthorInTx(db, job.request.agentId, job.request.sessionKey);
		}
		if (job.request.kind === "session_checkpoint_write") {
			const { writeSessionCheckpointInTx } = await import("./session-transcripts");
			const request = job.request;
			return withBusyRetry(() => writeSessionCheckpointInTx(db, request.input, request.maxPerSession), context);
		}
		if (job.request.kind === "session_transcript_write")
			return await executeSessionTranscriptWrite(job.request, context);
		if (job.request.kind === "session_compaction_summary")
			return await executeSessionCompactionSummary(job.request, context);
		if (job.request.kind === "dreaming_hygiene_attention") return executeDreamingHygieneAttention(job.request, context);
		if (job.request.kind === "dreaming_surprisal_attention")
			return executeDreamingSurprisalAttention(job.request, context);
		if (job.request.kind === "dreaming_episodic_backlog") return await executeDreamingEpisodicBacklog(job.request);
		if (job.request.kind === "dreaming_episodic_backlog_probe")
			return await executeDreamingEpisodicBacklogProbe(job.request);
		if (job.request.kind === "dreaming_episodic_backlog_exists")
			return await executeDreamingEpisodicBacklogExists(job.request);
		if (job.request.kind === "dreaming_read_scope") {
			const { readDreamingScopeInDb } = await import("./pipeline/dreaming-capabilities");
			return readDreamingScopeInDb(db, job.request.input);
		}
		if (job.request.kind === "dreaming_graph_read") {
			const { readDreamingGraphInDb } = await import("./pipeline/dreaming-capabilities");
			return readDreamingGraphInDb(db, job.request.input);
		}
		if (job.request.kind === "dreaming_evidence_search") return await executeDreamingEvidenceSearch(job.request);
		if (job.request.kind === "dreaming_evidence_prepare") {
			if (job.lane !== "write") throw new Error("Dreaming evidence preparation requires the write lane");
			const { prepareDreamingEvidenceInDb } = await import("./pipeline/dreaming-capabilities");
			const input = job.request.input;
			return withBusyRetry(() => prepareDreamingEvidenceInDb(db, input), context);
		}
		if (job.request.kind === "dreaming_imported_source_attention") {
			if (job.lane !== "write") throw new Error("Imported source attention requires the write lane");
			const { importedSourceAttentionUpsert } = await import("./pipeline/dreaming-evidence-consumption");
			const input = job.request;
			return withBusyRetry(() => {
				importedSourceAttentionUpsert(db, input.agentId, input.sourceId);
				return { ok: true };
			}, context);
		}
		if (job.request.kind === "dreaming_evidence_source") return await executeDreamingEvidenceSource(job.request);
		if (job.request.kind === "dreaming_evidence_review") return await executeDreamingEvidenceReview(job.request);
		if (job.request.kind === "dreaming_pass_finalize") return executeDreamingPassFinalize(job.request, context);
		if (job.request.kind === "dreaming_review_due") return await executeDreamingReviewDue(job.request);
		if (job.request.kind === "dreaming_evidence_classify") return await executeDreamingEvidenceClassify(job.request);
		if (job.request.kind === "dreaming_evidence_manual_requeue") {
			if (job.lane !== "write") throw new Error("Manual requeue requires the write lane");
			const input = job.request.input;
			const { requestDreamingEvidenceRequeueInDb } = await import("./pipeline/dreaming");
			const { requestDreamingReviewedEvidenceRequeueInTx } = await import("./pipeline/dreaming-evidence-reviews");
			db.exec("BEGIN IMMEDIATE");
			try {
				const changed = input.reviewed
					? requestDreamingReviewedEvidenceRequeueInTx(
							db,
							input.agentId,
							input.sourceKind,
							input.sourceId,
							input.readScope,
						)
					: requestDreamingEvidenceRequeueInDb(db, input.agentId, input.sourceKind, input.sourceId, input.readScope);
				commit(context);
				return changed;
			} catch (error) {
				db.exec("ROLLBACK");
				throw error;
			}
		}
		if (job.request.kind === "dreaming_evidence_requeue")
			return await executeDreamingEvidenceRequeue(job.request, context);
		if (job.request.kind === "embedding_migration_progress") {
			const { readEmbeddingIndexMigrationProgress } = await import("./embedding-index-state");
			return readEmbeddingIndexMigrationProgress(
				db as never,
				job.request.configuredBaseUrl === undefined
					? undefined
					: ({ base_url: job.request.configuredBaseUrl } as never),
			);
		}
		if (job.request.kind === "health_ready") {
			const { hasPendingMigrations } = await import("@signet/core");
			const { getQueueHealth } = await import("./diagnostics");
			return {
				migrationsOk: !hasPendingMigrations(db as never),
				queueHealth: getQueueHealth(db as never),
			};
		}
		if (job.request.kind === "diagnostics") {
			const { getDiagnostics } = await import("./diagnostics");
			return getDiagnostics(db as never, {
				record: () => {},
				stats: job.request.trackerStats,
			});
		}
		if (job.request.kind === "source_artifact_upsert" || job.request.kind === "source_artifact_upsert_batch")
			return executeSourceArtifactUpsert(job.request, context);
		if (job.request.kind === "source_purge") {
			db.exec("BEGIN IMMEDIATE");
			try {
				const input = job.request.input;
				const purged = purgeSourceOwnedRowsInTx(db as never, {
					sourceId: input.sourceId,
					agentId: input.agentId,
				});
				const transcriptPurged = purgeTranscriptImportSourceInTx(db as never, input.agentId, input.sourceId);
				commit(context);
				return { purged: purged + transcriptPurged };
			} catch (error) {
				try {
					db.exec("ROLLBACK");
				} catch {}
				throw error;
			}
		}
		if (job.request.kind === "reflection_generate") {
			const { txCreateDailyReflections } = await import("./reflection-owner");
			const input = job.request.input;
			return withBusyRetry(() => txCreateDailyReflections(db, input), context);
		}
		if (job.request.kind === "diagnostics_schema")
			return (await import("./diagnostics")).readDatabaseSchemaAsync(db, job.request.scope);
		if (job.request.kind === "diagnostics_sample")
			return (await import("./diagnostics")).readTableSampleAsync(
				db,
				job.request.table,
				job.request.limit,
				job.request.offset,
				job.request.scope,
			);
		if (job.request.kind === "search_telemetry_export_page")
			return (await import("./diagnostics")).readSearchTelemetryExportPage(job.request.query, job.request.cursor, db);
		if (job.request.kind === "search_telemetry_read")
			return (await import("./diagnostics")).readScopedSearchTelemetry(job.request.query, db);
		if (job.request.kind === "queue_diagnostics_read")
			return (await import("./diagnostics-queue")).getQueueDiagnosticsSnapshot(db, {
				scope: job.request.scope,
				fresh: true,
			});

		if (job.request.kind === "dreaming_reviewed_read")
			return (await import("./content-read-owner")).readDreamingReviewedEvidenceInOwner(
				db,
				job.request.agentId,
				job.request.scope,
			);
		if (job.request.kind === "reflection_list") {
			const { readReflectionsInOwner } = await import("./reflection-owner");
			return readReflectionsInOwner(db, job.request.scope, job.request.input);
		}
		if (job.request.kind === "reflection_get") {
			const { readReflectionInOwner } = await import("./reflection-owner");
			return readReflectionInOwner(db, job.request.scope, job.request.id);
		}
		if (job.request.kind === "reflection_answer") {
			const { txAnswerReflection } = await import("./reflection-owner");
			const input = job.request.input;
			return withBusyRetry(() => txAnswerReflection(db, input), context);
		}
		if (job.request.kind === "connector_errors") {
			const { connectorErrorsInOwner } = await import("./auth/audit-owner");
			return connectorErrorsInOwner(db, ownerDbPath, job.request.input);
		}
		if (job.request.kind === "organization_purge_plan") {
			const { planOffboardPurgeInTx } = await import("./auth/organization-purge");
			return planOffboardPurgeInTx(db, job.request.userId, job.request.scope, job.request.classificationId);
		}
		if (job.request.kind === "organization_memory_purge") {
			const { purgeAuthoredMemoryBatchInTx } = await import("./auth/organization-purge");
			const userId = job.request.userId;
			const author = job.request.author;
			const options = { scope: job.request.scope, classificationId: job.request.classificationId };
			return withBusyRetry(() => purgeAuthoredMemoryBatchInTx(db, userId, author, options), context);
		}
		if (job.request.kind === "agent_remove") {
			db.exec("BEGIN IMMEDIATE");
			try {
				const result = removeAgentInTx(db as never, job.request.input);
				commit(context);
				return result;
			} catch (error) {
				try {
					db.exec("ROLLBACK");
				} catch {}
				throw error;
			}
		}
		if (job.request.kind === "source_evidence_eligibility") return executeSourceEvidenceEligibility(job.request);
		if (job.request.kind === "dreaming_evidence_coverage") return await executeDreamingEvidenceCoverage(job.request);
		if (job.request.kind === "vector_search") return await executeVectorSearch(job.request.payload);
		if (
			job.request.kind === "source_graph_index" ||
			job.request.kind === "source_graph_file_purge" ||
			job.request.kind === "source_graph_purge"
		)
			return executeSourceGraph(job.request, context);
		if (job.request.kind === "source_artifact_index") return executeSourceArtifactIndex(job.request, context);
		if (job.request.kind === "source_native_memory_index") return executeNativeMemoryIndex(job.request, context);
		if (job.request.kind === "source_artifact_purge") return executeSourceArtifactPurge(job.request, context);
		if (job.request.kind === "vector_backfill") {
			if (!Number.isInteger(job.request.expectedDimensions) || job.request.expectedDimensions <= 0) {
				throw new RangeError("DB owner vector backfill dimensions must be a positive integer");
			}
			const { backfillVecEmbeddings } = await import("./db-accessor");
			backfillVecEmbeddings(db as never, job.request.expectedDimensions, context.deadlineAt, {
				maxBatches: job.request.maxBatches,
				batchSize: job.request.batchSize,
				log: writeDiagnostic,
				warn: writeDiagnostic,
			});
			if (context !== undefined) context.committed = true;
			return { completed: true };
		}
		if (job.request.kind === "vacuum_conversion") {
			const { convertToIncrementalVacuum } = await import("./db-vacuum");
			const pauseMs = Number.parseInt(process.env.SIGNET_TEST_DB_OWNER_VACUUM_PAUSE_MS ?? "0", 10);
			const activeFile = process.env.SIGNET_TEST_DB_OWNER_VACUUM_ACTIVE_FILE;
			const converted = convertToIncrementalVacuum(db as unknown as PragmaDb, {
				dbPath: ownerDbPath,
				log: () => {},
				beforeVacuum: () => {
					if (activeFile) writeFileSync(activeFile, `${Date.now()}\n`);
					if (Number.isFinite(pauseMs) && pauseMs > 0) {
						const wait = new Int32Array(new SharedArrayBuffer(4));
						Atomics.wait(wait, 0, 0, Math.min(pauseMs, 60_000));
					}
				},
			});
			if (context !== undefined && converted) context.committed = true;
			return {
				converted,
			};
		}
		if (job.request.kind === "incremental_vacuum") {
			const pages = Math.max(1, Math.min(10_000, Math.trunc(job.request.pages)));
			db.exec(`PRAGMA incremental_vacuum(${pages})`);
			if (context !== undefined) context.committed = true;
			const row = db.prepare("PRAGMA freelist_count").get() as { freelist_count?: number } | undefined;
			return typeof row?.freelist_count === "number" ? row.freelist_count : 0;
		}
		if (job.request.kind === "recall") return await executeRecall(job.request.payload);
		const durationMs = Math.max(0, Math.floor(job.request.durationMs));
		const wait = new Int32Array(new SharedArrayBuffer(4));
		Atomics.wait(wait, 0, 0, durationMs);
		return { sleptMs: durationMs };
	}

	function result(
		jobId: string,
		outcome: "completed" | "cancelled" | "timed_out",
		value?: unknown,
		metrics?: DbOwnerJobMetrics,
	): void {
		send({
			type: "result",
			jobId,
			outcome,
			...(value === undefined ? {} : { result: value }),
			...(metrics === undefined ? {} : { metrics }),
		});
	}

	function failed(jobId: string, name: string, message: string): void {
		send({ type: "result", jobId, outcome: "failed", error: { name, message } });
	}

	function runNext(): void {
		if (draining) return;
		draining = true;
		const next = async (): Promise<void> => {
			const job = nextJob();
			if (job === undefined) {
				draining = false;
				return;
			}
			activeJobId = job.id;
			send({ type: "started", jobId: job.id, workloadClass: job.workloadClass });
			const startedAt = Date.now();
			const context: JobExecutionContext = { jobId: job.id, deadlineAt: job.deadlineAt, committed: false };
			try {
				if (cancelled.delete(job.id) || cancellationRequested(job.id)) {
					result(job.id, "cancelled");
				} else if (Date.now() >= job.deadlineAt) {
					result(job.id, "timed_out");
				} else {
					const value = await withWritePrincipal(job.writePrincipal, () => execute(job, context));
					if (job.lane === "read" && Date.now() >= job.deadlineAt && !context.committed)
						result(job.id, "timed_out", undefined, { startedAt, finishedAt: Date.now() });
					else if (cancellationRequested(job.id) && !context.committed) result(job.id, "cancelled");
					else
						result(job.id, "completed", value, {
							startedAt,
							finishedAt: Date.now(),
						});
				}
			} catch (error) {
				if (error instanceof DbOwnerCancellationRequested) {
					result(job.id, "cancelled", undefined, { startedAt, finishedAt: Date.now() });
				} else {
					send({
						type: "result",
						jobId: job.id,
						outcome: "failed",
						error: serializeError(error),
						metrics: { startedAt, finishedAt: Date.now() },
					});
				}
			} finally {
				activeJobId = null;
				setImmediate(() => void next());
			}
		};
		setImmediate(() => void next());
	}

	function handle(command: DbOwnerCommand): void {
		if (command.type === "shutdown") {
			closeAndExit(0);
			return;
		}
		if (command.type === "cancel") {
			if (!shouldRecordDbOwnerCancellation(command.jobId, activeJobId, foregroundQueue, maintenanceQueue)) return;
			cancelled.add(command.jobId);
			return;
		}
		if (command.type === "set_write_blocked") {
			writeBlocked = command.blocked;
			return;
		}
		if (writeBlocked && command.job.lane !== "read" && command.job.allowWriteBlocked !== true) {
			failed(
				command.job.id,
				"DB_OWNER_WRITES_BLOCKED",
				"DB owner writes are blocked while database integrity is unresolved",
			);
			return;
		}
		const maxDeadlineMs =
			command.job.lane === "maintenance" || command.job.lane === "verify"
				? DB_OWNER_MAX_MAINTENANCE_DEADLINE_MS
				: DB_OWNER_MAX_DEADLINE_MS;
		if (command.job.deadlineAt - command.job.enqueuedAt > maxDeadlineMs) {
			failed(command.job.id, "DB_OWNER_WORK_BUDGET", `DB owner deadline exceeds ${maxDeadlineMs}ms`);
			return;
		}
		if (
			!Number.isFinite(command.job.estimatedWorkUnits) ||
			command.job.estimatedWorkUnits < 0 ||
			command.job.estimatedWorkUnits > DB_OWNER_MAX_WORK_UNITS
		) {
			failed(command.job.id, "DB_OWNER_WORK_BUDGET", `DB owner work budget exceeds ${DB_OWNER_MAX_WORK_UNITS} units`);
			return;
		}
		const workloadClass =
			command.job.workloadClass ??
			(command.job.lane === "maintenance" || command.job.lane === "verify" ? "maintenance" : "foreground");
		const queue = workloadClass === "foreground" ? foregroundQueue : maintenanceQueue;
		if (queue.length >= DB_OWNER_MAX_QUEUE_DEPTH) {
			failed(
				command.job.id,
				"DB_OWNER_QUEUE_FULL",
				`DB owner ${workloadClass} queue is full at ${DB_OWNER_MAX_QUEUE_DEPTH} jobs`,
			);
			return;
		}
		queue.push(command.job.workloadClass === workloadClass ? command.job : { ...command.job, workloadClass });
		runNext();
	}

	const input = new DbOwnerLineBuffer();
	process.stdin.setEncoding("utf8");
	process.stdin.on("data", (chunk: string) => {
		const lines = input.read(chunk);
		for (const line of lines) {
			if (line.length === 0) continue;
			try {
				handle(JSON.parse(line) as DbOwnerCommand);
			} catch (error) {
				send({ type: "fatal", error: serializeError(error) });
				process.exitCode = 1;
			}
		}
	});
	process.stdin.on("end", () => {
		closeAndExit(0);
	});

	void activeJobId;
}

const entrypoint = process.argv[1] ?? "";
if (
	process.env.SIGNET_DB_OWNER_DB_PATH !== undefined &&
	(entrypoint.endsWith("db-owner-worker.ts") ||
		entrypoint.endsWith("db-owner-worker.js") ||
		entrypoint.endsWith("db-owner-worker.mjs"))
) {
	runDbOwnerWorker();
}

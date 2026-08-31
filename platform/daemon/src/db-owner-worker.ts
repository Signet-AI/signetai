import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import type { Database as BunDatabase } from "bun:sqlite";
import { findSqliteVecExtension, vectorSearchWithMetadata } from "@signet/core";
import {
	applyObsidianSourceStructureInTx,
	applyObsidianSourceStructurePurgeInTx,
	purgeObsidianSourceFileStructureInTx,
} from "./obsidian-source-graph";
import { indexSourceArtifactStructureInTx, purgeSourceArtifactStructureInTx } from "./source-artifact-graph";
import { upsertMemoryArtifactInTx, type MemoryArtifactUpsertFields } from "./memory-lineage";
import { upsertMemoryContentSafetyInTx } from "./memory-content-safety";
import { NATIVE_MEMORY_BRIDGE_SOURCE_NODE_ID } from "./native-memory-constants";
import { applySourceSnapshotImportInTx } from "./source-snapshots";
import { commitCompletedTranscriptBatchInTx } from "./transcript-import-commit";
import { getDreamingHygieneCandidatesInDb } from "./knowledge-graph-hygiene";
import { enqueueDreamingAttentionInTx } from "./pipeline/dreaming-attention";
import { DREAMING_SURPRISAL_SELECTOR_VERSION, selectDreamingSurprisalInDb } from "./pipeline/dreaming-surprisal";
import { sourceHasEligibleUnconsumedEvidence } from "./pipeline/dreaming-evidence-consumption";
import type {
	DbOwnerCommand,
	DbOwnerEvent,
	DbOwnerJob,
	DbOwnerJobMetrics,
	DbOwnerParameter,
	DbOwnerRecallPayload,
	DbOwnerStatement,
	DbOwnerNativeMemoryIndex,
	DbOwnerVectorSearchPayload,
} from "./db-owner-protocol";
import type { EmbeddingConfig } from "./memory-config";
import { awaitEmbeddingProviderAvailable, recordEmbeddingProviderFailure } from "./embedding-circuit-breaker";
import { vectorToBlob } from "./db-helpers";
import {
	DB_OWNER_MAX_DEADLINE_MS,
	DB_OWNER_MAX_MAINTENANCE_DEADLINE_MS,
	DB_OWNER_MAX_QUEUE_DEPTH,
	DB_OWNER_MAX_RESULT_BYTES,
	DB_OWNER_MAX_TRANSACTION_STATEMENTS,
	DB_OWNER_MAX_WORK_UNITS,
	serializeError,
} from "./db-owner-protocol";

interface SqliteRunResult {
	readonly changes: number;
	readonly lastInsertRowid?: number | bigint;
}

interface SqliteStatement {
	all(...params: readonly unknown[]): unknown[];
	get(...params: readonly unknown[]): unknown;
	run(...params: readonly unknown[]): SqliteRunResult;
}

interface SqliteDatabase {
	prepare(sql: string): SqliteStatement;
	exec(sql: string): void;
	loadExtension?(path: string): void;
	close(): void;
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
	const parentPid = process.ppid;
	let db = undefined as unknown as SqliteDatabase;
	let parentWatch: ReturnType<typeof setInterval> | undefined;
	const closeAndExit = (code: number): never => {
		if (parentWatch !== undefined) clearInterval(parentWatch);
		try {
			if (db !== undefined) db.close();
		} finally {
			process.exit(code);
		}
	};

	function send(event: DbOwnerEvent): void {
		process.stdout.write(`${JSON.stringify(event)}\n`);
	}
	function writeDiagnostic(message: string): void {
		process.stderr.write(`${message}\n`);
	}

	// Readiness attests only that the protocol channel is available. Database
	// construction, custom SQLite selection, and extension loading are startup
	// work owned by this process and must not delay the parent handshake.
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
		db.exec("PRAGMA busy_timeout = 5000");
		const vecExtension = findSqliteVecExtension();
		if (vecExtension !== null) loadSqliteVecIfAvailable(db, vecExtension);
	} catch (error) {
		send({ type: "fatal", error: serializeError(error) });
		closeAndExit(1);
	}
	if (db === undefined) closeAndExit(1);
	parentWatch = setInterval(() => {
		// SIGKILL bypasses daemon cleanup. Close the owner database as soon as
		// its control-process parent disappears, before exiting as an orphan.
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
		if (commitMarker !== undefined) writeFileSync(commitMarker, "started\n");
		db.exec("COMMIT");
		if (context !== undefined) context.committed = true;
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
				} catch {
					// Preserve the original SQLite error.
				}
				if (!isBusyError(error) || attempt >= BUSY_RETRIES) throw error;
				wait(BUSY_BACKOFF_MS * 2 ** attempt);
			}
		}
	};

	const cancelled = new Set<string>();
	const foregroundQueue: DbOwnerJob[] = [];
	const maintenanceQueue: DbOwnerJob[] = [];
	let foregroundStreak = 0;
	const MAX_FOREGROUND_BURST = 8;
	let activeJobId: string | null = null;
	let writeBlocked = false;
	let draining = false;

	function nextJob(): DbOwnerJob | undefined {
		if (foregroundQueue.length > 0 && (maintenanceQueue.length === 0 || foregroundStreak < MAX_FOREGROUND_BURST)) {
			foregroundStreak += 1;
			return foregroundQueue.shift();
		}
		if (maintenanceQueue.length > 0) {
			foregroundStreak = 0;
			return maintenanceQueue.shift();
		}
		if (foregroundQueue.length > 0) {
			foregroundStreak += 1;
			return foregroundQueue.shift();
		}
		return undefined;
	}

	function bindParameter(value: DbOwnerParameter): unknown {
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
				`DB owner result is ${resultBytes} bytes, above the ${maxResultBytes}-byte limit; page the query or reduce its columns`,
			);
		}
		return value;
	}

	function executeStatement(statement: DbOwnerStatement, context?: JobExecutionContext): unknown {
		const params = (statement.params ?? []).map(bindParameter);
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
		const readonlyDb = new Database(ownerDbPath, { readonly: true });
		try {
			const params = (statement.params ?? []).map(bindParameter);
			const prepared = readonlyDb.prepare(statement.sql);
			return statement.result === "all"
				? enforceResultLimit(statement, prepared.all(...params))
				: enforceResultLimit(statement, prepared.get(...params));
		} finally {
			readonlyDb.close();
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
			const results = statements.map((statement) => executeStatement({ ...statement, transactional: false }, context));
			for (let i = 0; i < results.length; i++) {
				const statement = statements[i];
				const result = results[i];
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
			commit(context);
			return enforceResultLimit({ sql: "db-owner-batch", result: "all" }, results) as readonly unknown[];
		} catch (error) {
			try {
				db.exec("ROLLBACK");
			} catch {
				// The original error is the actionable failure.
			}
			throw error;
		}
	}

	function executeStatementWithoutTransaction(statement: DbOwnerStatement): SqliteRunResult {
		const params = (statement.params ?? []).map(bindParameter);
		return db.prepare(statement.sql).run(...params);
	}

	function executeTranscriptBulkCommit(
		request: Extract<DbOwnerJob["request"], { readonly kind: "transcript_bulk_commit" }>,
		context: JobExecutionContext,
	): unknown {
		if (request.input.commits.length === 0 || request.input.commits.length > 25)
			throw new RangeError("invalid transcript commit batch");
		db.exec("BEGIN IMMEDIATE");
		try {
			const lease = db
				.prepare(
					"SELECT 1 FROM source_import_jobs WHERE id = ? AND agent_id = ? AND generation = ? AND lease_token = ? AND state IN ('running','inventorying')",
				)
				.get(request.input.jobId, request.input.agentId, request.input.generation, request.input.leaseToken);
			if (lease == null) throw new Error("stale import lease");
			const result = commitCompletedTranscriptBatchInTx(db as never, request.input.commits);
			commit(context);
			return result;
		} catch (error) {
			try {
				db.exec("ROLLBACK");
			} catch {
				/* preserve original error */
			}
			throw error;
		}
	}

	function executeTranscriptImportControl(
		request: Extract<DbOwnerJob["request"], { readonly kind: "transcript_import_control" }>,
		context: JobExecutionContext,
	): unknown {
		db.exec("BEGIN IMMEDIATE");
		try {
			const result = db
				.prepare(
					"UPDATE source_import_jobs SET control_request = ?, updated_at = datetime('now') WHERE id = ? AND agent_id = ?",
				)
				.run(request.input.control, request.input.jobId, request.input.agentId);
			commit(context);
			return { changed: result.changes > 0 };
		} catch (error) {
			try {
				db.exec("ROLLBACK");
			} catch {
				/* preserve original error */
			}
			throw error;
		}
	}

	function executeTranscriptImportReconcile(
		request: Extract<DbOwnerJob["request"], { readonly kind: "transcript_import_reconcile" }>,
	): unknown {
		const row = db
			.prepare(
				"SELECT COUNT(*) AS total, SUM(status = 'imported') AS imported, SUM(status = 'duplicate') AS duplicate, SUM(status = 'rejected') AS rejected, SUM(status IN ('pending','cancelled')) AS pending FROM source_import_records WHERE job_id = ? AND agent_id = ?",
			)
			.get(request.input.jobId, request.input.agentId) as Record<string, number>;
		return {
			total: row.total ?? 0,
			imported: row.imported ?? 0,
			duplicate: row.duplicate ?? 0,
			rejected: row.rejected ?? 0,
			pending: row.pending ?? 0,
		};
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
			} catch {
				// The original error is the actionable failure.
			}
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
			} catch {
				// Preserve the original owner failure.
			}
			throw error;
		}
	}

	function executeDreamingSurprisalAttention(
		request: Extract<DbOwnerJob["request"], { readonly kind: "dreaming_surprisal_attention" }>,
		context?: JobExecutionContext,
	): unknown {
		if (request.input.config.enabled === false) return null;
		const selection = selectDreamingSurprisalInDb(db as never, request.input.agentId, request.input.config, null);
		if (selection.candidates.length === 0) return selection;
		db.exec("BEGIN IMMEDIATE");
		try {
			for (const candidate of selection.candidates) {
				enqueueDreamingAttentionInTx(db as never, {
					agentId: request.input.agentId,
					kind: "surprisal",
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
			} catch {
				// Preserve the original owner failure.
			}
			throw error;
		}
	}

	async function executeDreamingEpisodicBacklog(
		request: Extract<DbOwnerJob["request"], { readonly kind: "dreaming_episodic_backlog" }>,
	): Promise<number> {
		// Keep source selection, evidence rendering, and exact token counting out
		// of the daemon process. The helper enforces the finite source cap before
		// it materializes any result for the parent.
		const { getDreamingEpisodicTokenBacklogInDb } = await import("./pipeline/dreaming");
		return await getDreamingEpisodicTokenBacklogInDb(db as never, request.input.agentId, request.input.maxSources);
	}

	async function executeDreamingEvidenceSearch(
		request: Extract<DbOwnerJob["request"], { readonly kind: "dreaming_evidence_search" }>,
	): Promise<unknown> {
		const { searchDreamingEvidenceInDb } = await import("./pipeline/dreaming-capabilities");
		return searchDreamingEvidenceInDb(db as never, request.input);
	}

	async function executeDreamingEvidenceSource(
		request: Extract<DbOwnerJob["request"], { readonly kind: "dreaming_evidence_source" }>,
	): Promise<unknown> {
		const { readDreamingEvidenceSourceInDb } = await import("./pipeline/dreaming-capabilities");
		return readDreamingEvidenceSourceInDb(db as never, request.input);
	}

	async function executeDreamingPassFinalize(
		request: Extract<DbOwnerJob["request"], { readonly kind: "dreaming_pass_finalize" }>,
		context: JobExecutionContext,
	): Promise<null> {
		const { finalizeDreamingPassInDb } = await import("./pipeline/dreaming");
		return withBusyRetry(() => {
			finalizeDreamingPassInDb(db as never, request.input);
			return null;
		}, context);
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
			} catch {
				// Preserve the original owner failure.
			}
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
			} catch {
				// The original error is the actionable failure.
			}
			throw error;
		}
	}

	function executeSourceEvidenceEligibility(
		request: Extract<DbOwnerJob["request"], { readonly kind: "source_evidence_eligibility" }>,
	): boolean {
		return sourceHasEligibleUnconsumedEvidence(
			db as unknown as import("./db-accessor").ReadDb,
			request.input.agentId,
			request.input.sourceEntryId,
			request.input.legacyObsidianRoot,
		);
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
				result = applyObsidianSourceStructureInTx(db as unknown as import("./db-accessor").WriteDb, request.input);
			} else if (request.kind === "source_graph_file_purge") {
				result = purgeObsidianSourceFileStructureInTx(db as unknown as import("./db-accessor").WriteDb, request.input);
			} else {
				result = applyObsidianSourceStructurePurgeInTx(db as unknown as import("./db-accessor").WriteDb, request.input);
			}
			commit(context);
			return result;
		} catch (error) {
			try {
				db.exec("ROLLBACK");
			} catch {
				// The original error is the actionable failure.
			}
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
		const vecSchema = database
			.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'vec_embeddings'")
			.get() as { sql?: string } | null;
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
				upsertMemoryContentSafetyInTx(database as unknown as import("./db-accessor").WriteDb, {
					agentId: input.agentId,
					sourceKind: "source_chunk",
					sourceId: embeddingId,
					content: chunk.chunkText,
				});
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
			if (existing !== null) {
				if (vecAvailable) database.prepare("DELETE FROM vec_embeddings WHERE id = ?").run(existing.id);
				database.prepare("DELETE FROM embeddings WHERE id = ?").run(existing.id);
			}
			database
				.prepare(
					`INSERT INTO embeddings
					 (id, content_hash, vector, dimensions, source_type, source_id, chunk_text, created_at, agent_id)
					 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
					 ON CONFLICT(content_hash) DO UPDATE SET vector = excluded.vector, dimensions = excluded.dimensions,
					 source_type = excluded.source_type, source_id = excluded.source_id, chunk_text = excluded.chunk_text,
					 created_at = excluded.created_at, agent_id = excluded.agent_id`,
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
				);
			upsertMemoryContentSafetyInTx(database as unknown as import("./db-accessor").WriteDb, {
				agentId: input.agentId,
				sourceKind: "source_chunk",
				sourceId: embeddingId,
				content: chunk.chunkText,
			});
			if (vecAvailable && vecDimensions === String(vector.length))
				database
					.prepare("INSERT OR REPLACE INTO vec_embeddings (id, embedding) VALUES (?, ?)")
					.run(embeddingId, vectorToBlob(vector));
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
			if (vecAvailable) database.prepare("DELETE FROM vec_embeddings WHERE id = ?").run(row.id);
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
		db.exec("BEGIN IMMEDIATE");
		try {
			upsertMemoryArtifactInTx(db as unknown as BunDatabase, nativeMemoryArtifactFields(input));
			if (input.graph !== undefined) {
				applyObsidianSourceStructureInTx(db as unknown as import("./db-accessor").WriteDb, {
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
				artifactChanged: existing?.source_sha256 !== input.sourceHash,
				graphIndexed: input.graph !== undefined,
				embeddingProviderUnavailable: embeddingResult.providerUnavailable,
			};
		} catch (error) {
			try {
				db.exec("ROLLBACK");
			} catch {
				// Preserve the original error.
			}
			throw error;
		}
	}

	function executeSourceArtifactIndex(
		request: Extract<DbOwnerJob["request"], { readonly kind: "source_artifact_index" }>,
		context?: JobExecutionContext,
	): unknown {
		db.exec("BEGIN IMMEDIATE");
		try {
			const result = indexSourceArtifactStructureInTx(db as unknown as import("./db-accessor").WriteDb, request.input);
			commit(context);
			return result;
		} catch (error) {
			try {
				db.exec("ROLLBACK");
			} catch {
				// Preserve the original error.
			}
			throw error;
		}
	}

	function executeSourceArtifactPurge(
		request: Extract<DbOwnerJob["request"], { readonly kind: "source_artifact_purge" }>,
		context?: JobExecutionContext,
	): unknown {
		db.exec("BEGIN IMMEDIATE");
		try {
			const result = purgeSourceArtifactStructureInTx(db as unknown as import("./db-accessor").WriteDb, request.input);
			commit(context);
			return result;
		} catch (error) {
			try {
				db.exec("ROLLBACK");
			} catch {
				// Preserve the original error.
			}
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
		if (process.env.SIGNET_DB_OWNER_RECALL_WORKER !== "1") {
			throw new Error("DB owner recall jobs require a recall worker");
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
					case "widgetGeneration":
						return router.createWorkloadProvider("widget_generation", agentId);
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
<<<<<<< ours
			{ siteToken: "db:recall.embedding.config.read", operation: "recall.resolve-active-embedding" },
=======
			{ siteToken: "db-owner-worker.ts:975" },
>>>>>>> theirs
		);
		const query = payload.query;
		const queryEmbedding =
			payload.queryEmbedding !== undefined
				? payload.queryEmbedding
				: query === undefined
					? null
					: await (async () => {
							const { fetchEmbedding } = await import("./embedding-fetch");
							return await fetchEmbedding(query, embedding, "query", {
								usage: { source: "recall", agentId },
							});
						})();
		return await hybridRecall(
			payload.params as Parameters<typeof hybridRecall>[0],
			{ ...config, embedding },
			async () => (queryEmbedding === null ? null : queryEmbedding === undefined ? null : [...queryEmbedding]),
		);
	}

	async function executeVectorSearch(payload: DbOwnerVectorSearchPayload): Promise<unknown> {
		if (process.env.SIGNET_DB_OWNER_RECALL_WORKER !== "1") {
			throw new Error("DB owner vector-search jobs require a recall worker");
		}
		if (!recallAccessorReady) {
			const { initDbAccessorAsync } = await import("./db-accessor");
			await initDbAccessorAsync(ownerDbPath);
			recallAccessorReady = true;
		}
		const { getDbAccessor } = await import("./db-accessor");
		return await getDbAccessor().withReadDbAsync(
			(db) => vectorSearchWithMetadata(db, new Float32Array(payload.queryEmbedding), payload.options),
<<<<<<< ours
			{ siteToken: "db:recall.vector.search.read", operation: "recall.vector-search" },
=======
			{ siteToken: "db-owner-worker.ts:1008" },
>>>>>>> theirs
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
		if (context !== undefined) context.committed = true;
		return {
			initialized: true,
			pendingVecBackfill: initialization.pendingVecBackfill,
			...(initialization.extensionPath !== undefined ? { extensionPath: initialization.extensionPath } : {}),
			...(initialization.deferredMigrationVerification ? { deferredMigrationVerification: true } : {}),
		};
	}

	async function execute(job: DbOwnerJob, context: JobExecutionContext): Promise<unknown> {
		if (job.request.kind === "initialize") return await executeInitialization(job.request.agentsDir, context);
		if (job.request.kind === "query") {
			return job.request.statement.readonly
				? executeReadOnlyStatement(job.request.statement)
				: executeStatement(job.request.statement, context);
		}
		if (job.request.kind === "transaction") return executeTransaction(job.request.transaction.statements, context);
		if (job.request.kind === "batch")
			return executeBatch(job.request.statements, job.request.requireChanges === true, context);
		if (job.request.kind === "source_snapshot_import") return executeSourceSnapshotImport(job.request, context);
		if (job.request.kind === "transcript_bulk_commit") return executeTranscriptBulkCommit(job.request, context);
		if (job.request.kind === "transcript_import_control") return executeTranscriptImportControl(job.request, context);
		if (job.request.kind === "transcript_import_reconcile") return executeTranscriptImportReconcile(job.request);
		if (job.request.kind === "transcript_import_purge") {
			db.exec("BEGIN IMMEDIATE");
			try {
				const source = job.request.input.sourceId;
				db.prepare("DELETE FROM session_transcripts WHERE agent_id = ? AND source_id = ?").run(
					job.request.input.agentId,
					source,
				);
				db.prepare(
					"UPDATE transcript_import_conversations SET state = 'removed', updated_at = datetime('now') WHERE agent_id = ? AND owner_source_id = ?",
				).run(job.request.input.agentId, source);
				db.prepare("DELETE FROM source_import_records WHERE agent_id = ? AND source_id = ?").run(
					job.request.input.agentId,
					source,
				);
				db.prepare("DELETE FROM source_import_files WHERE agent_id = ? AND source_id = ?").run(
					job.request.input.agentId,
					source,
				);
				commit(context);
				return { purged: true };
			} catch (error) {
				try {
					db.exec("ROLLBACK");
				} catch {
					/* preserve original error */
				}
				throw error;
			}
		}
		if (job.request.kind === "dreaming_hygiene_attention") return executeDreamingHygieneAttention(job.request, context);
		if (job.request.kind === "dreaming_surprisal_attention")
			return executeDreamingSurprisalAttention(job.request, context);
		if (job.request.kind === "dreaming_episodic_backlog") return await executeDreamingEpisodicBacklog(job.request);
		if (job.request.kind === "dreaming_evidence_search") return await executeDreamingEvidenceSearch(job.request);
		if (job.request.kind === "dreaming_evidence_source") return await executeDreamingEvidenceSource(job.request);
		if (job.request.kind === "dreaming_pass_finalize") return executeDreamingPassFinalize(job.request, context);
		if (job.request.kind === "dreaming_review_due") return await executeDreamingReviewDue(job.request);
		if (job.request.kind === "dreaming_evidence_classify") return await executeDreamingEvidenceClassify(job.request);
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
		if (job.request.kind === "source_evidence_eligibility") return executeSourceEvidenceEligibility(job.request);
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
			const converted = convertToIncrementalVacuum(db as unknown as import("./db-vacuum").PragmaDb, {
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
			// Conversion is a non-transactional SQLite operation: once it returns,
			// VACUUM and the durable marker have completed. An active cancellation
			// that arrived during the conversion must therefore report completion,
			// not cancellation after durable changes.
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
					const value = await execute(job, context);
					if (cancellationRequested(job.id) && !context.committed) result(job.id, "cancelled");
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

	let input = "";
	process.stdin.setEncoding("utf8");
	process.stdin.on("data", (chunk: string) => {
		input += chunk;
		const lines = input.split("\n");
		input = lines.pop() ?? "";
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
		// The daemon owns this pipe. If it is killed before it can send the
		// protocol shutdown command, close SQLite immediately rather than
		// leaving an orphan owner holding the eval workspace database lock.
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

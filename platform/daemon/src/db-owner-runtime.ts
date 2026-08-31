import { stat } from "node:fs/promises";
import { join } from "node:path";
import { vectorSearchWithMetadata } from "@signet/core";
import type { DbAccessor, ReadDb, WriteDb } from "./db-accessor";
import { getDbAccessorPath, hasDbAccessor, resolveSqliteAgentsDir } from "./db-accessor";
import { registerDbAccessorCloseParticipant } from "./db-accessor-lifecycle";
import {
	createDbOwnerClient,
	DbOwnerAdmissionError,
	type DbOwnerClient,
	type DbOwnerClientOptions,
	type DbOwnerJobHandle,
	type DbOwnerSubmitOptions,
} from "./db-owner-client";
import { getDbOwnerMaintenance } from "./db-owner-maintenance";
import type {
	DbOwnerJob,
	DbOwnerParameter,
	DbOwnerRequest,
	DbOwnerSourceEvidenceEligibility,
	DbOwnerSourceGraphFilePurge,
	DbOwnerSourceGraphIndex,
	DbOwnerSourceGraphPurge,
	DbOwnerSourceSnapshotImport,
	DbOwnerSourceArtifactIndex,
	DbOwnerNativeMemoryIndex,
	DbOwnerSourceArtifactPurge,
	DbOwnerSourceArtifactUpsert,
	DbOwnerStatement,
	DbOwnerWorkloadClass,
} from "./db-owner-protocol";

let isolatedTestAccessor: DbAccessor | null = null;

/**
 * Tests that use an isolated in-memory accessor cannot start the process
 * owner. They may explicitly register that accessor so owner-routed helpers
 * retain their old test seam without creating a production fallback.
 */
export function registerDbOwnerIsolatedTestAccessor(accessor: DbAccessor): void {
	if (hasDbAccessor()) return;
	isolatedTestAccessor = accessor;
}

function invokeAccessor<Result>(
	accessor: DbAccessor,
	methodName: "withReadDb" | "withWriteTx",
	callback: (db: ReadDb | WriteDb) => Result,
): Result {
	const method = Reflect.get(accessor, methodName);
	if (typeof method !== "function") throw new Error(`Isolated test accessor is missing ${methodName}`);
	return method.call(accessor, callback);
}

function invokeAccessorAsync<Result>(
	accessor: DbAccessor,
	methodName: "withReadDbAsync" | "withWriteDbAsync" | "withWriteTxAsync",
	callback: (db: ReadDb | WriteDb) => Result,
): Promise<Result> {
	const method = Reflect.get(accessor, methodName);
	if (typeof method !== "function") throw new Error(`Isolated test accessor is missing ${methodName}`);
	return method.call(accessor, callback) as Promise<Result>;
}

function inlineParameter(value: DbOwnerParameter): string | number | boolean | null | Uint8Array {
	if (typeof value !== "object" || value === null) return value;
	return Uint8Array.from(Buffer.from(value.base64, "base64"));
}

function inlineStatement(db: ReadDb | WriteDb, statement: DbOwnerStatement): unknown {
	const params = (statement.params ?? []).map(inlineParameter);
	const prepared = db.prepare(statement.sql);
	if (statement.result === "all") return prepared.all(...params);
	if (statement.result === "get") return prepared.get(...params);
	return prepared.run(...params);
}

export interface InlineDbOwnerAccess {
	readonly read: <Result>(callback: (db: ReadDb) => Result) => Result;
	readonly write: <Result>(callback: (db: WriteDb) => Result) => Result;
}

export interface DbOwnerDomainOperation<Result> {
	readonly runWithOwner: (owner: DbOwnerClient) => Promise<Result>;
	readonly runInline: (access: InlineDbOwnerAccess) => Result | Promise<Result>;
}

function inlineDbOwnerAccess(accessor: DbAccessor): InlineDbOwnerAccess {
	return {
		read: <Result>(callback: (db: ReadDb) => Result): Result =>
			invokeAccessor(accessor, "withReadDb", callback as (db: ReadDb | WriteDb) => Result),
		write: <Result>(callback: (db: WriteDb) => Result): Result =>
			invokeAccessor(accessor, "withWriteTx", callback as (db: ReadDb | WriteDb) => Result),
	};
}

export async function runDbOwnerDomainOperation<Result>(
	accessor: DbAccessor,
	operation: DbOwnerDomainOperation<Result>,
): Promise<Result> {
	if (process.env.SIGNET_DB_OWNER_WORKER === "1" || !hasDbAccessor()) {
		return await operation.runInline(inlineDbOwnerAccess(accessor));
	}
	return await operation.runWithOwner(await getDbOwner(getDbAccessorPath()));
}

function unreachableInlineRequest(request: never): never {
	throw new Error(`Unreachable inline DB owner request: ${String(request)}`);
}

async function executeInlineOwnerRequest(accessor: DbAccessor, request: DbOwnerRequest): Promise<unknown> {
	if (request.kind === "query") {
		if (
			request.statement.readonly === false ||
			(request.statement.result === "run" && request.statement.transactional !== false)
		) {
			return await invokeAccessorAsync(accessor, "withWriteTxAsync", (db) => inlineStatement(db, request.statement));
		}
		if (request.statement.result === "run") {
			return await invokeAccessorAsync(accessor, "withWriteDbAsync", (db) => inlineStatement(db, request.statement));
		}
		return await invokeAccessorAsync(accessor, "withReadDbAsync", (db) => inlineStatement(db, request.statement));
	}
	if (request.kind === "transaction") {
		return await invokeAccessorAsync(accessor, "withWriteTxAsync", (db) =>
			request.transaction.statements.map((statement) => inlineStatement(db, statement)),
		);
	}
	if (request.kind === "batch") {
		return await invokeAccessorAsync(accessor, "withWriteTxAsync", (db) => {
			const results = request.statements.map((statement) => inlineStatement(db, statement));
			if (
				request.requireChanges === true ||
				request.statements.some((statement) => statement.requireChanges === true)
			) {
				for (const result of results) {
					if (typeof result === "object" && result !== null && "changes" in result && result.changes === 0) {
						throw new Error("DB owner batch precondition changed zero rows");
					}
				}
			}
			return results;
		});
	}
	if (request.kind === "vector_search") {
		return invokeAccessor(accessor, "withReadDb", (db) =>
			vectorSearchWithMetadata(db as never, new Float32Array(request.payload.queryEmbedding), request.payload.options),
		);
	}
	switch (request.kind) {
		case "initialize":
		case "recall":
		case "source_snapshot_import":
		case "source_graph_index":
		case "source_graph_file_purge":
		case "source_graph_purge":
		case "source_artifact_index":
		case "source_native_memory_index":
		case "source_artifact_purge":
		case "source_artifact_upsert":
		case "source_artifact_upsert_batch":
		case "dreaming_hygiene_attention":
		case "dreaming_surprisal_attention":
		case "dreaming_episodic_backlog":
		case "dreaming_evidence_search":
		case "dreaming_evidence_source":
		case "dreaming_pass_finalize":
		case "dreaming_review_due":
		case "dreaming_evidence_classify":
		case "dreaming_evidence_requeue":
		case "embedding_migration_progress":
		case "health_ready":
		case "diagnostics":
		case "vector_backfill":
		case "vacuum_conversion":
		case "incremental_vacuum":
		case "source_evidence_eligibility":
		case "sleep":
			throw new Error(`Unsupported inline owner request: ${request.kind}`);
		default:
			return unreachableInlineRequest(request);
	}
}

function inlineOwner(accessor: DbAccessor): DbOwnerClient {
	const submit = <Result>(request: DbOwnerRequest, options: DbOwnerSubmitOptions): DbOwnerJobHandle<Result> => {
		const now = Date.now();
		const job: DbOwnerJob = {
			id: `isolated-test:${now}`,
			operation: options.operation,
			lane: options.lane,
			workloadClass: options.workloadClass ?? "foreground",
			enqueuedAt: now,
			deadlineAt: now + options.deadlineMs,
			estimatedWorkUnits: options.estimatedWorkUnits ?? 1,
			cancellation: "pending",
			request,
		};
		return { job, result: executeInlineOwnerRequest(accessor, request) as Promise<Result>, cancel: () => undefined };
	};
	return {
		start: async () => undefined,
		initialize: async () => ({ initialized: true, pendingVecBackfill: false }),
		submit,
		setWriteBlocked: () => undefined,
		awaitResult: async <Result>(handle: DbOwnerJobHandle<Result>) => await handle.result,
		cancel: () => undefined,
		health: () => ({
			state: "ready",
			initialization: "ready",
			databaseReady: true,
			pid: null,
			generation: 0,
			queuedJobs: 0,
			foregroundQueuedJobs: 0,
			maintenanceQueuedJobs: 0,
			activeJobId: null,
			activeWorkloadClass: null,
			foregroundOldestAgeMs: null,
			maintenanceOldestAgeMs: null,
			lastError: null,
		}),
		close: async () => undefined,
	};
}

const clients = new Map<
	string,
	{
		owner: DbOwnerClient;
		identity: string;
		startPromise: Promise<DbOwnerClient> | null;
	}
>();
const retiredClientClosures = new Map<string, Promise<void>>();

async function dbIdentity(dbPath: string): Promise<string> {
	try {
		const metadata = await stat(dbPath);
		return `${metadata.dev}:${metadata.ino}`;
	} catch {
		return dbPath;
	}
}

export async function startDbOwnerWithRole(
	dbPath: string,
	workerRole: "generic" | "recall",
	options: Pick<DbOwnerClientOptions, "workerPath"> = {},
): Promise<DbOwnerClient> {
	const identity = await dbIdentity(dbPath);
	const key = `${workerRole}:${dbPath}`;
	const retiredClosure = retiredClientClosures.get(key);
	if (retiredClosure !== undefined) await retiredClosure;
	const current = clients.get(key);
	if (
		current !== undefined &&
		(current.identity !== identity ||
			current.owner.health().state === "closed" ||
			current.owner.health().state === "dead" ||
			current.owner.health().state === "failed")
	) {
		clients.delete(key);
		const closing = current.owner.close();
		retiredClientClosures.set(key, closing);
		try {
			await closing;
		} finally {
			if (retiredClientClosures.get(key) === closing) retiredClientClosures.delete(key);
		}
	}
	let entry = clients.get(key);
	if (entry === undefined) {
		entry = { owner: createDbOwnerClient({ dbPath, workerRole, ...options }), identity, startPromise: null };
		clients.set(key, entry);
	}
	if (entry.startPromise !== null) return await entry.startPromise;
	const owner = entry.owner;
	const pendingStart = owner.start().then(() => owner);
	entry.startPromise = pendingStart;
	try {
		return await pendingStart;
	} finally {
		const currentEntry = clients.get(key);
		if (currentEntry?.owner === owner && currentEntry.startPromise === pendingStart) currentEntry.startPromise = null;
	}
}

/** Start the generic process DB owner for one database path. */
export async function startDbOwner(
	dbPath = join(resolveSqliteAgentsDir(), "memory", "memories.db"),
): Promise<DbOwnerClient> {
	return await startDbOwnerWithRole(dbPath, "generic");
}

/** Start the recall process DB owner for one database path. */
export async function startDbRecallOwner(
	dbPath = join(resolveSqliteAgentsDir(), "memory", "memories.db"),
): Promise<DbOwnerClient> {
	return await startDbOwnerWithRole(dbPath, "recall");
}

async function getCurrentProcessOwner(): Promise<DbOwnerClient> {
	if (isolatedTestAccessor !== null) return inlineOwner(isolatedTestAccessor);
	const { getDbAccessor } = await import("./db-accessor");
	return inlineOwner(getDbAccessor());
}

/** Resolve the process owner, or the in-process adapter used inside an owner worker. */
export async function getDbOwner(dbPath?: string): Promise<DbOwnerClient> {
	if (process.env.SIGNET_DB_OWNER_WORKER === "1") return await getCurrentProcessOwner();
	const registered = getDbOwnerMaintenance()?.owner;
	if (registered !== undefined) return registered;
	if (hasDbAccessor()) return await startDbOwner(getDbAccessorPath());
	if (isolatedTestAccessor !== null) return inlineOwner(isolatedTestAccessor);
	return await startDbOwner(dbPath);
}

/** Resolve the recall owner without allowing a generic owner to reject vector jobs. */
export async function getDbRecallOwner(dbPath?: string): Promise<DbOwnerClient> {
	if (process.env.SIGNET_DB_OWNER_WORKER === "1") return await getCurrentProcessOwner();
	if (hasDbAccessor()) return await startDbRecallOwner(getDbAccessorPath());
	if (isolatedTestAccessor !== null) return inlineOwner(isolatedTestAccessor);
	return await startDbRecallOwner(dbPath);
}

/**
 * Resolve the production owner, or an explicitly supplied isolated test
 * accessor without opening a second SQLite connection.
 */
export async function getDbOwnerForAccessor(accessor: DbAccessor): Promise<DbOwnerClient> {
	if (process.env.SIGNET_DB_OWNER_WORKER === "1") return inlineOwner(accessor);
	if (hasDbAccessor()) return await getDbOwner(getDbAccessorPath());
	registerDbOwnerIsolatedTestAccessor(accessor);
	return inlineOwner(accessor);
}

export interface DbOwnerSqlOptions {
	readonly operation: string;
	readonly lane?: "read" | "write" | "maintenance";
	readonly workloadClass?: DbOwnerWorkloadClass;
	readonly deadlineMs?: number;
	readonly estimatedWorkUnits?: number;
	/** Aborting abandons the queued/in-flight owner job and suppresses its result. */
	readonly signal?: AbortSignal;
}

function submitOptions(options: DbOwnerSqlOptions): DbOwnerSubmitOptions {
	const workloadClass = /^(?:sources|maintenance|vacuum)\./.test(options.operation)
		? "maintenance"
		: options.workloadClass;
	return {
		operation: options.operation,
		lane: options.lane ?? "write",
		workloadClass,
		deadlineMs: options.deadlineMs ?? 5_000,
		estimatedWorkUnits: options.estimatedWorkUnits,
	};
}

async function submitWithAdmission<Result>(
	owner: DbOwnerClient,
	request: Parameters<DbOwnerClient["submit"]>[0],
	options: DbOwnerSqlOptions,
): Promise<Result> {
	const signal = options.signal;
	const throwIfAborted = (): void => {
		if (!signal?.aborted) return;
		throw signal.reason instanceof Error ? signal.reason : new DOMException("The operation was aborted", "AbortError");
	};
	throwIfAborted();
	const submit = submitOptions(options);
	const deadlineAt = Date.now() + submit.deadlineMs;
	for (;;) {
		try {
			throwIfAborted();
			const handle = owner.submit<Result>(request, submit);
			// Cancellation may happen synchronously during bridge shutdown, before
			// the async waiter gets its first turn. Keep the handle rejection
			// observed while awaitResult still propagates it to the caller.
			void handle.result.catch(() => {});
			const onAbort = (): void => handle.cancel();
			signal?.addEventListener("abort", onAbort, { once: true });
			try {
				return await owner.awaitResult(handle);
			} finally {
				signal?.removeEventListener("abort", onAbort);
			}
		} catch (error) {
			if (!(error instanceof DbOwnerAdmissionError) || error.code !== "DB_OWNER_QUEUE_FULL") throw error;
			throwIfAborted();
			const remainingMs = deadlineAt - Date.now();
			if (remainingMs <= 0) throw error;
			await new Promise<void>((resolve) => setTimeout(resolve, Math.min(25, remainingMs)));
		}
	}
}

export async function dbOwnerQuery<Row = unknown>(
	statement: DbOwnerStatement,
	options: DbOwnerSqlOptions,
): Promise<Row> {
	const owner = await getDbOwner();
	return await submitWithAdmission<Row>(
		owner,
		{ kind: "query", statement },
		{ ...options, lane: options.lane ?? "read" },
	);
}

export async function dbOwnerBatch(
	statements: readonly DbOwnerStatement[],
	options: DbOwnerSqlOptions,
): Promise<readonly unknown[]> {
	const owner = await getDbOwner();
	return await submitWithAdmission<readonly unknown[]>(owner, { kind: "batch", statements }, options);
}

export async function dbOwnerVacuumConversion(
	owner: DbOwnerClient,
	options: { readonly deadlineMs?: number } = {},
): Promise<{ readonly converted: boolean }> {
	return await submitWithAdmission<{ readonly converted: boolean }>(
		owner,
		{ kind: "vacuum_conversion" },
		{
			operation: "vacuum.conversion",
			lane: "maintenance",
			deadlineMs: options.deadlineMs ?? 15 * 60_000,
			estimatedWorkUnits: 1,
		},
	);
}

export async function dbOwnerIncrementalVacuum(
	owner: DbOwnerClient,
	pages: number,
	options: { readonly deadlineMs?: number } = {},
): Promise<number> {
	const boundedPages = Math.max(1, Math.min(10_000, Math.trunc(pages)));
	return await submitWithAdmission<number>(
		owner,
		{ kind: "incremental_vacuum", pages: boundedPages },
		{
			operation: "vacuum.incremental",
			lane: "maintenance",
			deadlineMs: options.deadlineMs ?? 60_000,
			estimatedWorkUnits: boundedPages,
		},
	);
}

/** Execute read-modify-write statements atomically on the serialized owner. */
export async function dbOwnerTransaction(
	statements: readonly DbOwnerStatement[],
	options: DbOwnerSqlOptions,
): Promise<readonly unknown[]> {
	const owner = await getDbOwner();
	return await submitWithAdmission<readonly unknown[]>(
		owner,
		{ kind: "transaction", transaction: { statements } },
		{
			...options,
			lane: options.lane ?? "write",
		},
	);
}

export async function dbOwnerSourceSnapshotImport(
	input: DbOwnerSourceSnapshotImport,
	options: DbOwnerSqlOptions,
): Promise<{ readonly imported: number }> {
	const owner = await getDbOwner();
	return await submitWithAdmission<{ readonly imported: number }>(
		owner,
		{ kind: "source_snapshot_import", input },
		{ ...options, lane: options.lane ?? "write" },
	);
}

export async function dbOwnerSourceArtifactUpsert(
	input: DbOwnerSourceArtifactUpsert,
	options: DbOwnerSqlOptions,
): Promise<{ readonly upserted: number }> {
	const owner = await getDbOwner();
	return await submitWithAdmission<{ readonly upserted: number }>(
		owner,
		{ kind: "source_artifact_upsert", input },
		{ ...options, lane: options.lane ?? "write" },
	);
}

export async function dbOwnerSourceArtifactUpsertBatch(
	input: readonly DbOwnerSourceArtifactUpsert[],
	options: DbOwnerSqlOptions,
): Promise<{ readonly upserted: number }> {
	const owner = await getDbOwner();
	return await submitWithAdmission<{ readonly upserted: number }>(
		owner,
		{ kind: "source_artifact_upsert_batch", input },
		{ ...options, lane: options.lane ?? "write", estimatedWorkUnits: options.estimatedWorkUnits ?? input.length },
	);
}

export async function dbOwnerSourceGraphIndex(
	input: DbOwnerSourceGraphIndex,
	options: DbOwnerSqlOptions,
): Promise<unknown> {
	const owner = await getDbOwner();
	return await submitWithAdmission<unknown>(
		owner,
		{ kind: "source_graph_index", input },
		{ ...options, lane: options.lane ?? "write" },
	);
}

export async function dbOwnerSourceGraphFilePurge(
	input: DbOwnerSourceGraphFilePurge,
	options: DbOwnerSqlOptions,
): Promise<unknown> {
	const owner = await getDbOwner();
	return await submitWithAdmission<unknown>(
		owner,
		{ kind: "source_graph_file_purge", input },
		{ ...options, lane: options.lane ?? "write" },
	);
}

export async function dbOwnerSourceGraphPurge(
	input: DbOwnerSourceGraphPurge,
	options: DbOwnerSqlOptions,
): Promise<unknown> {
	const owner = await getDbOwner();
	return await submitWithAdmission<unknown>(
		owner,
		{ kind: "source_graph_purge", input },
		{ ...options, lane: options.lane ?? "write" },
	);
}

export async function dbOwnerSourceArtifactIndex(
	input: DbOwnerSourceArtifactIndex,
	options: DbOwnerSqlOptions,
): Promise<unknown> {
	const owner = await getDbOwner();
	return await submitWithAdmission<unknown>(
		owner,
		{ kind: "source_artifact_index", input },
		{ ...options, lane: options.lane ?? "write" },
	);
}

export async function dbOwnerSourceNativeMemoryIndex(
	input: DbOwnerNativeMemoryIndex,
	options: DbOwnerSqlOptions,
): Promise<{
	readonly artifactChanged: boolean;
	readonly graphIndexed: boolean;
	readonly embeddingProviderUnavailable: boolean;
}> {
	const owner = await getDbOwner();
	return await submitWithAdmission<{
		readonly artifactChanged: boolean;
		readonly graphIndexed: boolean;
		readonly embeddingProviderUnavailable: boolean;
	}>(owner, { kind: "source_native_memory_index", input }, { ...options, lane: options.lane ?? "write" });
}

export async function dbOwnerSourceArtifactPurge(
	input: DbOwnerSourceArtifactPurge,
	options: DbOwnerSqlOptions,
): Promise<unknown> {
	const owner = await getDbOwner();
	return await submitWithAdmission<unknown>(
		owner,
		{ kind: "source_artifact_purge", input },
		{ ...options, lane: options.lane ?? "write" },
	);
}

export function ownerStatement(
	sql: string,
	params: readonly DbOwnerParameter[] = [],
	result: "all" | "get" | "run" = "run",
): DbOwnerStatement {
	return { sql, params, result };
}

export async function closeDbOwner(dbPath?: string): Promise<void> {
	if (dbPath !== undefined) {
		const entries = ["generic", "recall"].flatMap((workerRole) => {
			const key = `${workerRole}:${dbPath}`;
			const entry = clients.get(key);
			if (entry === undefined) return [];
			clients.delete(key);
			return [entry];
		});
		await Promise.all(entries.map((entry) => entry.owner.close()));
		return;
	}
	const entries = [...clients.values()];
	clients.clear();
	await Promise.all(entries.map((entry) => entry.owner.close()));
	isolatedTestAccessor = null;
}

registerDbAccessorCloseParticipant({
	name: "db-owner",
	order: 100,
	close: closeDbOwner,
});

export async function dbOwnerSourceEvidenceEligibility(
	input: DbOwnerSourceEvidenceEligibility,
	options: DbOwnerSqlOptions,
): Promise<boolean> {
	const owner = await getDbOwner();
	return await submitWithAdmission<boolean>(
		owner,
		{ kind: "source_evidence_eligibility", input },
		{ ...options, lane: "read" },
	);
}

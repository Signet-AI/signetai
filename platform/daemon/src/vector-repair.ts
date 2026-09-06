import { randomUUID } from "node:crypto";
import type { DbAccessor } from "./db-accessor";
import {
	getDbOwnerMaintenance,
	runOwnerMaintenanceWithRetry,
	type DbOwnerMaintenanceOptions,
} from "./db-owner-maintenance";
import {
	VECTOR_REPAIR_MAX_BATCH_DEADLINE_MS,
	VECTOR_REPAIR_MAX_BYTES_PER_BATCH,
	VECTOR_REPAIR_MAX_ROWS_PER_BATCH,
	VECTOR_REPAIR_MAX_WORK_UNITS_PER_BATCH,
	type DbOwnerVectorRepairInput,
	type DbOwnerVectorRepairOperation,
	type DbOwnerVectorRepairResult,
} from "./db-owner-protocol";
import { runDbOwnerDomainOperation } from "./db-owner-runtime";
import { applyVectorRepairBatch, VectorRepairAbortError } from "./vector-repair-owner";
import type { RepairContext, RepairResult } from "./repair-actions";

const DEFAULT_MAX_BATCHES_PER_CALL = 20;
const MAX_BATCHES_PER_CALL = 20;
const DEFAULT_RUN_BUDGET_MS = 10_000;
const MAX_RUN_BUDGET_MS = 15_000;

export interface VectorRepairOptions {
	readonly agentId: string;
	readonly batchSize?: number;
	readonly maxVectorBytes?: number;
	readonly maxBatches?: number;
	readonly runBudgetMs?: number;
	readonly signal?: AbortSignal;
	/** Compatibility seam for direct callers that expect cleanup failures to throw. */
	readonly throwOnFailure?: boolean;
}

export interface VectorRepairResult extends RepairResult {
	readonly operation: DbOwnerVectorRepairOperation;
	readonly agentId: string;
	readonly checkpointId: string;
	readonly phase: DbOwnerVectorRepairResult["phase"];
	readonly status: DbOwnerVectorRepairResult["status"];
	readonly cursor: string | null;
	readonly processed: number;
	readonly skipped: number;
	readonly failed: number;
	readonly remaining: number;
	readonly batches: number;
}

function normalizeAgentId(agentId: string): string {
	const normalized = agentId.trim();
	if (normalized.length === 0) throw new Error("vector repair requires a resolved agent id");
	return normalized;
}

function boundedBatchSize(value: number | undefined): number {
	if (value === undefined) return VECTOR_REPAIR_MAX_ROWS_PER_BATCH;
	if (!Number.isFinite(value) || value <= 0) throw new RangeError("vector repair batch size must be positive");
	return Math.max(1, Math.min(VECTOR_REPAIR_MAX_ROWS_PER_BATCH, Math.floor(value)));
}

function boundedVectorBytes(value: number | undefined): number {
	if (value === undefined) return VECTOR_REPAIR_MAX_BYTES_PER_BATCH;
	if (!Number.isFinite(value) || value <= 0) throw new RangeError("vector repair byte budget must be positive");
	return Math.max(1, Math.min(VECTOR_REPAIR_MAX_BYTES_PER_BATCH, Math.floor(value)));
}

function boundedMaxBatches(value: number | undefined): number {
	if (value === undefined) return DEFAULT_MAX_BATCHES_PER_CALL;
	if (!Number.isFinite(value) || value <= 0) throw new RangeError("vector repair maxBatches must be positive");
	return Math.max(1, Math.min(MAX_BATCHES_PER_CALL, Math.floor(value)));
}

function boundedRunBudget(value: number | undefined): number {
	if (value === undefined) return DEFAULT_RUN_BUDGET_MS;
	if (!Number.isFinite(value) || value <= 0) throw new RangeError("vector repair run budget must be positive");
	return Math.max(1, Math.min(MAX_RUN_BUDGET_MS, Math.floor(value)));
}

function operationLabel(operation: DbOwnerVectorRepairOperation): string {
	return operation === "resync" ? "resyncVectorIndex" : "cleanOrphanedEmbeddings";
}

function operationId(operation: DbOwnerVectorRepairOperation): string {
	return operation === "resync" ? "repair.vector-resync" : "repair.vector-clean";
}

function asErrorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function ownerOptions(input: DbOwnerVectorRepairInput, options: VectorRepairOptions): DbOwnerMaintenanceOptions {
	return {
		deadlineMs: VECTOR_REPAIR_MAX_BATCH_DEADLINE_MS,
		estimatedWorkUnits: Math.min(
			VECTOR_REPAIR_MAX_WORK_UNITS_PER_BATCH,
			Math.max(1, Math.floor(input.batchSize ?? VECTOR_REPAIR_MAX_ROWS_PER_BATCH)),
		),
		signal: options.signal,
	};
}

async function runOwnerBatch(
	accessor: DbAccessor,
	input: DbOwnerVectorRepairInput,
	options: VectorRepairOptions,
): Promise<DbOwnerVectorRepairResult> {
	const maintenance = getDbOwnerMaintenance();
	if (maintenance !== null) return await maintenance.vectorRepair(input, ownerOptions(input, options));

	return await runDbOwnerDomainOperation(accessor, {
		runWithOwner: async (owner) =>
			await runOwnerMaintenanceWithRetry(
				owner,
				{ kind: "vector_repair", input },
				`maintenance.vector-repair.${input.operation}`,
				ownerOptions(input, options),
			),
		runInline: (access) => {
			if (options.signal?.aborted) throw new VectorRepairAbortError();
			return access.write((db) =>
				applyVectorRepairBatch(db as never, input, {
					shouldAbort: () => options.signal?.aborted === true,
				}),
			);
		},
	});
}

function responseFromBatch(
	action: string,
	operation: DbOwnerVectorRepairOperation,
	batch: DbOwnerVectorRepairResult,
	batches: number,
	callAffected: number,
	error?: string,
): VectorRepairResult {
	const failed = error === undefined ? batch.failed : Math.max(batch.failed, batch.batchFailed);
	const success = error === undefined && batch.status !== "failed";
	const message = success
		? `${action === "resyncVectorIndex" ? "resynced vec index" : "cleaned orphaned embeddings"}; processed ${batch.processed}, ${batch.remaining} remaining; checkpoint ${batch.checkpointId}`
		: `${action} stopped after a bounded batch: ${error ?? batch.error ?? "repair failed"}; resume checkpoint ${batch.checkpointId}`;
	return {
		action,
		success,
		affected: callAffected,
		message,
		operation,
		agentId: batch.agentId,
		checkpointId: batch.checkpointId,
		phase: batch.phase,
		status: batch.status,
		cursor: batch.cursor,
		processed: batch.processed,
		skipped: batch.skipped,
		failed,
		remaining: batch.remaining,
		batches,
		details: {
			operationId: operationId(operation),
			phaseOperationId: batch.operationId,
			batchRows: batch.batchRows,
			batchBytes: batch.batchBytes,
			batchProcessed: batch.batchProcessed,
			batchSkipped: batch.batchSkipped,
			batchFailed: batch.batchFailed,
			batchAffected: batch.batchAffected,
			maxRowsPerBatch: VECTOR_REPAIR_MAX_ROWS_PER_BATCH,
			maxBytesPerBatch: VECTOR_REPAIR_MAX_BYTES_PER_BATCH,
			maxDeadlineMs: VECTOR_REPAIR_MAX_BATCH_DEADLINE_MS,
		},
	};
}

/**
 * Run a bounded, checkpointed vector-repair application service. Each owner
 * call commits at most one hard-capped page; the loop only drains a bounded
 * number of pages before returning control to the HTTP caller.
 */
export async function runVectorRepair(
	accessor: DbAccessor,
	ctx: RepairContext,
	operation: DbOwnerVectorRepairOperation,
	options: VectorRepairOptions,
): Promise<VectorRepairResult> {
	const agentId = normalizeAgentId(options.agentId);
	const action = operationLabel(operation);
	const checkpointId = `vector-repair-${randomUUID()}`;
	const batchSize = boundedBatchSize(options.batchSize);
	const maxVectorBytes = boundedVectorBytes(options.maxVectorBytes);
	const maxBatches = boundedMaxBatches(options.maxBatches);
	const runBudgetMs = boundedRunBudget(options.runBudgetMs);
	const startedAt = Date.now();
	let latest: DbOwnerVectorRepairResult | null = null;
	let callAffected = 0;
	let batches = 0;

	for (; batches < maxBatches && Date.now() - startedAt < runBudgetMs; ) {
		if (options.signal?.aborted) break;
		batches += 1;
		const input: DbOwnerVectorRepairInput = {
			operation,
			agentId,
			checkpointId,
			batchSize,
			maxVectorBytes,
			audit: {
				action,
				actor: ctx.actor,
				reason: ctx.reason,
				actorType: ctx.actorType,
				...(ctx.requestId === undefined ? {} : { requestId: ctx.requestId }),
			},
		};
		try {
			const phaseBefore = latest?.phase ?? (operation === "resync" ? "orphan-vectors" : "orphan-embeddings");
			const batch = await runOwnerBatch(accessor, input, options);
			latest = batch;
			callAffected += batch.batchAffected;
			if (batch.status === "complete" || batch.status === "failed") break;
			// A phase transition can legitimately have no rows. A byte ceiling,
			// however, can leave the first candidate for the next call; do not spin
			// on a cursor that did not advance within the same phase.
			if (batch.batchRows === 0 && batch.phase === phaseBefore) break;
			await new Promise<void>((resolve) => setImmediate(resolve));
		} catch (error) {
			const message = asErrorMessage(error);
			if (latest !== null) return responseFromBatch(action, operation, latest, batches, callAffected, message);
			const fallback: DbOwnerVectorRepairResult = {
				operation,
				agentId,
				checkpointId,
				phase: operation === "resync" ? "orphan-vectors" : "orphan-embeddings",
				status: "failed",
				cursor: null,
				processed: 0,
				skipped: 0,
				failed: 1,
				affected: 0,
				remaining: 0,
				batchRows: 0,
				batchBytes: 0,
				batchProcessed: 0,
				batchSkipped: 0,
				batchFailed: 1,
				batchAffected: 0,
				operationId: operationId(operation),
				error: message,
			};
			return responseFromBatch(action, operation, fallback, batches, callAffected, message);
		}
	}

	if (latest === null) {
		const fallback: DbOwnerVectorRepairResult = {
			operation,
			agentId,
			checkpointId,
			phase: operation === "resync" ? "orphan-vectors" : "orphan-embeddings",
			status: "running",
			cursor: null,
			processed: 0,
			skipped: 0,
			failed: 0,
			affected: 0,
			remaining: 0,
			batchRows: 0,
			batchBytes: 0,
			batchProcessed: 0,
			batchSkipped: 0,
			batchFailed: 0,
			batchAffected: 0,
			operationId: operationId(operation),
		};
		return responseFromBatch(
			action,
			operation,
			fallback,
			batches,
			0,
			options.signal?.aborted ? "repair cancelled" : undefined,
		);
	}
	return responseFromBatch(action, operation, latest, batches, callAffected);
}

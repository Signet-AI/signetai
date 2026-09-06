/**
 * Operator-facing whole-database integrity verification.
 *
 * The HTTP process never receives a SQLite handle for this operation. Both
 * global PRAGMAs are admitted as serializable jobs on the database owner's
 * verification lane. That lane can retire its child when a synchronous native
 * scan reaches a deadline or is cancelled, so the caller receives an honest
 * terminal outcome instead of a detached Promise.
 */

import { DbOwnerCancelledError, DbOwnerDeadlineError, type DbOwnerClient } from "./db-owner-client";
import { ownerQueryAll, type DbOwnerMaintenanceMetrics } from "./db-owner-maintenance";
import { getDbOwnerForAccessor } from "./db-owner-runtime";
import {
	publishDatabaseIntegrityStatus,
	type DatabaseIntegrityProgress,
	type IntegrityCheckStatus,
	updateDatabaseIntegrityStatus,
} from "./database-integrity";
import type { DbAccessor } from "./db-accessor";

export const OPERATOR_INTEGRITY_CHECKPOINT_KEY = "database.operator-integrity";
export const DEFAULT_OPERATOR_INTEGRITY_DEADLINE_MS = 60_000;
export const MAX_OPERATOR_INTEGRITY_DEADLINE_MS = 15 * 60_000;

export type IntegrityCheckPhase = "complete" | "timed_out" | "cancelled" | "unavailable";
export type IntegrityCheckOutcome = "passed" | "failed" | "timed_out" | "cancelled" | "unavailable";

export interface IntegrityCheckResult {
	readonly ok: boolean;
	readonly messages: readonly string[];
	readonly quickCheck: IntegrityCheckStatus;
	readonly fullCheck: IntegrityCheckStatus;
	readonly phase: IntegrityCheckPhase;
	readonly outcome: IntegrityCheckOutcome;
	readonly error: string | null;
	readonly executionHome: "db-owner.verify";
	readonly checkpointKey: string;
	readonly deadlineMs: number;
	readonly durationMs: number;
	readonly ownerQueueAdmissionMs: number;
	readonly ownerExecutionMs: number;
}

export interface OperatorIntegrityCheckOptions {
	readonly owner?: DbOwnerClient;
	readonly deadlineMs?: number;
	readonly signal?: AbortSignal;
	readonly onProgress?: (progress: DatabaseIntegrityProgress) => void | Promise<void>;
}

interface IntegrityCheckRow {
	readonly quick_check?: unknown;
	readonly integrity_check?: unknown;
}

const NOT_CHECKED: IntegrityCheckStatus = { ok: false, messages: ["not checked"] };

function boundedDeadline(value: number | undefined): number {
	if (value === undefined) return DEFAULT_OPERATOR_INTEGRITY_DEADLINE_MS;
	if (!Number.isFinite(value) || value <= 0) throw new RangeError("integrity deadline must be positive");
	return Math.min(MAX_OPERATOR_INTEGRITY_DEADLINE_MS, Math.floor(value));
}

function checkResult(rows: readonly IntegrityCheckRow[], key: "quick_check" | "integrity_check"): IntegrityCheckStatus {
	const messages = rows.map((row) => String(row[key] ?? ""));
	return messages.length === 1 && messages[0] === "ok" ? { ok: true, messages: [] } : { ok: false, messages };
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function failurePhase(error: unknown): {
	readonly phase: Exclude<IntegrityCheckPhase, "complete">;
	readonly outcome: Exclude<IntegrityCheckOutcome, "passed" | "failed">;
} {
	if (error instanceof DbOwnerDeadlineError || (error instanceof Error && error.name === "DbOwnerDeadlineError")) {
		return { phase: "timed_out", outcome: "timed_out" };
	}
	if (error instanceof DbOwnerCancelledError || (error instanceof Error && error.name === "DbOwnerCancelledError")) {
		return { phase: "cancelled", outcome: "cancelled" };
	}
	return { phase: "unavailable", outcome: "unavailable" };
}

export async function runOperatorIntegrityCheck(
	accessor: DbAccessor,
	options: OperatorIntegrityCheckOptions = {},
): Promise<IntegrityCheckResult> {
	const deadlineMs = boundedDeadline(options.deadlineMs);
	const startedAt = Date.now();
	const deadlineAt = startedAt + deadlineMs;
	let ownerQueueAdmissionMs = 0;
	let ownerExecutionMs = 0;
	let checkedObjects = 0;
	let failedObjects = 0;
	let lastObject: string | null = null;
	let quickCheck: IntegrityCheckStatus = NOT_CHECKED;
	let fullCheck: IntegrityCheckStatus = NOT_CHECKED;
	let owner: DbOwnerClient | undefined = options.owner;

	const recordOwnerMetrics = (metrics: DbOwnerMaintenanceMetrics): void => {
		ownerQueueAdmissionMs += metrics.queueAdmissionMs;
		ownerExecutionMs += metrics.ownerExecutionMs;
	};
	const remainingDeadline = (): number => {
		const remaining = deadlineAt - Date.now();
		if (remaining < 1) throw new DbOwnerDeadlineError(OPERATOR_INTEGRITY_CHECKPOINT_KEY);
		return Math.floor(remaining);
	};
	const emit = async (
		phase: DatabaseIntegrityProgress["phase"],
		cancellationReason: string | null,
		degradationReason: string | null,
		errors: readonly string[],
	): Promise<void> => {
		const progress: DatabaseIntegrityProgress = {
			checkpointKey: OPERATOR_INTEGRITY_CHECKPOINT_KEY,
			phase,
			checkedObjects,
			failedObjects,
			remainingObjects: Math.max(0, 2 - checkedObjects),
			lastObject,
			databasePagesObserved: 0,
			databaseBytesObserved: 0,
			elapsedMs: Date.now() - startedAt,
			ownerQueueAdmissionMs,
			ownerExecutionMs,
			cancellationReason,
			degradationReason,
		};
		updateDatabaseIntegrityStatus(progress, errors, owner);
		await options.onProgress?.(progress);
	};

	await emit("running", null, null, []);

	try {
		owner ??= await getDbOwnerForAccessor(accessor);
		const queryOptions = {
			signal: options.signal,
			estimatedWorkUnits: 64,
			killOnDeadline: true,
			killOnCancel: true,
			onOwnerMetrics: recordOwnerMetrics,
		};

		lastObject = "global:quick_check";
		quickCheck = checkResult(
			await ownerQueryAll<IntegrityCheckRow>(owner, "integrity.operator.quick-check", "PRAGMA quick_check", [], {
				...queryOptions,
				deadlineMs: remainingDeadline(),
			}),
			"quick_check",
		);
		checkedObjects = 1;
		if (!quickCheck.ok) failedObjects += 1;
		await emit("running", null, null, quickCheck.ok ? [] : quickCheck.messages);

		lastObject = "global:integrity_check";
		fullCheck = checkResult(
			await ownerQueryAll<IntegrityCheckRow>(owner, "integrity.operator.full-check", "PRAGMA integrity_check", [], {
				...queryOptions,
				deadlineMs: remainingDeadline(),
			}),
			"integrity_check",
		);
		checkedObjects = 2;
		if (!fullCheck.ok) failedObjects += 1;

		const messages = [...quickCheck.messages, ...fullCheck.messages];
		const ok = quickCheck.ok && fullCheck.ok;
		const outcome: IntegrityCheckOutcome = ok ? "passed" : "failed";
		await emit("complete", null, null, messages);
		publishDatabaseIntegrityStatus(ok ? "healthy" : "corrupt", messages, owner);
		return {
			ok,
			messages,
			quickCheck,
			fullCheck,
			phase: "complete",
			outcome,
			error: null,
			executionHome: "db-owner.verify",
			checkpointKey: OPERATOR_INTEGRITY_CHECKPOINT_KEY,
			deadlineMs,
			durationMs: Date.now() - startedAt,
			ownerQueueAdmissionMs,
			ownerExecutionMs,
		};
	} catch (error) {
		const message = errorMessage(error);
		const failure = failurePhase(error);
		const errors = [...quickCheck.messages.filter((entry) => entry !== "not checked"), message];
		await emit(failure.phase, message, failure.phase === "unavailable" ? "integrity-unavailable" : null, errors);
		publishDatabaseIntegrityStatus("unavailable", [message], owner);
		return {
			ok: false,
			messages: errors,
			quickCheck,
			fullCheck,
			phase: failure.phase,
			outcome: failure.outcome,
			error: message,
			executionHome: "db-owner.verify",
			checkpointKey: OPERATOR_INTEGRITY_CHECKPOINT_KEY,
			deadlineMs,
			durationMs: Date.now() - startedAt,
			ownerQueueAdmissionMs,
			ownerExecutionMs,
		};
	}
}

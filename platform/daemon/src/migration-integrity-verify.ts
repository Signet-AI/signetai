import type { DbOwnerClient } from "./db-owner-client";
import { DB_OWNER_MAX_MAINTENANCE_DEADLINE_MS } from "./db-owner-protocol";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { basename } from "node:path";
import {
	incrementMigrationVerifyAttempt,
	markMigrationVerifyTerminal,
	MIGRATION_VERIFY_FAILED_STATUS,
	MIGRATION_VERIFY_PARKED_STATUS,
	readMigrationVerifyCheckpoint,
	type MigrationVerifyCheckpoint,
} from "./incremental-database-integrity";
import { ownerQueryAll } from "./db-owner-maintenance";

export const MIGRATION_VERIFY_ATTEMPT_DEADLINE_MS = 300_000;
export const MIGRATION_VERIFY_RETRY_INTERVAL_MS = 30 * 60_000;
export const MIGRATION_VERIFY_MAX_INCOMPLETE_ATTEMPTS = 8;
export const MIGRATION_VERIFY_SETUP_REJECTION_MAX_ATTEMPTS = 3;
const MIGRATION_VERIFY_SCAN_BYTES_PER_SECOND = 64 * 1024 * 1024;
export { MIGRATION_VERIFY_PARKED_STATUS, MIGRATION_VERIFY_FAILED_STATUS };

export function migrationVerifyVerdictPath(backupPath: string): string {
	return `${backupPath}.verdict.json`;
}

export function readMigrationVerifySidecarStatus(backupPath: string): string | undefined {
	try {
		const parsed = JSON.parse(readFileSync(migrationVerifyVerdictPath(backupPath), "utf8")) as {
			status?: unknown;
		};
		return typeof parsed.status === "string" ? parsed.status : undefined;
	} catch {
		return undefined;
	}
}

function writeMigrationVerifyTerminalVerdict(
	backupPath: string,
	status: typeof MIGRATION_VERIFY_PARKED_STATUS | typeof MIGRATION_VERIFY_FAILED_STATUS,
	findingsCount: number,
	log?: (message: string, details?: Record<string, unknown>) => void,
): void {
	const verdictPath = migrationVerifyVerdictPath(backupPath);
	const tempPath = `${verdictPath}.tmp-${process.pid}`;
	try {
		writeFileSync(
			tempPath,
			`${JSON.stringify({ status, classifiedAt: new Date().toISOString(), findingsCount })}\n`,
			"utf8",
		);
		renameSync(tempPath, verdictPath);
	} catch (error) {
		log?.("Migration integrity terminal verdict sidecar write failed", {
			status,
			verdictPath,
			error: error instanceof Error ? error.message : String(error),
		});
	}
}

export interface MigrationVerifyResult {
	readonly phase: "pass" | "incomplete" | "failed";
	readonly admitted: boolean;
	readonly messages: readonly string[];
	readonly elapsedMs: number;
	readonly attemptDeadlineMs: number;
}

export interface MigrationVerifyOptions {
	readonly owner: DbOwnerClient;
	readonly attemptDeadlineMs?: number;
	readonly onProgress?: (result: MigrationVerifyResult) => void | Promise<void>;
	readonly onWorkerSettled?: () => void | Promise<void>;
	readonly onAdmissionFailure?: (error: unknown) => void;
}

export function migrationVerifyAttemptDeadlineMs(databaseSizeBytes: number): number {
	const sizeBytes = Number.isFinite(databaseSizeBytes) ? Math.max(0, databaseSizeBytes) : 0;
	const sizeAllowanceMs = Math.ceil(sizeBytes / MIGRATION_VERIFY_SCAN_BYTES_PER_SECOND) * 1000;
	const sizeDerivedBudgetMs = MIGRATION_VERIFY_ATTEMPT_DEADLINE_MS + sizeAllowanceMs;
	return Math.min(
		Math.max(sizeDerivedBudgetMs, MIGRATION_VERIFY_ATTEMPT_DEADLINE_MS),
		DB_OWNER_MAX_MAINTENANCE_DEADLINE_MS,
	);
}

interface IntegrityCheckRow {
	readonly integrity_check?: unknown;
}

const text = (value: unknown): string => String(value ?? "");

type SqliteErrorCode = string | number;

function sqliteErrorCode(error: unknown): SqliteErrorCode | undefined {
	if (typeof error !== "object" || error === null) return undefined;
	const record = error as Record<string, unknown>;
	const value = record.sqliteCode ?? record.code;
	return typeof value === "string" || typeof value === "number" ? value : undefined;
}

function isSqliteCorruptionCode(code: SqliteErrorCode): boolean {
	if (typeof code === "number") return code === 11 || code === 26;
	const normalized = code.toUpperCase();
	return (
		normalized === "11" ||
		normalized === "26" ||
		normalized.startsWith("SQLITE_CORRUPT") ||
		normalized === "SQLITE_NOTADB"
	);
}
export async function runMigrationIntegrityVerify(options: MigrationVerifyOptions): Promise<MigrationVerifyResult> {
	const attemptDeadlineMs = options.attemptDeadlineMs ?? MIGRATION_VERIFY_ATTEMPT_DEADLINE_MS;
	const startedAt = Date.now();
	let admitted = true;
	try {
		const rows = await ownerQueryAll<IntegrityCheckRow>(
			options.owner,
			"integrity.migration-verify.global",
			"PRAGMA integrity_check",
			[],
			{
				deadlineMs: attemptDeadlineMs,
				estimatedWorkUnits: 64,
				onOwnerJobSettled: options.onWorkerSettled,
				onOwnerJobAdmissionFailure: (error): void => {
					admitted = false;
					options.onAdmissionFailure?.(error);
				},
			},
		);
		const messages = rows.map((row) => text(row.integrity_check));
		const result: MigrationVerifyResult = {
			phase: messages.length === 1 && messages[0] === "ok" ? "pass" : "failed",
			admitted,
			messages,
			elapsedMs: Date.now() - startedAt,
			attemptDeadlineMs,
		};
		await options.onProgress?.(result);
		return result;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		const normalizedMessage = message.toLowerCase();
		const isDeadline = message.includes("exceeded its deadline") || message.includes("DB_OWNER_DEADLINE");
		const code = sqliteErrorCode(error);
		const isRecognizedCorruption =
			code === undefined
				? ["database disk image is malformed", "file is not a database", "database disk image malformed"].some(
						(signature) => normalizedMessage.includes(signature),
					)
				: isSqliteCorruptionCode(code);
		const result: MigrationVerifyResult = {
			phase: isDeadline || !isRecognizedCorruption ? "incomplete" : "failed",
			admitted,
			messages: [message],
			elapsedMs: Date.now() - startedAt,
			attemptDeadlineMs,
		};
		await options.onProgress?.(result);
		return result;
	}
}

export interface MigrationVerifyCheckpointStore {
	readonly read: () => Promise<MigrationVerifyCheckpoint>;
	readonly incrementIncompleteAttempt: () => Promise<number>;
	readonly markTerminal: (
		status: typeof MIGRATION_VERIFY_PARKED_STATUS | typeof MIGRATION_VERIFY_FAILED_STATUS | "complete",
	) => Promise<void>;
}

export interface MigrationVerifyGateOptions {
	readonly owner: DbOwnerClient;
	readonly backupPath: string;
	readonly databaseSizeBytes?: number;
	readonly checkpointStore?: MigrationVerifyCheckpointStore;
	readonly runAttempt?: () => Promise<MigrationVerifyResult>;
	readonly pruneBackup: () => void | Promise<void>;
	readonly scheduleNextAttempt?: (callback: () => void, delayMs: number) => void;
	readonly onProgress?: (result: MigrationVerifyResult) => void | Promise<void>;
	readonly onWorkerSettled?: () => void | Promise<void>;
	readonly onAdmissionFailure?: (error: unknown) => void;
	readonly publishStatus?: (state: "healthy" | "corrupt" | "degraded", messages?: readonly string[]) => void;
	readonly armWriteBlock?: () => void;
	readonly resetGlobalLatch?: () => void;
	readonly log?: (message: string, details?: Record<string, unknown>) => void;
	readonly continuation?: () => Promise<MigrationVerifyGateResult>;
	readonly onContinuationRejection?: (callback: () => Promise<unknown>, error: unknown) => void;
}

export interface MigrationVerifyGateResult {
	readonly phase: MigrationVerifyResult["phase"] | "parked" | "terminal";
	readonly attemptCount: number;
	readonly admitted: boolean;
	readonly scheduled: boolean;
}

function defaultScheduleNextAttempt(callback: () => void): void {
	const timer = setTimeout(callback, MIGRATION_VERIFY_RETRY_INTERVAL_MS);
	(timer as unknown as { unref?: () => void }).unref?.();
}

export function migrationVerifyCheckpointKey(backupPath: string): string {
	return `database.migration-verify:${basename(backupPath)}`;
}

function ownerCheckpointStore(owner: DbOwnerClient, backupPath: string): MigrationVerifyCheckpointStore {
	const checkpointKey = migrationVerifyCheckpointKey(backupPath);
	return {
		read: () => readMigrationVerifyCheckpoint(owner, checkpointKey, 5_000),
		incrementIncompleteAttempt: () => incrementMigrationVerifyAttempt(owner, checkpointKey, 5_000),
		markTerminal: (status) => markMigrationVerifyTerminal(owner, status, checkpointKey, 5_000),
	};
}

export interface MigrationVerifySetupRetryOptions {
	readonly run: () => Promise<unknown>;
	readonly publishStatus?: (state: "degraded", messages: readonly string[]) => void;
	readonly scheduleNextAttempt?: (callback: () => void, delayMs: number) => void;
	readonly logWarn?: (message: string, details: Record<string, unknown>) => void;
	readonly logError?: (message: string, error: Error, details: Record<string, unknown>) => void;
}

export interface MigrationVerifySetupRetryController {
	readonly run: () => void;
	readonly handleRejection: (callback: () => Promise<unknown>, error: unknown) => void;
}
export function createMigrationVerifySetupRetry(
	options: MigrationVerifySetupRetryOptions,
): MigrationVerifySetupRetryController {
	const schedule = options.scheduleNextAttempt ?? defaultScheduleNextAttempt;
	let rejectionAttempts = 0;

	const handleRejection = (callback: () => Promise<unknown>, error: unknown): void => {
		const attemptCount = rejectionAttempts + 1;
		rejectionAttempts = attemptCount;
		const rejectionError = error instanceof Error ? error : new Error(String(error));
		options.publishStatus?.("degraded", ["degraded:integrity-unverified"]);
		if (attemptCount >= MIGRATION_VERIFY_SETUP_REJECTION_MAX_ATTEMPTS) {
			options.logError?.("Migration integrity verify setup rejected; retry cap reached", rejectionError, {
				attemptCount,
				maxAttempts: MIGRATION_VERIFY_SETUP_REJECTION_MAX_ATTEMPTS,
			});
			return;
		}
		options.logWarn?.("Migration integrity verify setup rejected; retry scheduled", {
			attemptCount,
			retryDelayMs: MIGRATION_VERIFY_RETRY_INTERVAL_MS,
			error: rejectionError.message,
		});
		schedule(() => run(callback), MIGRATION_VERIFY_RETRY_INTERVAL_MS);
	};
	const run = (callback: () => Promise<unknown>): void => {
		void Promise.resolve()
			.then(callback)
			.then(() => {
				rejectionAttempts = 0;
			})
			.catch((error: unknown) => handleRejection(callback, error));
	};

	return {
		run: () => run(options.run),
		handleRejection,
	};
}
export async function runMigrationIntegrityVerifyGate(
	options: MigrationVerifyGateOptions,
): Promise<MigrationVerifyGateResult> {
	const store = options.checkpointStore ?? ownerCheckpointStore(options.owner, options.backupPath);
	const checkpoint = await store.read();
	if (checkpoint.status === MIGRATION_VERIFY_PARKED_STATUS || checkpoint.status === MIGRATION_VERIFY_FAILED_STATUS) {
		const failed = checkpoint.status === MIGRATION_VERIFY_FAILED_STATUS;
		options.publishStatus?.(
			failed ? "corrupt" : "degraded",
			failed ? ["global integrity verification previously failed"] : ["degraded:integrity-unverified"],
		);
		if (failed) options.armWriteBlock?.();
		options.log?.("Migration integrity verify terminal state retained", {
			phase: checkpoint.status,
			attemptCount: checkpoint.attemptCount,
		});
		return { phase: "terminal", attemptCount: checkpoint.attemptCount, admitted: false, scheduled: false };
	}

	options.publishStatus?.("degraded", ["degraded:integrity-unverified"]);
	const attemptDeadlineMs = migrationVerifyAttemptDeadlineMs(options.databaseSizeBytes ?? 0);
	const attemptCount = await store.incrementIncompleteAttempt();
	const result = await (
		options.runAttempt ??
		(() =>
			runMigrationIntegrityVerify({
				owner: options.owner,
				attemptDeadlineMs,
				onProgress: options.onProgress,
				onWorkerSettled: options.onWorkerSettled,
				onAdmissionFailure: options.onAdmissionFailure,
			}))
	)();
	if (options.runAttempt !== undefined) await options.onProgress?.(result);

	if (result.phase === "pass") {
		await store.markTerminal("complete");
		try {
			await options.pruneBackup();
		} catch (error) {
			options.log?.("Global integrity check passed but rollback backup prune failed", {
				error: error instanceof Error ? error.message : String(error),
			});
			throw error;
		}
		options.resetGlobalLatch?.();
		options.publishStatus?.("healthy");
		options.log?.("Global integrity check passed; rollback backup pruned", { elapsedMs: result.elapsedMs });
		return { phase: "pass", attemptCount, admitted: result.admitted, scheduled: false };
	}
	if (result.phase === "failed") {
		options.publishStatus?.("corrupt", result.messages);
		writeMigrationVerifyTerminalVerdict(
			options.backupPath,
			MIGRATION_VERIFY_FAILED_STATUS,
			result.messages.length,
			options.log,
		);
		let persistenceError: unknown;
		try {
			await store.markTerminal(MIGRATION_VERIFY_FAILED_STATUS);
		} catch (error) {
			persistenceError = error;
			options.log?.("Global integrity check failed; terminal checkpoint persistence rejected", {
				error: error instanceof Error ? error.message : String(error),
				status: MIGRATION_VERIFY_FAILED_STATUS,
			});
		}
		options.armWriteBlock?.();
		if (persistenceError !== undefined) throw persistenceError;
		options.log?.("Global integrity check FAILED; rollback backup retained", {
			messages: result.messages,
			elapsedMs: result.elapsedMs,
		});
		return { phase: "failed", attemptCount, admitted: result.admitted, scheduled: false };
	}

	options.log?.("degraded:integrity-unverified", {
		attemptCount,
		rollbackBackup: "retained",
	});
	if (attemptCount >= MIGRATION_VERIFY_MAX_INCOMPLETE_ATTEMPTS) {
		writeMigrationVerifyTerminalVerdict(
			options.backupPath,
			MIGRATION_VERIFY_PARKED_STATUS,
			result.messages.length,
			options.log,
		);
		await store.markTerminal(MIGRATION_VERIFY_PARKED_STATUS);
		options.log?.("degraded:integrity-unverified", {
			attemptCount,
			rollbackBackup: "retained",
			operatorSignal: true,
		});
		return { phase: "parked", attemptCount, admitted: result.admitted, scheduled: false };
	}

	const schedule = options.scheduleNextAttempt ?? defaultScheduleNextAttempt;
	const continuation = options.continuation ?? (() => runMigrationIntegrityVerifyGate(options));
	schedule(() => {
		void continuation().catch((error) => {
			if (options.onContinuationRejection !== undefined) {
				options.onContinuationRejection(continuation, error);
				return;
			}
			options.log?.("Migration integrity verify continuation rejected", {
				error: error instanceof Error ? error.message : String(error),
			});
		});
	}, MIGRATION_VERIFY_RETRY_INTERVAL_MS);
	options.log?.("Migration integrity verify incomplete; next attempt scheduled", {
		attemptCount,
		intervalMs: MIGRATION_VERIFY_RETRY_INTERVAL_MS,
		elapsedMs: result.elapsedMs,
	});
	return { phase: "incomplete", attemptCount, admitted: result.admitted, scheduled: true };
}

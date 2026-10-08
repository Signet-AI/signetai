import { isMainThread, parentPort, threadId } from "node:worker_threads";
import type { SignetSourceKind } from "@signet/core";
import {
	DbOwnerAdmissionError,
	DbOwnerCancelledError,
	DbOwnerDeadlineError,
	DbOwnerDiedError,
	DbOwnerError,
	DbOwnerWritesBlockedError,
	type DbOwnerClient,
	type DbOwnerJobHandle,
} from "./db-owner-client";
import type { DbOwnerSerializedError } from "./db-owner-protocol";
import { registerDbOwnerRelay } from "./db-owner-runtime";
import { logger } from "./logger";
import { syncNotionSource } from "./notion-source-provider";
import {
	type SourceSyncHostMessage,
	type SourceSyncWorkerJob,
	type SourceSyncWorkerMessage,
	SOURCE_SYNC_WORKER_MAX_MESSAGE_BYTES,
	boundedErrorMessage,
	decodeSourceSyncFrame,
	postSourceSyncFrame,
	sourceSyncFrameBytes,
} from "./source-sync-worker-protocol";
import type { SourceProviderSyncContext, SourceProviderSyncResult } from "./source-providers";
import { syncWebSource } from "./web-source-provider";

const workerSyncs: Partial<
	Record<SignetSourceKind, (context: SourceProviderSyncContext) => Promise<SourceProviderSyncResult>>
> = {
	notion: syncNotionSource,
	web: syncWebSource,
};

interface PendingRelay<Result> {
	readonly resolve: (value: Result) => void;
	readonly reject: (error: Error) => void;
}

function ownerError(error: DbOwnerSerializedError): DbOwnerError {
	if (error.code === "DB_OWNER_QUEUE_FULL" || error.code === "DB_OWNER_WORK_BUDGET")
		return new DbOwnerAdmissionError(error.code, error.message);
	if (error.code === "DB_OWNER_DEADLINE") return Object.assign(new DbOwnerDeadlineError("relay"), error);
	if (error.code === "DB_OWNER_CANCELLED") return Object.assign(new DbOwnerCancelledError("relay"), error);
	if (error.code === "DB_OWNER_WRITES_BLOCKED") return new DbOwnerWritesBlockedError();
	if (error.name === "DbOwnerDiedError")
		return new DbOwnerDiedError(error.message, error.code, error.causeFamily, error.sqliteCode);
	const relayed = new DbOwnerError(error.code ?? error.name, error.message, error.causeFamily, error.sqliteCode);
	relayed.name = error.name;
	return relayed;
}

export function runSourceSyncWorker(): void {
	const port = parentPort;
	if (port === null) throw new Error("source sync worker requires a parent port");
	let cancelled = false;
	let started = false;
	let sequence = 0;
	const ownerJobs = new Map<string, PendingRelay<unknown>>();
	const secrets = new Map<string, PendingRelay<string>>();
	const send = (message: SourceSyncWorkerMessage): void => {
		if (sourceSyncFrameBytes(message) > SOURCE_SYNC_WORKER_MAX_MESSAGE_BYTES)
			throw new Error(`source sync worker frame exceeds the ${SOURCE_SYNC_WORKER_MAX_MESSAGE_BYTES}-byte IPC limit`);
		postSourceSyncFrame(port, message);
	};
	const relay = <Result>(
		pending: Map<string, PendingRelay<Result>>,
		message: SourceSyncWorkerMessage & { id: string },
	) =>
		new Promise<Result>((resolve, reject) => {
			pending.set(message.id, { resolve, reject });
			try {
				send(message);
			} catch (error) {
				pending.delete(message.id);
				reject(error instanceof Error ? error : new Error(String(error)));
			}
		});

	const owner: DbOwnerClient = {
		start: async () => undefined,
		initialize: async () => {
			throw new Error("source sync worker cannot initialize the DB owner");
		},
		submit: <Result>(
			request: Parameters<DbOwnerClient["submit"]>[0],
			options: Parameters<DbOwnerClient["submit"]>[1],
		): DbOwnerJobHandle<Result> => {
			const id = `source-sync-owner-${++sequence}`;
			const now = Date.now();
			const result = relay(ownerJobs as Map<string, PendingRelay<Result>>, {
				type: "owner_submit",
				id,
				request,
				options,
			});
			return {
				job: {
					id,
					operation: options.operation,
					lane: options.lane,
					workloadClass: options.workloadClass ?? "foreground",
					enqueuedAt: now,
					deadlineAt: now + options.deadlineMs,
					estimatedWorkUnits: options.estimatedWorkUnits ?? 1,
					cancellation: "pending",
					request,
				},
				result,
				cancel: () => owner.cancel(id),
			};
		},
		setWriteBlocked: () => undefined,
		awaitResult: async <Result>(handle: DbOwnerJobHandle<Result>) => await handle.result,
		cancel: (jobId: string) => {
			if (ownerJobs.has(jobId)) send({ type: "owner_cancel", id: jobId });
		},
		health: () => ({
			state: "ready",
			initialization: "ready",
			databaseReady: true,
			pid: null,
			generation: 0,
			queuedJobs: ownerJobs.size,
			foregroundQueuedJobs: 0,
			maintenanceQueuedJobs: ownerJobs.size,
			activeJobId: null,
			activeWorkloadClass: null,
			foregroundOldestAgeMs: null,
			maintenanceOldestAgeMs: null,
			lastError: null,
		}),
		close: async () => undefined,
		migrationControl: () => {
			throw new Error("source sync worker has no migration control boundary");
		},
	};
	registerDbOwnerRelay(owner);
	logger.forwardTo((entry) => {
		try {
			send({ type: "log", entry });
		} catch {}
	});

	const run = async (job: SourceSyncWorkerJob): Promise<SourceProviderSyncResult> => {
		const sync = workerSyncs[job.source.kind];
		if (sync === undefined) throw new Error(`Source sync worker does not host provider: ${job.source.kind}`);
		return await sync({
			source: job.source,
			agentsDir: job.agentsDir,
			agentId: job.agentId,
			shouldContinue: () => !cancelled,
			onProgress: (event) => send({ type: "progress", event }),
			getSecret: (name) => relay(secrets, { type: "secret", id: `source-sync-secret-${++sequence}`, name }),
		});
	};

	port.on("message", (raw: unknown) => {
		const message = decodeSourceSyncFrame<SourceSyncHostMessage>(raw);
		if (message === null) return;
		if (message.type === "sync") {
			if (started) return;
			started = true;
			void run(message.job).then(
				(result) => {
					try {
						send({ type: "result", result });
					} catch (error) {
						send({ type: "error", message: boundedErrorMessage(error) });
					}
				},
				(error: unknown) => send({ type: "error", message: boundedErrorMessage(error) }),
			);
			return;
		}
		if (message.type === "cancel") {
			cancelled = true;
			return;
		}
		if (message.type === "owner_result" || message.type === "owner_error") {
			const pending = ownerJobs.get(message.id);
			if (pending === undefined) return;
			ownerJobs.delete(message.id);
			if (message.type === "owner_result") pending.resolve(message.result);
			else pending.reject(ownerError(message.error));
			return;
		}
		const pending = secrets.get(message.id);
		if (pending === undefined) return;
		secrets.delete(message.id);
		if (message.type === "secret_result") pending.resolve(message.value);
		else pending.reject(new Error(message.message));
	});
	send({ type: "ready", threadId });
}

if (!isMainThread && parentPort !== null) {
	runSourceSyncWorker();
}

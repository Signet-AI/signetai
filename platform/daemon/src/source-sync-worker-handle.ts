import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import { DbOwnerAdmissionError, DbOwnerCancelledError, type DbOwnerJobHandle } from "./db-owner-client";
import { getDbOwner } from "./db-owner-runtime";
import { type LogCategory, type LogEntry, logger } from "./logger";
import { resolveEmbeddedWorkerPath } from "./native-runtime-assets";
import type { SourceProviderSyncContext, SourceProviderSyncResult } from "./source-providers";
import {
	type SourceSyncHostMessage,
	type SourceSyncWorkerMessage,
	SOURCE_SYNC_WORKER_MAX_OWNER_JOBS,
	SOURCE_SYNC_WORKER_OWNER_REQUESTS,
	boundedErrorMessage,
	decodeSourceSyncFrame,
	postSourceSyncFrame,
	serializeOwnerError,
} from "./source-sync-worker-protocol";

export const SOURCE_SYNC_WORKER_READY_TIMEOUT_MS = 15_000;
export const SOURCE_SYNC_WORKER_CANCEL_POLL_MS = 250;
export const SOURCE_SYNC_WORKER_CANCEL_GRACE_MS = 5_000;

export interface SourceSyncWorkerOptions {
	readonly workerPath?: string;
	readonly readyTimeoutMs?: number;
	readonly cancelPollMs?: number;
	readonly cancelGraceMs?: number;
	readonly onReady?: (threadId: number) => void;
}

const liveWorkers = new Set<(error: Error) => void>();
const terminations = new Set<Promise<void>>();

function sourceSyncWorkerPath(): string {
	const embedded = resolveEmbeddedWorkerPath("source-sync-worker");
	if (embedded !== null) return embedded;
	const directory = dirname(fileURLToPath(import.meta.url));
	const bundled = join(directory, "source-sync-worker.js");
	return existsSync(bundled) ? bundled : join(directory, "source-sync-worker.ts");
}

function sourceTokenRef(context: SourceProviderSyncContext): string | undefined {
	const tokenRef = (context.source.providerSettings as { readonly tokenRef?: unknown } | undefined)?.tokenRef;
	return typeof tokenRef === "string" && tokenRef.trim().length > 0 ? tokenRef.trim() : undefined;
}

function isSyncResult(value: unknown): value is SourceProviderSyncResult {
	if (typeof value !== "object" || value === null) return false;
	const result = value as Partial<SourceProviderSyncResult>;
	return (
		Number.isFinite(result.indexed) &&
		Number.isFinite(result.scanned) &&
		Number.isFinite(result.total) &&
		Array.isArray(result.failures)
	);
}

function relayLog(entry: LogEntry): void {
	if (typeof entry !== "object" || entry === null || typeof entry.message !== "string") return;
	const category = (typeof entry.category === "string" ? entry.category : "system") as LogCategory;
	const data = entry.error === undefined ? entry.data : { ...entry.data, error: entry.error };
	if (entry.level === "error" || entry.level === "warn" || entry.level === "info" || entry.level === "debug")
		logger.log(entry.level, category, entry.message, data);
}

/**
 * Runs one provider sync in a dedicated worker thread. The worker never opens
 * the workspace database or the secret store: owner operations and the
 * source's configured token ref are relayed through this thread to the daemon's
 * DB owner and secret store. A worker crash or exit fails the sync; there is no
 * in-process fallback.
 */
export function runSourceSyncInWorker(
	context: SourceProviderSyncContext,
	options: SourceSyncWorkerOptions = {},
): Promise<SourceProviderSyncResult> {
	return new Promise<SourceProviderSyncResult>((resolve, reject) => {
		const worker = new Worker(options.workerPath ?? sourceSyncWorkerPath());
		const ownerJobs = new Map<string, DbOwnerJobHandle<unknown> | null>();
		const tokenRef = sourceTokenRef(context);
		let settled = false;
		let cancelRequested = false;
		let cancelTimer: ReturnType<typeof setTimeout> | null = null;
		const send = (message: SourceSyncHostMessage): void => {
			if (settled) return;
			try {
				postSourceSyncFrame(worker, message);
			} catch (error) {
				finish(new Error(`source sync worker transport failed: ${boundedErrorMessage(error)}`));
			}
		};
		const finish = (error: Error | null, result?: SourceProviderSyncResult): void => {
			if (settled) return;
			settled = true;
			clearTimeout(readyTimer);
			clearInterval(cancelPoll);
			if (cancelTimer !== null) clearTimeout(cancelTimer);
			liveWorkers.delete(abort);
			for (const handle of ownerJobs.values()) handle?.cancel();
			ownerJobs.clear();
			const termination = Promise.resolve()
				.then(() => worker.terminate())
				.then(
					() => undefined,
					() => undefined,
				);
			terminations.add(termination);
			void termination.then(() => terminations.delete(termination));
			if (error !== null) reject(error);
			else if (result !== undefined) resolve(result);
		};
		const abort = (error: Error): void => finish(error);
		liveWorkers.add(abort);
		const readyTimer = setTimeout(
			() => finish(new Error("source sync worker did not become ready")),
			options.readyTimeoutMs ?? SOURCE_SYNC_WORKER_READY_TIMEOUT_MS,
		);
		const requestCancel = (): void => {
			if (cancelRequested || settled) return;
			cancelRequested = true;
			for (const handle of ownerJobs.values()) handle?.cancel();
			send({ type: "cancel" });
			cancelTimer = setTimeout(
				() => finish(new Error("source sync worker cancelled")),
				options.cancelGraceMs ?? SOURCE_SYNC_WORKER_CANCEL_GRACE_MS,
			);
			cancelTimer.unref?.();
		};
		const cancelPoll = setInterval(() => {
			if (!context.shouldContinue()) requestCancel();
		}, options.cancelPollMs ?? SOURCE_SYNC_WORKER_CANCEL_POLL_MS);
		cancelPoll.unref?.();

		const relayOwnerJob = async (message: Extract<SourceSyncWorkerMessage, { type: "owner_submit" }>) => {
			try {
				if (cancelRequested) throw new DbOwnerCancelledError(message.id);
				if (!SOURCE_SYNC_WORKER_OWNER_REQUESTS.has(message.request.kind))
					throw new Error(`Source sync worker may not submit owner request: ${message.request.kind}`);
				if (ownerJobs.size >= SOURCE_SYNC_WORKER_MAX_OWNER_JOBS)
					throw new DbOwnerAdmissionError("DB_OWNER_QUEUE_FULL", "Source sync worker owner relay is full");
				ownerJobs.set(message.id, null);
				const owner = await getDbOwner();
				if (settled || cancelRequested) throw new DbOwnerCancelledError(message.id);
				const handle = owner.submit<unknown>(message.request, message.options);
				ownerJobs.set(message.id, handle);
				const result = await owner.awaitResult(handle);
				send({ type: "owner_result", id: message.id, result });
			} catch (error) {
				send({ type: "owner_error", id: message.id, error: serializeOwnerError(error) });
			} finally {
				ownerJobs.delete(message.id);
			}
		};
		const relaySecret = async (message: Extract<SourceSyncWorkerMessage, { type: "secret" }>) => {
			try {
				if (tokenRef === undefined || message.name !== tokenRef)
					throw new Error("Source sync worker may only resolve the source's configured token ref");
				send({ type: "secret_result", id: message.id, value: await context.getSecret(message.name) });
			} catch (error) {
				send({ type: "secret_error", id: message.id, message: boundedErrorMessage(error) });
			}
		};

		worker.on("message", (raw: unknown) => {
			if (settled) return;
			const message = decodeSourceSyncFrame<SourceSyncWorkerMessage>(raw);
			if (message === null) return;
			switch (message.type) {
				case "ready":
					clearTimeout(readyTimer);
					options.onReady?.(message.threadId);
					send({
						type: "sync",
						job: { source: context.source, agentsDir: context.agentsDir, agentId: context.agentId },
					});
					return;
				case "progress":
					if (!cancelRequested) context.onProgress?.(message.event);
					return;
				case "owner_submit":
					void relayOwnerJob(message);
					return;
				case "owner_cancel":
					ownerJobs.get(message.id)?.cancel();
					return;
				case "secret":
					void relaySecret(message);
					return;
				case "log":
					relayLog(message.entry);
					return;
				case "result":
					if (isSyncResult(message.result)) finish(null, message.result);
					else finish(new Error("source sync worker returned a malformed result"));
					return;
				case "error":
					finish(new Error(message.message));
					return;
			}
		});
		worker.once("error", (error: Error) => finish(error));
		worker.once("exit", (code: number) => finish(new Error(`source sync worker exited with code ${code}`)));
	});
}

export async function closeSourceSyncWorkers(): Promise<void> {
	for (const abort of [...liveWorkers]) abort(new Error("source sync worker closed"));
	await Promise.all([...terminations]);
}

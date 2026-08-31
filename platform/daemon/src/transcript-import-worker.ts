import { randomUUID } from "node:crypto";
import { TRANSCRIPT_IMPORT_LIMITS } from "./transcript-import-adapter";
import type { ImportJobState, ImportStore } from "./transcript-import-store";
import { controlImport, reconcileImport } from "./transcript-import-store";

export interface TranscriptImportWorkerHandle {
	readonly running: boolean;
	stop(): Promise<void>;
	nudge(): void;
}
export interface TranscriptImportWorkerOptions {
	readonly store: ImportStore;
	readonly agentId: string;
	readonly pressure?: () => boolean;
	readonly yield?: () => Promise<void>;
	readonly onBatch?: (jobId: string) => Promise<void>;
}

/** Durable lifecycle coordinator. All state is owned by ImportStore/DB-owner; this loop keeps no job truth. */
export function startTranscriptImportWorker(options: TranscriptImportWorkerOptions): TranscriptImportWorkerHandle {
	let active = true;
	let wake: (() => void) | undefined;
	const wait = () =>
		new Promise<void>((resolve) => {
			wake = resolve;
		});
	const loop = async () => {
		while (active) {
			if (options.pressure?.()) {
				await wait();
				continue;
			}
			try {
				const jobs = await options.store.run<ReadonlyArray<{ id: string; state: ImportJobState }>>({
					kind: "source_import",
					operation: "list",
					agentId: options.agentId,
					jobId: "*",
					payload: { limit: 1 },
				});
				const job = jobs[0];
				if (job && (job.state === "queued" || job.state === "running" || job.state === "inventorying"))
					await options.onBatch?.(job.id);
			} catch {
				/* durable reconciliation on the next wake; infrastructure failure is not import rejection */
			}
			await options.yield?.();
			if (active) await wait();
		}
	};
	void loop();
	return {
		get running() {
			return active;
		},
		stop: async () => {
			active = false;
			wake?.();
		},
		nudge: () => wake?.(),
	};
}

export function importWorkerBatchSize(): number {
	return TRANSCRIPT_IMPORT_LIMITS.maxRecordsPerBatch;
}
export function newImportLeaseToken(): string {
	return randomUUID();
}
export { controlImport, reconcileImport };

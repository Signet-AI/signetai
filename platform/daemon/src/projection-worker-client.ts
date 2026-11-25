import { Worker } from "node:worker_threads";
import type { buildExportTranscriptRecord } from "@signet/core";
import type { ProjectionInputRow, ProjectionResult } from "./umap-projection";
import { resolveEmbeddedWorkerPath } from "./native-runtime-assets";
const active = new Map<Worker, { cancel: () => void; closed: Promise<void> }>();
let stopping = false;
export async function stopProjectionWorkers(): Promise<void> {
	stopping = true;
	const jobs = [...active.values()];
	for (const job of jobs) job.cancel();
	await Promise.all(jobs.map((job) => job.closed));
}
export function runProjectionWorker(
	rows: readonly ProjectionInputRow[],
	dimensions: 2 | 3,
	signal?: AbortSignal,
	deadlineMs = 30000,
): Promise<ProjectionResult> {
	if (rows.length > 5000 || Buffer.byteLength(JSON.stringify(rows)) > 16 * 1024 * 1024)
		return Promise.reject(new Error("Projection input admission exceeded"));
	return runContentWorker<ProjectionResult>("projection-worker", { rows, dimensions }, signal, deadlineMs);
}
export function encodeExportRecord(
	record: Record<string, unknown>,
	parts: readonly Uint8Array[],
	signal?: AbortSignal,
): Promise<string> {
	return runContentWorker<string>("export-worker", { format: "authored", record, parts }, signal, 30000);
}
function runContentWorker<Result>(
	kind: "projection-worker" | "export-worker",
	input: unknown,
	signal?: AbortSignal,
	deadlineMs = 30000,
): Promise<Result> {
	signal?.throwIfAborted();
	if (stopping) return Promise.reject(new Error("Content workers are stopping"));
	if (active.size >= 2)
		return Promise.reject(Object.assign(new Error("Content worker capacity reached"), { code: "DB_OWNER_QUEUE_FULL" }));
	const worker = new Worker(
		resolveEmbeddedWorkerPath(kind) ??
			new URL(`./${kind}.${import.meta.url.endsWith(".ts") ? "ts" : "js"}`, import.meta.url),
	);
	let close: () => void = () => {};
	const closed = new Promise<void>((resolve) => {
		close = resolve;
	});
	return new Promise<Result>((resolve, reject) => {
		let settled = false;
		const finish = (result: Result | undefined, error?: unknown) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			signal?.removeEventListener("abort", abort);
			worker.terminate();
			closed.then(() => {
				if (error) reject(error);
				else if (result) resolve(result);
				else reject(new Error("Content worker closed without a result"));
			});
		};
		const abort = () => finish(undefined, signal?.reason ?? new DOMException("Content task aborted", "AbortError"));
		const timer = setTimeout(
			() =>
				finish(
					undefined,
					Object.assign(new Error("Content worker exceeded its deadline"), { code: "DB_OWNER_DEADLINE" }),
				),
			Math.max(1, Math.min(deadlineMs, 30000)),
		);
		worker.once("exit", () => {
			active.delete(worker);
			close();
			if (!settled) finish(undefined, new Error("Content worker exited without a result"));
		});
		worker.once("message", (result: Result) => finish(result));
		worker.once("error", (error: Error) => finish(undefined, error));
		active.set(worker, { cancel: () => finish(undefined, new DOMException("Daemon stopping", "AbortError")), closed });
		signal?.addEventListener("abort", abort, { once: true });
		if (signal?.aborted) abort();
		else worker.postMessage(input);
	});
}

export type ExportWorkerInput =
	| { format: "authored"; record: Record<string, unknown>; parts: Uint8Array[] }
	| {
			format: "transcript";
			record: Omit<Parameters<typeof buildExportTranscriptRecord>[0], "content"> & { speaker_user_id: string | null };
			parts: Uint8Array[];
			messagesOnly: boolean;
	  };
export function encodeTranscriptExport(
	record: Extract<ExportWorkerInput, { format: "transcript" }>["record"],
	parts: readonly Uint8Array[],
	messagesOnly: boolean,
	signal?: AbortSignal,
): Promise<string> {
	return runContentWorker<string>(
		"export-worker",
		{ format: "transcript", record, parts, messagesOnly },
		signal,
		30000,
	);
}

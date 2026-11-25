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
	signal?.throwIfAborted();
	if (stopping) return Promise.reject(new Error("Projection workers are stopping"));
	if (active.size >= 2)
		return Promise.reject(
			Object.assign(new Error("Projection worker capacity reached"), { code: "DB_OWNER_QUEUE_FULL" }),
		);
	if (rows.length > 5000 || Buffer.byteLength(JSON.stringify(rows)) > 16 * 1024 * 1024)
		return Promise.reject(new Error("Projection input admission exceeded"));
	const worker = new Worker(
		resolveEmbeddedWorkerPath("projection-worker") ?? new URL("./projection-worker.ts", import.meta.url).href,
	);
	let close: () => void = () => {};
	const closed = new Promise<void>((resolve) => {
		close = resolve;
	});
	return new Promise<ProjectionResult>((resolve, reject) => {
		let settled = false;
		const finish = (result: ProjectionResult | undefined, error?: unknown) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			signal?.removeEventListener("abort", abort);
			worker.terminate();
			closed.then(() => {
				if (error) reject(error);
				else if (result) resolve(result);
				else reject(new Error("Projection worker closed without a result"));
			});
		};
		const abort = () => finish(undefined, signal?.reason ?? new DOMException("Projection aborted", "AbortError"));
		const timer = setTimeout(
			() =>
				finish(undefined, Object.assign(new Error("Projection exceeded its deadline"), { code: "DB_OWNER_DEADLINE" })),
			Math.max(1, Math.min(deadlineMs, 30000)),
		);
		worker.addEventListener(
			"close",
			() => {
				active.delete(worker);
				close();
				if (!settled) finish(undefined, new Error("Projection worker exited without a result"));
			},
			{ once: true },
		);
		worker.onmessage = (event: MessageEvent<ProjectionResult>) => finish(event.data);
		worker.onerror = (event) => {
			event.preventDefault();
			finish(undefined, new Error(event.message));
		};
		active.set(worker, { cancel: () => finish(undefined, new DOMException("Daemon stopping", "AbortError")), closed });
		signal?.addEventListener("abort", abort, { once: true });
		if (signal?.aborted) abort();
		else worker.postMessage({ rows, dimensions });
	});
}

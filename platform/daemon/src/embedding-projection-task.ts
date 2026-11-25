import { Worker } from "node:worker_threads";
import { z } from "zod";
import { resolveEmbeddedWorkerPath } from "./native-runtime-assets";
import { computeProjectionFromRows, type EmbeddingRow, type ProjectionResult } from "./umap-projection";

export const projectionTaskSchema = z.object({
	rows: z
		.array(
			z.object({
				id: z.string(),
				content: z.string(),
				who: z.string().nullable(),
				importance: z.number().nullable(),
				type: z.string().nullable(),
				tags: z.string().nullable(),
				pinned: z.number().nullable(),
				source_type: z.string().nullable(),
				source_id: z.string().nullable(),
				created_at: z.string(),
				vector: z.instanceof(Uint8Array),
				dimensions: z.number().nullable(),
			}),
		)
		.max(5000),
	dimensions: z.union([z.literal(2), z.literal(3)]),
});
const projectionResultSchema = z.object({
	nodes: z.array(
		z.object({
			id: z.string(),
			x: z.number(),
			y: z.number(),
			z: z.number().optional(),
			content: z.string(),
			who: z.string(),
			importance: z.number(),
			type: z.string(),
			tags: z.array(z.string()),
			pinned: z.boolean(),
			sourceType: z.string(),
			sourceId: z.string(),
			createdAt: z.string(),
		}),
	),
	edges: z.array(z.tuple([z.number().int().nonnegative(), z.number().int().nonnegative()])),
});
let active = 0;

export async function withProjectionAdmission<T>(work: () => Promise<T>): Promise<T> {
	if (active >= 2) throw new Error("projection_admission_limit");
	active += 1;
	try {
		return await work();
	} finally {
		active -= 1;
	}
}

export async function computeProjectionAsync(
	rows: readonly EmbeddingRow[],
	dimensions: 2 | 3,
	signal?: AbortSignal,
): Promise<ProjectionResult> {
	signal?.throwIfAborted();
	if (rows.length > 5000) throw new Error("projection_admission_limit");
	if (rows.length <= 2) return computeProjectionFromRows(rows, dimensions);
	let worker: Worker | undefined;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let abort: (() => void) | undefined;
	try {
		worker = new Worker(
			resolveEmbeddedWorkerPath("embedding-projection-worker") ??
				new URL(
					import.meta.url.endsWith(".ts") ? "./embedding-projection-worker.ts" : "./embedding-projection-worker.js",
					import.meta.url,
				),
			{
				workerData: { rows, dimensions },
			},
		);
		return await new Promise<ProjectionResult>((resolve, reject) => {
			abort = () => reject(signal?.reason ?? new Error("projection_cancelled"));
			signal?.addEventListener("abort", abort, { once: true });
			if (signal?.aborted) abort();
			timer = setTimeout(() => reject(new Error("projection_compute_deadline")), 15_000);
			timer.unref();
			worker?.once("message", (message: unknown) => {
				const parsed = projectionResultSchema.safeParse(message);
				if (parsed.success) resolve(parsed.data);
				else reject(new Error("invalid_projection_result"));
			});
			worker?.once("error", reject);
			worker?.once("exit", () => reject(new Error("projection_worker_exited")));
		});
	} finally {
		clearTimeout(timer);
		if (abort) signal?.removeEventListener("abort", abort);
		await worker?.terminate();
	}
}

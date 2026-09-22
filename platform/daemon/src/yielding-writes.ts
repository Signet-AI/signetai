import type { DbAccessor, ReadDb, WriteDb } from "./db-accessor";
import { logger } from "./logger";
import { awaitPressureClear, isSystemPressureHigh } from "./system-pressure";
const yieldToEventLoop = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

export interface DrainOptions {
	readonly label: string;
	readonly maxPerTx?: number;
	readonly maxRows?: number;
	readonly maxBytes?: number;
	readonly estimateBytes?: (item: unknown) => number;
	readonly yieldEvery?: number;
	readonly maxTotal?: number;
	readonly skipPressure?: boolean;
	readonly checkpoint?: (state: BatchCheckpoint) => void;
}

export interface BatchCheckpoint {
	readonly processed: number;
	readonly batches: number;
	readonly rows: number;
	readonly bytes: number;
	readonly elapsedMs: number;
}

export interface DrainResult {
	readonly processed: number;
	readonly batches: number;
	readonly paused: number;
	readonly stopped: "exhausted" | "capped";
}

export interface RunWriteOptions {
	readonly label: string;
	readonly maxPerTx?: number;
	readonly maxRows?: number;
	readonly maxBytes?: number;
	readonly estimateBytes?: (item: unknown) => number;
	readonly maxTxDurationMs?: number;
	readonly yieldEvery?: number;
	readonly maxTotal?: number;
	readonly skipPressure?: boolean;
	readonly checkpoint?: (state: BatchCheckpoint) => void;
}

export interface RunWriteResult<Result> {
	readonly items: readonly Result[];
	readonly processed: number;
	readonly batches: number;
	readonly paused: number;
	readonly stopped: "exhausted" | "capped" | "failed";
	readonly error?: string;
}

async function writeBatch<Result>(
	accessor: DbAccessor,
	processBatch: (db: WriteDb) => Result,
	label: string,
	estimatedWorkUnits: number,
): Promise<Result> {
	if (accessor.withWriteTxAsync) {
		return accessor.withWriteTxAsync(processBatch, {
			siteToken: "yielding-writes.ts:62",
			operation: `db.batch.${label}`,
			estimatedWorkUnits,
		});
	}
	// @ts-expect-error LEGACY_SYNC_DB_ACCESS: withWriteTx migration site
	return accessor.withWriteTx(processBatch, "yielding-writes.ts:69");
}
export async function drainWriteBatches<Item>(
	accessor: DbAccessor,
	fetchBatch: (db: ReadDb, limit: number) => readonly Item[] | null,
	processBatch: (db: WriteDb, items: readonly Item[]) => void,
	options: DrainOptions,
): Promise<DrainResult> {
	const maxPerTx = options.maxPerTx ?? 50;
	const maxRows = options.maxRows ?? maxPerTx;
	const maxBytes = options.maxBytes ?? Number.POSITIVE_INFINITY;
	const yieldEvery = options.yieldEvery ?? 1;
	const maxTotal = options.maxTotal ?? 10_000;

	let processed = 0;
	let batches = 0;
	let paused = 0;
	const startedAt = performance.now();

	while (processed < maxTotal) {
		const remaining = maxTotal - processed;
		const limit = Math.min(maxPerTx, maxRows, remaining);
		// @ts-expect-error LEGACY_SYNC_DB_ACCESS: withReadDb migration site
		const batch = accessor.withReadDb(
			(db: import("./db-accessor").ReadDb) => fetchBatch(db, limit),
			"yielding-writes.ts:92",
		);
		if (!batch || batch.length === 0) {
			return { processed, batches, paused, stopped: "exhausted" };
		}
		const checkpointBatch: Item[] = [];
		let checkpointBytes = 0;
		for (const item of batch) {
			const estimatedBytes = options.estimateBytes?.(item) ?? 0;
			const bytes = Number.isFinite(estimatedBytes) ? Math.max(0, estimatedBytes) : 0;
			if (checkpointBatch.length > 0 && checkpointBytes + bytes > maxBytes) break;
			checkpointBatch.push(item);
			checkpointBytes += bytes;
		}
		if (checkpointBatch.length === 0) checkpointBatch.push(batch[0] as Item);
		if (!options.skipPressure && isSystemPressureHigh()) {
			paused++;
			await awaitPressureClear();
		}
		await writeBatch(accessor, (db) => processBatch(db, checkpointBatch), options.label, checkpointBatch.length);

		processed += checkpointBatch.length;
		batches++;
		options.checkpoint?.({
			processed,
			batches,
			rows: checkpointBatch.length,
			bytes: checkpointBytes,
			elapsedMs: performance.now() - startedAt,
		});
		if (batches % yieldEvery === 0) {
			await yieldToEventLoop();
		}
	}

	logger.debug("yielding-writes", `${options.label}: hit maxTotal cap (${maxTotal})`, { processed, batches });
	return { processed, batches, paused, stopped: "capped" };
}
export async function runWriteBatches<Item, Result>(
	accessor: DbAccessor,
	items: readonly Item[],
	processItem: (db: WriteDb, item: Item) => Result,
	options: RunWriteOptions,
): Promise<RunWriteResult<Result>> {
	const maxPerTx =
		typeof options.maxPerTx === "number" && Number.isFinite(options.maxPerTx)
			? Math.max(1, Math.floor(options.maxPerTx))
			: 50;
	const maxRows =
		typeof options.maxRows === "number" && Number.isFinite(options.maxRows)
			? Math.max(1, Math.floor(options.maxRows))
			: maxPerTx;
	const maxBytes =
		typeof options.maxBytes === "number" && Number.isFinite(options.maxBytes)
			? Math.max(1, options.maxBytes)
			: Number.POSITIVE_INFINITY;
	const maxTxDurationMs =
		typeof options.maxTxDurationMs === "number" && Number.isFinite(options.maxTxDurationMs)
			? Math.max(1, options.maxTxDurationMs)
			: Number.POSITIVE_INFINITY;
	const yieldEvery =
		typeof options.yieldEvery === "number" && Number.isFinite(options.yieldEvery)
			? Math.max(1, Math.floor(options.yieldEvery))
			: 1;
	const maxTotal = Math.min(
		items.length,
		typeof options.maxTotal === "number" && Number.isFinite(options.maxTotal)
			? Math.max(0, Math.floor(options.maxTotal))
			: items.length,
	);

	const results: Result[] = [];
	let processed = 0;
	let batches = 0;
	let paused = 0;
	const startedAt = performance.now();

	while (processed < maxTotal) {
		if (!options.skipPressure && isSystemPressureHigh()) {
			paused++;
			await awaitPressureClear();
		}

		let batch: readonly Result[];
		let batchBytes = 0;
		try {
			const committed = await writeBatch(
				accessor,
				(db) => {
					const startedAt = performance.now();
					const batchResults: Result[] = [];
					let bytes = 0;
					for (const item of items.slice(processed, maxTotal)) {
						const estimatedBytes = options.estimateBytes?.(item) ?? 0;
						const itemBytes = Number.isFinite(estimatedBytes) ? Math.max(0, estimatedBytes) : 0;
						if (batchResults.length > 0 && bytes + itemBytes > maxBytes) break;
						batchResults.push(processItem(db, item));
						bytes += itemBytes;
						if (batchResults.length >= Math.min(maxPerTx, maxRows)) break;
						if (performance.now() - startedAt >= maxTxDurationMs) break;
					}
					return { results: batchResults, bytes };
				},
				options.label,
				Math.min(maxPerTx, maxRows),
			);
			batch = committed.results;
			batchBytes = committed.bytes;
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			logger.warn("yielding-writes", `${options.label}: write batch failed after ${processed} committed items`, {
				processed,
				batches,
				error: message,
			});
			return { items: results, processed, batches, paused, stopped: "failed", error: message };
		}

		if (batch.length === 0) throw new Error(`${options.label}: write batch made no progress`);
		results.push(...batch);
		processed += batch.length;
		batches++;
		options.checkpoint?.({
			processed,
			batches,
			rows: batch.length,
			bytes: batchBytes,
			elapsedMs: performance.now() - startedAt,
		});

		if (batches % yieldEvery === 0) await yieldToEventLoop();
	}

	if (processed < items.length) {
		logger.debug("yielding-writes", `${options.label}: hit maxTotal cap (${maxTotal})`, { processed, batches });
	}

	return {
		items: results,
		processed,
		batches,
		paused,
		stopped: processed < items.length ? "capped" : "exhausted",
	};
}

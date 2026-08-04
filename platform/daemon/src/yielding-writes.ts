/**
 * Bounded write-batch drain with cooperative event-loop yielding.
 *
 * **Why this exists (#1059).** SQLite's synchronous API (`bun:sqlite`) blocks
 * the JavaScript event loop for the duration of each call. A background loop
 * that runs thousands of writes inside one {@link DbAccessor.withWriteTx}
 * freezes the entire thread — no HTTP handler (including `/health`) can
 * execute — until the watchdog SIGKILLs the process. The death spiral:
 * background work blocks → /health starves → kill → crash recovery resets
 * in-flight jobs → restart → same backlog → repeat.
 *
 * **The fix.** Background write loops use this primitive instead of raw
 * `withWriteTx`. Each batch runs in its own short transaction (bounded by
 * `maxPerTx`), and between batches the primitive yields a macrotask so the
 * event loop can service HTTP. It also checks {@link isSystemPressureHigh}
 * and pauses when the event loop is degraded — active backpressure, not just
 * passive yielding.
 *
 * Each batch's transaction is short enough (tens of milliseconds for typical
 * batch sizes) that the event loop is never blocked long enough to trip the
 * health watchdog. The guarantee is structural: any loop using this primitive
 * cannot monopolize the thread, regardless of total work volume.
 */

import type { DbAccessor, ReadDb, WriteDb } from "./db-accessor";
import { logger } from "./logger";
import { awaitPressureClear, isSystemPressureHigh } from "./system-pressure";

/** Yield a macrotask so pending HTTP handlers (and the event-loop monitor) can run. */
const yieldToEventLoop = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

export interface DrainOptions {
	/** Caller-facing label for pressure-pause logging. */
	readonly label: string;
	/** Maximum items processed per write transaction. Default 50. */
	readonly maxPerTx?: number;
	/**
	 * Yield after every N batches even when pressure is normal, so long
	 * drains don't starve lower-priority work. Default 1 (yield every batch).
	 */
	readonly yieldEvery?: number;
	/** Hard cap on total items processed in one drain call. Default 10_000. */
	readonly maxTotal?: number;
	/** Skip pressure checks entirely (for startup recovery where no workers
	 *  or HTTP handlers are running to compete with). Default false. */
	readonly skipPressure?: boolean;
}

export interface DrainResult {
	readonly processed: number;
	readonly batches: number;
	readonly paused: number;
	readonly stopped: "exhausted" | "capped";
}

/**
 * Drain write work in bounded, yielding transactions.
 *
 * Each iteration:
 * 1. Fetch the next batch (read-only, up to `maxPerTx` items).
 * 2. If empty, the drain is exhausted — return.
 * 3. If pressure is high, wait for it to clear (bounded by timeout).
 * 4. Process the batch in one short `withWriteTx`.
 * 5. Yield a macrotask so HTTP handlers run.
 *
 * The fetch function receives a read-only DB handle and a limit; it returns
 * the items that need processing, or `null`/`[]` when there is no more work.
 * The process function receives a write DB handle and the batch; it does the
 * writes in one transaction.
 */
export async function drainWriteBatches<Item>(
	accessor: DbAccessor,
	fetchBatch: (db: ReadDb, limit: number) => readonly Item[] | null,
	processBatch: (db: WriteDb, items: readonly Item[]) => void,
	options: DrainOptions,
): Promise<DrainResult> {
	const maxPerTx = options.maxPerTx ?? 50;
	const yieldEvery = options.yieldEvery ?? 1;
	const maxTotal = options.maxTotal ?? 10_000;

	let processed = 0;
	let batches = 0;
	let paused = 0;

	while (processed < maxTotal) {
		// 1. Fetch next batch (read-only, non-blocking for WAL readers).
		const remaining = maxTotal - processed;
		const limit = Math.min(maxPerTx, remaining);
		const batch = accessor.withReadDb((db) => fetchBatch(db, limit));
		if (!batch || batch.length === 0) {
			return { processed, batches, paused, stopped: "exhausted" };
		}

		// 2. Check pressure — pause background work if the event loop is degraded.
		if (!options.skipPressure && isSystemPressureHigh()) {
			paused++;
			await awaitPressureClear();
		}

		// 3. Process in one short transaction.
		accessor.withWriteTx((db) => processBatch(db, batch));

		processed += batch.length;
		batches++;

		// 4. Yield between batches so HTTP handlers and the event-loop monitor run.
		if (batches % yieldEvery === 0) {
			await yieldToEventLoop();
		}
	}

	return { processed, batches, paused, stopped: "capped" };
}

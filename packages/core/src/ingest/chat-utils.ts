/**
 * Shared utilities for conversation-based parsers (Slack, Discord).
 */

/** Time gap threshold for splitting unthreaded messages (30 minutes) */
export const TIME_GAP_MS = 30 * 60 * 1000;

/**
 * Batch a sorted array of items into groups separated by time gaps.
 *
 * Items within `TIME_GAP_MS` of each other end up in the same batch.
 * The caller provides a `getTimestamp` function that returns a
 * millisecond-epoch number for each item.
 *
 * @param items - Pre-sorted array of items (oldest first)
 * @param getTimestamp - Extract ms-epoch timestamp from an item
 * @returns Array of batches (each batch is a non-empty array of items)
 */
export function batchByTimeGap<T>(
	items: readonly T[],
	getTimestamp: (item: T) => number,
): T[][] {
	if (items.length === 0) return [];

	const batches: T[][] = [];
	let currentBatch: T[] = [];

	for (const item of items) {
		if (currentBatch.length > 0) {
			const lastTs = getTimestamp(currentBatch[currentBatch.length - 1]);
			const currentTs = getTimestamp(item);

			if (currentTs - lastTs > TIME_GAP_MS) {
				batches.push(currentBatch);
				currentBatch = [];
			}
		}
		currentBatch.push(item);
	}

	if (currentBatch.length > 0) {
		batches.push(currentBatch);
	}

	return batches;
}

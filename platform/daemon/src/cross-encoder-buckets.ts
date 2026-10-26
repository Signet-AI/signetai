const CUDA_RUN_OVERHEAD_MS = 5.3;
const CUDA_MS_PER_TOKEN = 0.00249;
const CUDA_MS_PER_TOKEN_SQUARED = 0.0000128;

export function pairLengths(batch: {
	readonly attentionMask: readonly number[];
	readonly batchSize: number;
	readonly sequenceLength: number;
}): number[] {
	const lengths = new Array<number>(batch.batchSize).fill(0);
	for (let row = 0; row < batch.batchSize; row++) {
		let length = 0;
		const offset = row * batch.sequenceLength;
		for (let column = 0; column < batch.sequenceLength; column++) length += batch.attentionMask[offset + column] ?? 0;
		lengths[row] = length;
	}
	return lengths;
}

export function planLengthBuckets(lengths: readonly number[]): number[][] {
	const order = lengths.map((length, index) => ({ length, index })).sort((a, b) => a.length - b.length);
	const count = order.length;
	const best = new Array<number>(count + 1).fill(Number.POSITIVE_INFINITY);
	const cut = new Array<number>(count + 1).fill(0);
	best[0] = 0;
	for (let end = 1; end <= count; end++) {
		const padded = order[end - 1]?.length ?? 0;
		const perDocument = CUDA_MS_PER_TOKEN * padded + CUDA_MS_PER_TOKEN_SQUARED * padded * padded;
		for (let start = 0; start < end; start++) {
			const cost = (best[start] ?? 0) + CUDA_RUN_OVERHEAD_MS + (end - start) * perDocument;
			if (cost < (best[end] ?? Number.POSITIVE_INFINITY)) {
				best[end] = cost;
				cut[end] = start;
			}
		}
	}
	const groups: number[][] = [];
	for (let end = count; end > 0; end = cut[end] ?? 0) {
		groups.unshift(order.slice(cut[end] ?? 0, end).map((entry) => entry.index));
	}
	return groups;
}

export class RerankDeadlineError extends Error {}

export async function scoreInGroups(
	groups: readonly (readonly number[])[],
	documentCount: number,
	scoreGroup: (group: readonly number[]) => Promise<readonly number[]>,
	deadlineAt?: number,
	now: () => number = Date.now,
): Promise<number[]> {
	const scores = new Array<number>(documentCount).fill(Number.NaN);
	for (const group of groups) {
		if (deadlineAt !== undefined && now() >= deadlineAt) {
			throw new RerankDeadlineError("cross-encoder deadline reached; abandoned remaining documents");
		}
		const groupScores = await scoreGroup(group);
		group.forEach((index, position) => {
			scores[index] = groupScores[position] ?? Number.NaN;
		});
	}
	return scores;
}

export interface RerankCostProfile {
	readonly runOverheadMs: number;
	readonly msPerToken: number;
	readonly msPerTokenSquared: number;
	readonly maxGroupTokens: number;
}

export const CUDA_MAX_GROUP_TOKENS = 16_384;

export const CUDA_COST_PROFILE: RerankCostProfile = {
	runOverheadMs: 5.3,
	msPerToken: 0.00249,
	msPerTokenSquared: 0.0000128,
	maxGroupTokens: CUDA_MAX_GROUP_TOKENS,
};

// Fitted to mxbai-rerank-xsmall-v1 (fp32) on an Apple M6 through ONNX Runtime's
// WebGPU provider, batches of 1-20 by 16-512 tokens. Metal runs get slower per
// document as they grow, so the cap keeps one run near a quarter second and the
// deadline check between runs responsive.
export const METAL_MAX_GROUP_TOKENS = 2_048;

export const METAL_COST_PROFILE: RerankCostProfile = {
	runOverheadMs: 7.8,
	msPerToken: 0.0261,
	msPerTokenSquared: 0.000168,
	maxGroupTokens: METAL_MAX_GROUP_TOKENS,
};

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

export function planLengthBuckets(
	lengths: readonly number[],
	profile: RerankCostProfile = CUDA_COST_PROFILE,
): number[][] {
	const order = lengths.map((length, index) => ({ length, index })).sort((a, b) => a.length - b.length);
	const count = order.length;
	const best = new Array<number>(count + 1).fill(Number.POSITIVE_INFINITY);
	const cut = new Array<number>(count + 1).fill(0);
	best[0] = 0;
	for (let end = 1; end <= count; end++) {
		const padded = order[end - 1]?.length ?? 0;
		const perDocument = profile.msPerToken * padded + profile.msPerTokenSquared * padded * padded;
		for (let start = 0; start < end; start++) {
			if (end - start > 1 && (end - start) * padded > profile.maxGroupTokens) continue;
			const cost = (best[start] ?? 0) + profile.runOverheadMs + (end - start) * perDocument;
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

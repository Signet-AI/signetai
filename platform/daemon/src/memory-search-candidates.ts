export const HINT_ONLY_SCORE_CAP = 0.75;
export const TEMPORAL_TOPIC_SCORE_CAP = 0.85;

export interface ScoredRecallCandidate {
	id: string;
	score: number;
	source: string;
}

interface RecallScoreChannels {
	readonly bm25: ReadonlyMap<string, number>;
	readonly hints: ReadonlyMap<string, number>;
	readonly semantic: ReadonlyMap<string, number>;
	readonly structured: ReadonlyMap<string, number>;
	readonly temporal: ReadonlyMap<string, number>;
	readonly temporalCandidates: ReadonlySet<string>;
}

interface RecallScoringOptions {
	readonly alpha: number;
	readonly minScore: number;
}

export function rankRecallCandidates(
	channels: RecallScoreChannels,
	options: RecallScoringOptions,
): ScoredRecallCandidate[] {
	const candidateIds = new Set([
		...channels.bm25.keys(),
		...channels.hints.keys(),
		...channels.semantic.keys(),
		...channels.structured.keys(),
		...channels.temporal.keys(),
	]);
	const ranked: ScoredRecallCandidate[] = [];

	for (const id of candidateIds) {
		const bm25 = channels.bm25.get(id) ?? 0;
		const hint = channels.hints.get(id) ?? 0;
		const semantic = channels.semantic.get(id) ?? 0;
		const structured = channels.structured.get(id) ?? 0;
		const temporalCandidate = channels.temporal.get(id) ?? 0;
		const hasTopicEvidence = bm25 > 0 || hint > 0 || semantic > 0 || structured > 0;
		const temporalScore = channels.temporalCandidates.has(id) && hasTopicEvidence ? TEMPORAL_TOPIC_SCORE_CAP : 0;
		let score: number;
		let source: string;

		if (bm25 > 0 && semantic > 0) {
			score = options.alpha * semantic + (1 - options.alpha) * bm25;
			source = "hybrid";
		} else if (semantic > 0) {
			score = semantic;
			source = "vector";
		} else if (bm25 > 0) {
			score = bm25;
			source = "keyword";
		} else if (temporalScore > 0) {
			score = temporalScore;
			source = "temporal";
		} else if (temporalCandidate > 0) {
			score = temporalCandidate;
			source = "temporal_candidate";
		} else {
			score = structured;
			source = "structured";
		}

		if (hint > 0 && hint >= score) {
			const hasDirectEvidence = bm25 > 0 || semantic > 0 || structured > 0;
			score = hasDirectEvidence ? hint : Math.min(hint, HINT_ONLY_SCORE_CAP);
			source = bm25 > 0 || semantic > 0 ? "hybrid" : structured > 0 ? "sec" : "hint";
		}
		if (structured > 0 && structured >= score) {
			score = structured;
			source = bm25 > 0 || semantic > 0 || hint > 0 ? "sec" : "structured";
		}
		if (temporalScore > 0 && temporalScore >= score) {
			score = temporalScore;
			source = bm25 > 0 || semantic > 0 || hint > 0 || structured > 0 ? "temporal_hybrid" : "temporal";
		}

		if (score >= options.minScore) ranked.push({ id, score, source });
	}

	ranked.sort((left, right) => right.score - left.score);
	return ranked;
}

export function mergeRecallCandidates(
	preferred: readonly ScoredRecallCandidate[],
	additional: readonly ScoredRecallCandidate[],
): ScoredRecallCandidate[] {
	const byId = new Map<string, ScoredRecallCandidate>();
	for (const candidate of preferred) mergeRecallCandidate(byId, candidate);
	for (const candidate of additional) mergeRecallCandidate(byId, candidate);
	return [...byId.values()];
}

export function selectTraversalRecallCandidates(
	flatCandidates: readonly ScoredRecallCandidate[],
	traversalCandidates: readonly ScoredRecallCandidate[],
	limit: number,
	configuredTopK: number,
): ScoredRecallCandidate[] {
	const candidateBudget = Math.max(limit, Math.min(configuredTopK, limit * 4));
	const flatIds = new Set(flatCandidates.map((candidate) => candidate.id));
	const minFlat = Math.ceil(candidateBudget * 0.4);
	const rankedTraversal = [...traversalCandidates].sort((left, right) => right.score - left.score);
	const fused = mergeRecallCandidates(flatCandidates, rankedTraversal).sort((left, right) => right.score - left.score);
	const selected: ScoredRecallCandidate[] = [];
	let flatCount = 0;

	for (const candidate of fused) {
		if (selected.length >= candidateBudget) break;
		const isFlat = flatIds.has(candidate.id);
		const remaining = candidateBudget - selected.length;
		const neededFlat = Math.max(0, Math.min(minFlat, flatCandidates.length) - flatCount);
		if (!isFlat && neededFlat >= remaining) continue;
		selected.push(candidate);
		if (isFlat) flatCount++;
	}
	return selected;
}

function mergeRecallCandidate(candidates: Map<string, ScoredRecallCandidate>, candidate: ScoredRecallCandidate): void {
	const existing = candidates.get(candidate.id);
	if (!existing || candidate.score > existing.score) candidates.set(candidate.id, candidate);
}

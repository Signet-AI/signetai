import type { RerankCandidate, RerankConfig, RerankProvider } from "./reranker";

export const RERANK_FUSION_K = 10;

export interface RerankOutcome {
	kind: "cross-encoder" | "embedding" | "llm" | "none";
	model?: string;
	fallback?: string;
}

export function fuseCrossEncoderScores(
	candidates: readonly RerankCandidate[],
	scores: readonly number[],
	k: number = RERANK_FUSION_K,
): RerankCandidate[] {
	if (scores.length !== candidates.length) {
		throw new Error(`Cross-encoder returned ${scores.length} scores for ${candidates.length} candidates`);
	}
	const crossRank = new Map(
		candidates
			.map((candidate, index) => ({ candidate, score: scores[index] ?? Number.NEGATIVE_INFINITY }))
			.sort((a, b) => b.score - a.score)
			.map((entry, index) => [entry.candidate, index + 1] as const),
	);
	const order = candidates
		.map((candidate, index) => ({
			candidate,
			fused: 1 / (k + index + 1) + 1 / (k + (crossRank.get(candidate) ?? candidates.length)),
		}))
		.sort((a, b) => b.fused - a.fused)
		.map((entry) => entry.candidate);
	const ladder = candidates.map((candidate) => candidate.score).sort((a, b) => b - a);
	return order.map((candidate, index) => ({ ...candidate, score: ladder[index] ?? candidate.score }));
}

export function createCrossEncoderReranker(params: {
	readonly model: string;
	readonly score: (query: string, documents: readonly string[]) => Promise<number[]>;
	readonly fallback: RerankProvider;
	readonly outcome: RerankOutcome;
}): RerankProvider {
	return async (query: string, candidates: RerankCandidate[], cfg: RerankConfig): Promise<RerankCandidate[]> => {
		if (candidates.length === 0) return candidates;
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			const deadline = new Promise<never>((_, reject) => {
				timer = setTimeout(
					() => reject(new Error(`cross-encoder exceeded ${Math.floor(cfg.timeoutMs * 0.75)}ms`)),
					Math.floor(cfg.timeoutMs * 0.75),
				);
			});
			const scores = await Promise.race([
				params.score(
					query,
					candidates.map((candidate) => candidate.content),
				),
				deadline,
			]);
			params.outcome.kind = "cross-encoder";
			params.outcome.model = params.model;
			return fuseCrossEncoderScores(candidates, scores);
		} catch (error) {
			params.outcome.kind = "embedding";
			params.outcome.fallback = error instanceof Error ? error.message : String(error);
			return await params.fallback(query, candidates, cfg);
		} finally {
			if (timer !== undefined) clearTimeout(timer);
		}
	};
}

export interface RerankCandidate {
	readonly id: string;
	readonly content: string;
	score: number;
}

export interface RerankConfig {
	readonly topN: number;
	readonly timeoutMs: number;
	readonly model: string;
	readonly throwOnError?: boolean;
}

export type RerankProvider = (
	query: string,
	candidates: RerankCandidate[],
	cfg: RerankConfig,
) => Promise<RerankCandidate[]>;
export const noopReranker: RerankProvider = async (_query, candidates, _cfg) => candidates;
export async function rerank(
	query: string,
	candidates: RerankCandidate[],
	provider: RerankProvider,
	cfg: RerankConfig,
): Promise<RerankCandidate[]> {
	if (candidates.length === 0) return candidates;

	const head = candidates.slice(0, cfg.topN);
	const tail = candidates.slice(cfg.topN);

	let timerId: ReturnType<typeof setTimeout> | undefined;
	try {
		const timer = new Promise<never>((_, reject) => {
			timerId = setTimeout(() => reject(new Error("reranker timeout")), cfg.timeoutMs);
		});

		const reranked = await Promise.race([provider(query, head, cfg), timer]);

		return [...reranked, ...tail];
	} catch (error) {
		if (cfg.throwOnError) throw error;
		return candidates;
	} finally {
		if (timerId !== undefined) clearTimeout(timerId);
	}
}

/**
 * Optional reranker hook for recall results.
 *
 * Provider-agnostic — accepts a RerankProvider function that can
 * wrap any cross-encoder or reranking service. Includes timeout
 * guard and graceful fallback to original ordering.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RerankCandidate {
	readonly id: string;
	readonly content: string;
	score: number;
}

export interface RerankConfig {
	readonly topN: number;
	readonly timeoutMs: number;
	readonly model: string;
}

export type RerankProvider = (
	query: string,
	candidates: RerankCandidate[],
	cfg: RerankConfig,
) => Promise<RerankCandidate[]>;

// ---------------------------------------------------------------------------
// Providers
// ---------------------------------------------------------------------------

/** Pass-through provider — returns candidates unchanged. */
export const noopReranker: RerankProvider = async (
	_query,
	candidates,
	_cfg,
) => candidates;

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

/**
 * Rerank the top-N candidates using the given provider. Candidates
 * beyond topN are appended unchanged. On timeout or error, returns
 * original ordering.
 */
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

		const reranked = await Promise.race([
			provider(query, head, cfg),
			timer,
		]);

		return [...reranked, ...tail];
	} catch {
		// Timeout or provider error: return original ordering
		return candidates;
	} finally {
		if (timerId !== undefined) clearTimeout(timerId);
	}
}

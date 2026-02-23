/**
 * Embedding-based reranker for recall results.
 *
 * Re-scores candidates using full-content cosine similarity against
 * the query embedding. Uses cached embeddings from the database when
 * available, avoiding extra provider calls in most cases.
 *
 * This is fast (no LLM call), deterministic, and catches cases where
 * BM25 candidates weren't vector-compared at all.
 */

import { cosineSimilarity } from "@signet/core";
import type { DbAccessor } from "../db-accessor";
import type { RerankCandidate, RerankConfig, RerankProvider } from "./reranker";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface CachedEmbedding {
	readonly source_id: string;
	readonly vector: Buffer;
}

// ---------------------------------------------------------------------------
// Cosine similarity from raw buffers
// ---------------------------------------------------------------------------

function bufferToF32(buf: Buffer): Float32Array {
	return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create an embedding-based reranker that uses cached vectors from the
 * database. The `queryVector` must be pre-computed by the caller (the
 * recall endpoint already fetches it for vector search).
 */
export function createEmbeddingReranker(
	accessor: DbAccessor,
	queryVector: Float32Array,
): RerankProvider {
	return async (
		_query: string,
		candidates: RerankCandidate[],
		_cfg: RerankConfig,
	): Promise<RerankCandidate[]> => {
		if (candidates.length === 0) return candidates;

		// Batch-fetch cached embeddings for all candidates
		const ids = candidates.map((c) => c.id);
		const placeholders = ids.map(() => "?").join(", ");

		const embMap = accessor.withReadDb((db) => {
			const rows = db
				.prepare(
					`SELECT source_id, vector FROM embeddings
					 WHERE source_type = 'memory' AND source_id IN (${placeholders})`,
				)
				.all(...ids) as CachedEmbedding[];

			const map = new Map<string, Float32Array>();
			for (const row of rows) {
				map.set(row.source_id, bufferToF32(row.vector));
			}
			return map;
		});

		// Blend original score with full-content cosine similarity
		const blendWeight = 0.3; // 30% embedding similarity, 70% original score

		const reranked = candidates.map((c) => {
			const cachedVec = embMap.get(c.id);
			if (!cachedVec) return c; // no embedding — keep original score

			const sim = cosineSimilarity(queryVector, cachedVec);
			const blended = (1 - blendWeight) * c.score + blendWeight * sim;

			return { ...c, score: blended };
		});

		// Sort by blended score descending
		reranked.sort((a, b) => b.score - a.score);
		return reranked;
	};
}

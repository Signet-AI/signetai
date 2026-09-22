import { cosineSimilarity } from "@signet/core";
import type { DbAccessor } from "../db-accessor";
import type { RerankCandidate, RerankConfig, RerankProvider } from "./reranker";

interface CachedEmbedding {
	readonly source_id: string;
	readonly vector: Buffer;
}

function bufferToF32(buf: Buffer): Float32Array {
	return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
}
export function createEmbeddingReranker(accessor: DbAccessor, queryVector: Float32Array): RerankProvider {
	return async (_query: string, candidates: RerankCandidate[], _cfg: RerankConfig): Promise<RerankCandidate[]> => {
		if (candidates.length === 0) return candidates;
		const ids = candidates.map((c) => c.id);
		const placeholders = ids.map(() => "?").join(", ");

		// @ts-expect-error LEGACY_SYNC_DB_ACCESS: withReadDb migration site
		const embMap = accessor.withReadDb((db: import("../db-accessor").ReadDb) => {
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
		}, "pipeline/reranker-embedding.ts:20");
		const blendWeight = 0.3;

		const reranked = candidates.map((c) => {
			const cachedVec = embMap.get(c.id);
			if (!cachedVec) return c;

			const sim = cosineSimilarity(queryVector, cachedVec);
			const blended = (1 - blendWeight) * c.score + blendWeight * sim;

			return { ...c, score: blended };
		});
		reranked.sort((a, b) => b.score - a.score);
		return reranked;
	};
}

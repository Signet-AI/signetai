import { cosineSimilarity, type ReadScope, readScopeSql } from "@signet/core";
import type { DbAccessor } from "../db-accessor";
import { getDbOwnerForAccessor } from "../db-owner-runtime";
import { ownerBytesFromHex, ownerReadAll } from "../db-owner-sql";
import { derivedScopeSql } from "../read-scope-tables";
import type { RerankCandidate, RerankConfig, RerankProvider } from "./reranker";

interface CachedEmbedding {
	readonly source_id: string;
	readonly vector_hex: string;
}

export function createEmbeddingReranker(
	accessor: DbAccessor,
	queryVector: Float32Array,
	readScope?: ReadScope,
): RerankProvider {
	return async (_query: string, candidates: RerankCandidate[], cfg: RerankConfig): Promise<RerankCandidate[]> => {
		if (candidates.length === 0) return candidates;
		const ids = candidates.map((candidate) => candidate.id);
		const memory = readScope ? readScopeSql("m", readScope) : { sql: "", args: [] };
		const embedding = readScope
			? derivedScopeSql(
					"e",
					{ ...readScope, reach: { kind: "all" }, projects: null },
					{ memory: "source_id", session: null, source: "source_id" },
				)
			: { sql: "", args: [] };
		const rows = await ownerReadAll<CachedEmbedding>(
			await getDbOwnerForAccessor(accessor),
			`SELECT e.source_id, hex(e.vector) AS vector_hex FROM embeddings e
			 ${readScope ? "JOIN memories m ON m.id=e.source_id" : ""}
			 WHERE e.source_type='memory' AND e.source_id IN (${ids.map(() => "?").join(",")})${memory.sql}${embedding.sql}`,
			[...ids, ...memory.args, ...embedding.args],
			{
				operation: "recall.reranker.embeddings",
				lane: "read",
				workloadClass: "foreground",
				deadlineMs: cfg.timeoutMs,
				estimatedWorkUnits: ids.length,
			},
		);
		const embeddings = new Map<string, Float32Array>();
		for (const row of rows) {
			const bytes = ownerBytesFromHex(row.vector_hex);
			if (bytes.byteLength !== queryVector.byteLength) continue;
			embeddings.set(
				row.source_id,
				new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / Float32Array.BYTES_PER_ELEMENT),
			);
		}
		const blendWeight = 0.3;
		return candidates
			.map((candidate) => {
				const cached = embeddings.get(candidate.id);
				if (!cached) return candidate;
				return {
					...candidate,
					score: (1 - blendWeight) * candidate.score + blendWeight * cosineSimilarity(queryVector, cached),
				};
			})
			.sort((a, b) => b.score - a.score);
	};
}

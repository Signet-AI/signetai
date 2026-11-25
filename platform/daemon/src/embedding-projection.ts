import type { DbOwnerClient } from "./db-owner-client";
export interface EmbeddingProjectionRequest {
	readonly store: "embeddings" | "embeddings_staging";
	readonly projection: "vec_embeddings" | "vec_embeddings_staging";
	readonly ids: readonly string[];
	readonly contentHashes?: readonly string[];
	readonly resetDimensions?: number;
}
export async function projectEmbeddingRows(owner: DbOwnerClient, request: EmbeddingProjectionRequest): Promise<void> {
	await owner.submit(
		{ kind: "embedding_projection", request },
		{
			operation: "embedding-index.project-shards",
			lane: "write",
			workloadClass: "maintenance",
			deadlineMs: 60000,
			estimatedWorkUnits: 100,
		},
	).result;
}

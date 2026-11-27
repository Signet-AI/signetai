import type { DbOwnerClient } from "./db-owner-client";
export interface EmbeddingProjectionRequest {
	readonly store: "embeddings" | "embeddings_staging";
	readonly projection: "vec_embeddings" | "vec_embeddings_staging";
	readonly ids: readonly string[];
	readonly resetDimensions?: number;
	readonly repair?: boolean;
}
export interface EmbeddingProjectionResult {
	readonly updated: number;
	readonly phase?: string;
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

export async function repairVectorAdmissionThroughOwner(owner: DbOwnerClient): Promise<void> {
	const deadline = Date.now() + 300_000;
	for (const [projection, store] of [
		["vec_embeddings", "embeddings"],
		["vec_embeddings_staging", "embeddings_staging"],
	] as const) {
		let finished = false;
		for (let page = 0; page < 10_000; page++) {
			if (Date.now() > deadline) throw new Error("vector_admission_repair_deadline");
			const result = await owner.submit<EmbeddingProjectionResult>(
				{ kind: "embedding_projection", request: { projection, store, ids: [], repair: true } },
				{
					operation: "embedding-index.repair-admission",
					lane: "write",
					workloadClass: "maintenance",
					deadlineMs: 60_000,
					estimatedWorkUnits: 100,
				},
			).result;
			if (result.phase === "ready" || result.phase === "unavailable" || result.phase === "busy") {
				finished = true;
				break;
			}
			if (result.phase !== "copying" && result.phase !== "verify" && result.phase !== "prepared")
				throw new Error("invalid_vector_admission_phase");
		}
		if (!finished) throw new Error("vector_admission_repair_page_limit");
	}
}

import type { DaemonState, TrayUpdate } from "./types.js";

function computeEmbeddingCoverage(total: number | null, withEmbeddings: number | null): number | null {
	if (total == null || withEmbeddings == null || total === 0) return null;
	return withEmbeddings / total;
}

export function buildTrayUpdate(state: DaemonState): TrayUpdate {
	switch (state.kind) {
		case "running":
			return {
				kind: "running",
				version: state.version,
				health_score: state.healthScore,
				health_status: state.healthStatus,
				memory_count: state.memoryCount,
				memories_today: state.memoriesToday,
				critical_memories: state.criticalMemories,
				embedding_coverage: computeEmbeddingCoverage(state.memoryCount, state.memoriesWithEmbeddings),
				embedding_provider: state.embeddingProvider,
				queue_depth: state.queueDepth,
				recent_memories: state.recentMemories.map((m) => ({
					content: m.content,
					created_at: m.created_at,
					who: m.who,
					importance: m.importance,
				})),
				ingestion_rate: state.ingestionRate,
			};
		case "stopped":
		case "unknown":
			return { kind: "stopped" };
		case "error":
			return { kind: "error", message: state.message };
	}
}

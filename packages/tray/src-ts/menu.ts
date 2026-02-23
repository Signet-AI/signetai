import type { DaemonState, RecentMemory } from "./state";

export interface TrayRecentMemory {
  readonly content: string;
  readonly created_at: string;
  readonly who: string;
  readonly importance: number;
}

export interface TrayUpdate {
  readonly kind: "running" | "stopped" | "error";
  readonly version?: string;
  readonly health_score?: number | null;
  readonly health_status?: string | null;
  readonly memory_count?: number | null;
  readonly memories_today?: number | null;
  readonly critical_memories?: number | null;
  readonly embedding_coverage?: number | null;
  readonly embedding_provider?: string | null;
  readonly queue_depth?: number | null;
  readonly recent_memories?: TrayRecentMemory[];
  readonly ingestion_rate?: number | null;
  readonly message?: string;
}

function computeEmbeddingCoverage(
  total: number | null,
  withEmbeddings: number | null,
): number | null {
  if (total == null || withEmbeddings == null || total === 0) return null;
  return withEmbeddings / total;
}

export function buildTrayUpdate(state: DaemonState): TrayUpdate {
  switch (state.kind) {
    case "running": {
      const embeddingCoverage = computeEmbeddingCoverage(
        state.memoryCount,
        state.memoriesWithEmbeddings,
      );

      return {
        kind: "running",
        version: state.version,
        health_score: state.healthScore,
        health_status: state.healthStatus,
        memory_count: state.memoryCount,
        memories_today: state.memoriesToday,
        critical_memories: state.criticalMemories,
        embedding_coverage: embeddingCoverage,
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
    }

    case "stopped":
      return { kind: "stopped" };

    case "error":
      return { kind: "error", message: state.message };

    case "unknown":
      return { kind: "stopped" };
  }
}

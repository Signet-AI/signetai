export interface RecentMemory {
	readonly id: string;
	readonly content: string;
	readonly created_at: string;
	readonly who: string;
	readonly importance: number;
}

export type DaemonState =
	| { readonly kind: "unknown" }
	| {
			readonly kind: "running";
			readonly version: string;
			readonly pid: number;
			readonly uptime: number;
			readonly healthScore: number | null;
			readonly healthStatus: string | null;
			readonly memoryCount: number | null;
			readonly memoriesWithEmbeddings: number | null;
			readonly criticalMemories: number | null;
			readonly memoriesToday: number | null;
			readonly embeddingProvider: string | null;
			readonly embeddingModel: string | null;
			readonly embeddingAvailable: boolean | null;
			readonly queueDepth: number | null;
			readonly recentMemories: readonly RecentMemory[];
			readonly ingestionRate: number | null;
	  }
	| { readonly kind: "stopped" }
	| { readonly kind: "error"; readonly message: string };

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
	readonly recent_memories?: readonly TrayRecentMemory[];
	readonly ingestion_rate?: number | null;
	readonly message?: string;
}

// Response types for the Signet daemon HTTP API.
// Standalone — no dependency on @signet/core.

export interface MemoryRecord {
  readonly id: string;
  readonly content: string;
  readonly type: string;
  readonly importance: number;
  readonly tags: string | null;
  readonly pinned: boolean;
  readonly who: string | null;
  readonly source_type: string | null;
  readonly project: string | null;
  readonly session_id: string | null;
  readonly confidence: number;
  readonly access_count: number;
  readonly last_accessed: string | null;
  readonly is_deleted: boolean;
  readonly deleted_at: string | null;
  readonly extraction_status: string | null;
  readonly embedding_model: string | null;
  readonly version: number;
  readonly created_at: string;
  readonly updated_at: string;
  readonly updated_by: string | null;
}

export interface RecallResult {
  readonly id: string;
  readonly content: string;
  readonly type: string;
  readonly importance: number;
  readonly tags: string | null;
  readonly who: string | null;
  readonly pinned: boolean;
  readonly source_type: string | null;
  readonly score: number;
  readonly source: "hybrid" | "vector" | "keyword";
  readonly accessCount: number;
  readonly lastAccessed: string | null;
}

export interface RecallResponse {
  readonly results: readonly RecallResult[];
  readonly stats: {
    readonly total: number;
    readonly searchTime: number;
    readonly graphBoosted?: number;
  };
}

export interface RememberResult {
  readonly id: string;
  readonly type: string;
  readonly tags: string | null;
  readonly pinned: boolean;
  readonly importance: number;
  readonly content: string;
  readonly embedded?: boolean;
  readonly deduped?: boolean;
}

export interface MemoryListResponse {
  readonly memories: readonly MemoryRecord[];
  readonly stats: {
    readonly total: number;
    readonly withEmbeddings: number;
    readonly critical: number;
  };
}

export interface ModifyResult {
  readonly id: string;
  readonly status:
    | "updated"
    | "no_changes"
    | "not_found"
    | "deleted"
    | "version_conflict";
  readonly currentVersion: number;
  readonly newVersion?: number;
  readonly contentChanged?: boolean;
  readonly embedded?: boolean;
}

export interface DeleteResult {
  readonly id: string;
  readonly status:
    | "deleted"
    | "not_found"
    | "already_deleted"
    | "version_conflict"
    | "pinned_requires_force";
  readonly currentVersion: number;
  readonly newVersion?: number;
}

export interface ForgetPreviewResponse {
  readonly mode: "preview";
  readonly count: number;
  readonly requiresConfirm: boolean;
  readonly confirmToken: string;
  readonly candidates: readonly {
    readonly id: string;
    readonly score: number;
    readonly pinned: boolean;
    readonly version: number;
  }[];
}

export interface ForgetExecuteResponse {
  readonly mode: "execute";
  readonly count: number;
  readonly deleted: number;
  readonly pinned: number;
}

export type ForgetResponse = ForgetPreviewResponse | ForgetExecuteResponse;

export interface BatchModifyItemResult {
  readonly id: string;
  readonly status: string;
  readonly error?: string;
  readonly currentVersion?: number;
  readonly newVersion?: number;
  readonly duplicateMemoryId?: string;
  readonly contentChanged?: boolean;
  readonly embedded?: boolean;
}

export interface BatchModifyResponse {
  readonly results: readonly BatchModifyItemResult[];
}

export interface HistoryEvent {
  readonly id: string;
  readonly event: string;
  readonly old_content: string | null;
  readonly new_content: string | null;
  readonly changed_by: string | null;
  readonly reason: string | null;
  readonly metadata: Record<string, unknown> | null;
  readonly created_at: string;
  readonly actor_type: string | null;
  readonly session_id: string | null;
  readonly request_id: string | null;
}

export interface HistoryResponse {
  readonly memoryId: string;
  readonly count: number;
  readonly history: readonly HistoryEvent[];
}

export interface RecoverResult {
  readonly id: string;
  readonly status: "recovered" | "not_found" | "not_deleted";
  readonly currentVersion: number;
  readonly newVersion?: number;
  readonly retentionDays: number;
}

// Document types

export interface DocumentRecord {
  readonly id: string;
  readonly source_type: string;
  readonly source_url: string | null;
  readonly status: string;
  readonly title: string | null;
  readonly raw_content?: string;
  readonly chunk_count: number;
  readonly memory_count: number;
  readonly metadata_json?: Record<string, unknown>;
  readonly created_at: string;
  readonly updated_at: string;
}

export interface DocumentCreateResult {
  readonly id: string;
  readonly status: string;
  readonly deduplicated?: boolean;
}

export interface DocumentListResponse {
  readonly documents: readonly DocumentRecord[];
  readonly total: number;
  readonly limit: number;
  readonly offset: number;
}

export interface DocumentChunksResponse {
  readonly chunks: readonly {
    readonly id: string;
    readonly content: string;
    readonly type: string;
    readonly created_at: string;
    readonly chunk_index: number;
  }[];
  readonly count: number;
}

export interface DocumentDeleteResult {
  readonly id: string;
  readonly status: "deleted";
  readonly memoriesRemoved: number;
}

// Job types

export interface JobStatus {
  readonly id: string;
  readonly memory_id: string;
  readonly job_type: string;
  readonly status: "pending" | "leased" | "retry_scheduled" | "done" | "dead";
  readonly attempt_count: number;
  readonly max_attempts: number;
  readonly next_attempt_at: string | null;
  readonly last_error: string | null;
  readonly last_error_code: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}

// Health / status types

export interface HealthResponse {
  readonly status: string;
  readonly uptime: number;
  readonly pid: number;
  readonly version: string;
  readonly port: number;
  readonly agentsDir: string;
}

export interface StatusResponse {
  readonly status: string;
  readonly version: string;
  readonly pid: number;
  readonly uptime: number;
  readonly startedAt: string;
  readonly port: number;
  readonly host: string;
  readonly agentsDir: string;
  readonly memoryDb: boolean;
  readonly pipelineV2: {
    readonly enabled: boolean;
    readonly shadowMode: boolean;
    readonly graphEnabled: boolean;
    readonly autonomousEnabled: boolean;
    readonly mutationsFrozen: boolean;
    readonly extractionModel: string;
  };
  readonly embedding: {
    readonly provider: string;
    readonly model: string;
    readonly available?: boolean;
  };
  readonly health?: {
    readonly score: number;
    readonly status: string;
  };
}

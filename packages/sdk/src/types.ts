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
	readonly status: "updated" | "no_changes" | "not_found" | "deleted" | "version_conflict";
	readonly currentVersion: number;
	readonly newVersion?: number;
	readonly contentChanged?: boolean;
	readonly embedded?: boolean;
}

export interface DeleteResult {
	readonly id: string;
	readonly status: "deleted" | "not_found" | "already_deleted" | "version_conflict" | "pinned_requires_force";
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
	readonly jobId?: string;
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

type JobStatusBase = {
	readonly id: string;
	readonly memory_id: string | null;
	readonly document_id: string | null;
	readonly job_type: string;
	readonly max_attempts: number;
	readonly next_attempt_at: string | null;
	readonly created_at: string;
	readonly updated_at: string;
};

export type JobStatus =
	| (JobStatusBase & {
			readonly status: "pending";
	  })
	| (JobStatusBase & {
			readonly status: "leased";
			readonly attempts: number;
			readonly leased_at: string;
	  })
	| (JobStatusBase & {
			readonly status: "retry_scheduled";
			readonly attempts: number;
			readonly next_attempt_at: string;
	  })
	| (JobStatusBase & {
			readonly status: "failed";
			readonly attempts: number;
			readonly failed_at: string;
			readonly error: string;
			readonly last_error_code?: string;
	  })
	| (JobStatusBase & {
			readonly status: "completed";
			readonly attempts: number;
			readonly completed_at: string;
	  })
	| (JobStatusBase & {
			readonly status: "done";
			readonly attempts: number;
			readonly completed_at: string;
	  })
	| (JobStatusBase & {
			readonly status: "dead";
			readonly attempts: number;
			readonly failed_at: string;
			readonly error: string;
	  });

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

// Timeline types

export interface TimelineEvent {
	readonly id: string;
	readonly entityType: string;
	readonly entityId: string;
	readonly event: string;
	readonly timestamp: string;
	readonly metadata?: Record<string, unknown>;
}

export interface TimelineResponse {
	readonly events: readonly TimelineEvent[];
}

export interface TimelineExportResponse {
	readonly meta: {
		readonly version: string;
		readonly exportedAt: string;
		readonly entityId: string;
	};
	readonly timeline: TimelineResponse;
}

// Pipeline types

export interface PipelineStatusResponse {
	readonly workers: Record<string, unknown>;
	readonly queues: {
		readonly memory: Record<string, number>;
		readonly summary: Record<string, number>;
	};
	readonly diagnostics: Record<string, unknown>;
	readonly latency: Record<string, unknown>;
	readonly errorSummary: Record<string, unknown>;
	readonly mode: "disabled" | "frozen" | "shadow" | "controlled-write";
	readonly feedback: Record<string, unknown>;
	readonly traversal: {
		readonly enabled: boolean;
		readonly lastRun: string | null;
	};
	readonly predictor: {
		readonly running: boolean;
		readonly modelReady: boolean;
		readonly coldStartExited: boolean;
		readonly successRate: number;
		readonly alpha: number;
	};
}

// Telemetry types

export interface TelemetryEvent {
	readonly id: string;
	readonly event: string;
	readonly timestamp: string;
	readonly properties: Record<string, unknown>;
}

export interface TelemetryEventsResponse {
	readonly events: readonly TelemetryEvent[];
	readonly enabled: boolean;
}

export interface TelemetryStatsDisabledResponse {
	readonly enabled: false;
}

export interface TelemetryStatsEnabledResponse {
	readonly enabled: true;
	readonly totalEvents: number;
	readonly llm: {
		readonly calls: number;
		readonly errors: number;
		readonly totalInputTokens: number;
		readonly totalOutputTokens: number;
		readonly totalCost: number;
		readonly p50: number;
		readonly p95: number;
	};
	readonly pipelineErrors: number;
}

export type TelemetryStatsResponse = TelemetryStatsDisabledResponse | TelemetryStatsEnabledResponse;

// Config types

export interface ConfigFile {
	readonly name: string;
	readonly content: string;
	readonly size: number;
}

export interface ConfigListResponse {
	readonly files: readonly ConfigFile[];
	readonly error?: string;
}

export interface ConfigWriteResponse {
	readonly success: boolean;
	readonly error?: string;
}

// Identity types

export interface IdentityResponse {
	readonly name: string;
	readonly creature: string;
	readonly vibe: string;
}

// Embeddings types

export interface EmbeddingStatusResponse {
	readonly provider: "native" | "ollama" | "openai" | "none";
	readonly model: string;
	readonly available: boolean;
	readonly dimensions?: number;
	readonly base_url: string;
	readonly error?: string;
	readonly checkedAt: string;
}

export interface EmbeddingHealthResponse {
	readonly healthy: boolean;
	readonly totalMemories: number;
	readonly embeddedCount: number;
	readonly unembeddedCount: number;
	readonly coveragePercent: number;
}

export interface EmbeddingProjectionNode {
	readonly id: string;
	readonly x: number;
	readonly y: number;
	readonly z?: number;
	readonly [key: string]: unknown;
}

export interface EmbeddingProjectionEdge {
	readonly source: string;
	readonly target: string;
	readonly [key: string]: unknown;
}

export interface EmbeddingProjectionReadyResponse {
	readonly status: "ready";
	readonly dimensions: 2 | 3;
	readonly count: number;
	readonly total: number;
	readonly limit: number;
	readonly offset: number;
	readonly hasMore: boolean;
	readonly nodes: readonly EmbeddingProjectionNode[];
	readonly edges: readonly EmbeddingProjectionEdge[];
	readonly cachedAt?: string;
}

export interface EmbeddingProjectionComputingResponse {
	readonly status: "computing";
	readonly dimensions: 2 | 3;
}

export interface EmbeddingProjectionErrorResponse {
	readonly status: "error";
	readonly message: string;
}

export type EmbeddingProjectionResponse =
	| EmbeddingProjectionReadyResponse
	| EmbeddingProjectionComputingResponse
	| EmbeddingProjectionErrorResponse;

// Harness types

export interface Harness {
	readonly name: string;
	readonly id: string;
	readonly path: string;
	readonly exists: boolean;
	readonly lastSeen: string | null;
}

export interface HarnessListResponse {
	readonly harnesses: readonly Harness[];
}

export interface HarnessRegenerateResponse {
	readonly success: boolean;
	readonly message?: string;
	readonly output?: string;
	readonly error?: string;
}

// Checkpoint types

export interface Checkpoint {
	readonly id: string;
	readonly sessionKey: string;
	readonly project: string;
	readonly checkpointType: string;
	readonly createdAt: string;
	readonly data: Record<string, unknown>;
}

export interface CheckpointListResponse {
	readonly checkpoints: readonly Checkpoint[];
	readonly count: number;
}

// Features types

export interface FeaturesResponse {
	readonly [key: string]: boolean | string | number;
}

// Greeting types

export interface GreetingResponse {
	readonly greeting: string;
	readonly cachedAt: string;
}

// Session types

export interface SessionInfo {
	readonly key: string;
	readonly runtimePath: "plugin" | "legacy";
	readonly claimedAt: string;
	readonly bypassed: boolean;
}

export interface SessionListResponse {
	readonly sessions: readonly SessionInfo[];
	readonly count: number;
}

// Git sync types

export interface GitStatus {
	readonly isRepo: boolean;
	readonly branch?: string;
	readonly remote?: string;
	readonly hasCredentials: boolean;
	readonly authMethod?: string;
	readonly autoSync: boolean;
	readonly lastSync?: string;
	readonly uncommittedChanges?: number;
	readonly unpushedCommits?: number;
	readonly unpulledCommits?: number;
}

export interface GitPullResult {
	readonly success: boolean;
	readonly message: string;
	readonly changes?: number;
}

export interface GitPushResult {
	readonly success: boolean;
	readonly message: string;
	readonly changes?: number;
}

export interface GitSyncResult {
	readonly success: boolean;
	readonly message: string;
	readonly pulled?: number;
	readonly pushed?: number;
}

export interface GitConfig {
	readonly autoSync: boolean;
	readonly syncInterval: number;
	readonly remote: string;
	readonly branch: string;
}

// Task/scheduler types

export interface TaskRecord {
	readonly id: string;
	readonly name: string;
	readonly prompt: string;
	readonly cron_expression: string;
	readonly harness: string;
	readonly working_directory: string | null;
	readonly enabled: boolean;
	readonly next_run_at: string | null;
	readonly skill_name: string | null;
	readonly skill_mode: string | null;
	readonly last_run_at: string | null;
	readonly created_at: string;
	readonly updated_at: string;
	readonly last_run_status?: string;
	readonly last_run_exit_code?: number | null;
}

export interface TaskRun {
	readonly id: string;
	readonly task_id: string;
	readonly status: string;
	readonly exit_code: number | null;
	readonly started_at: string;
	readonly completed_at: string | null;
	readonly error: string | null;
}

export interface TaskCreateResult {
	readonly id: string;
	readonly nextRunAt: string;
}

export interface TaskListResponse {
	readonly tasks: readonly TaskRecord[];
	readonly presets: Record<string, string>;
}

export interface TaskGetResponse {
	readonly task: TaskRecord;
	readonly runs: readonly TaskRun[];
}

export interface TaskRunListResponse {
	readonly runs: readonly TaskRun[];
	readonly total: number;
	readonly hasMore: boolean;
}

export interface TaskUpdatePayload {
	readonly name?: string;
	readonly prompt?: string;
	readonly cronExpression?: string;
	readonly harness?: string;
	readonly workingDirectory?: string;
	readonly enabled?: boolean;
	readonly skillName?: string;
	readonly skillMode?: string;
}

export interface TaskCreatePayload {
	readonly name: string;
	readonly prompt: string;
	readonly cronExpression: string;
	readonly harness: string;
	readonly workingDirectory?: string;
	readonly skillName?: string;
	readonly skillMode?: string;
}

// Secret types

export interface SecretListResponse {
	readonly secrets: readonly string[];
}

export interface SecretExecResult {
	readonly stdout: string;
	readonly stderr: string;
	readonly code: number;
}

export interface OnePasswordStatus {
	readonly configured: boolean;
	readonly connected: boolean;
	readonly vaultCount?: number;
	readonly vaults: readonly { readonly id: string; readonly name: string }[];
	readonly error?: string;
}

export interface OnePasswordConnectResult {
	readonly success: boolean;
	readonly connected: boolean;
	readonly vaultCount: number;
	readonly vaults: readonly { readonly id: string; readonly name: string }[];
}

export interface OnePasswordImportResult {
	readonly success: boolean;
	readonly vaultsScanned: number;
	readonly itemsScanned: number;
	readonly importedCount: number;
	readonly errorCount: number;
}

// Skill types

export interface SkillMeta {
	readonly description: string;
	readonly version?: string;
	readonly author?: string;
	readonly maintainer?: string;
	readonly license?: string;
	readonly user_invocable?: boolean;
	readonly arg_hint?: string;
	readonly verified?: boolean;
	readonly permissions?: readonly string[];
}

export interface InstalledSkill {
	readonly name: string;
	readonly path: string;
	readonly meta: SkillMeta;
}

export interface SkillListResponse {
	readonly skills: readonly InstalledSkill[];
	readonly count: number;
}

export interface SkillBrowseResult {
	readonly name: string;
	readonly fullName: string;
	readonly installs: string;
	readonly installsRaw: number;
	readonly popularityScore: number;
	readonly description: string;
	readonly installed: boolean;
	readonly provider: "skills.sh" | "clawhub";
	readonly category: string;
	readonly downloads?: number;
	readonly maintainer?: string;
	readonly stars?: number;
	readonly versions?: number;
	readonly author?: string;
}

export interface SkillBrowseResponse {
	readonly results: readonly SkillBrowseResult[];
	readonly total: number;
}

export interface SkillSearchResponse {
	readonly results: readonly SkillBrowseResult[];
}

export interface SkillGetResponse extends SkillMeta {
	readonly name: string;
	readonly path?: string;
	readonly content: string;
}

export interface SkillInstallResult {
	readonly success: boolean;
	readonly name: string;
	readonly output?: string;
	readonly error?: string;
}

export interface SkillDeleteResult {
	readonly success: boolean;
	readonly name: string;
	readonly message: string;
}

// Re-export P2 domain types
export type {
	// Hooks
	SessionStartResponse,
	UserPromptSubmitResponse,
	SessionEndResponse,
	PreCompactionResponse,
	CompactionCompleteResponse,
	SynthesisConfigResponse,
	SynthesisRequestResponse,
	SynthesisCompleteResponse,
	// Connectors
	ConnectorRecord,
	ConnectorListResponse,
	ConnectorCreateResponse,
	ConnectorSyncResponse,
	ConnectorResyncResponse,
	ConnectorDeleteResponse,
	ConnectorHealthResponse,
	// Analytics
	UsageCountersResponse,
	ErrorEvent,
	ErrorsResponse,
	LatencyHistogram,
	LatencyResponse,
	LogEntry,
	LogsResponse,
	MemorySafetyResponse,
	ContinuityScore,
	ContinuityResponse,
	ContinuityLatestResponse,
	// Knowledge Graph
	KnowledgeEntity,
	KnowledgeEntityDetail,
	KnowledgeEntityListResponse,
	PinEntityResponse,
	UnpinEntityResponse,
	EntityAspect,
	EntityAspectsResponse,
	AspectAttribute,
	AspectAttributesResponse,
	EntityDependency,
	EntityDependenciesResponse,
	KnowledgeStatsResponse,
	TraversalStatusResponse,
	ConstellationNode,
	ConstellationEdge,
	ConstellationResponse,
	// Repair
	RepairActionResponse,
	EmbeddingGapsResponse,
	DedupStatsResponse,
	DeduplicateResponse,
	// Cross-Agent
	AgentPresence,
	AgentPresenceListResponse,
	AgentPresenceUpdateResponse,
	AgentMessage,
	AgentMessageListResponse,
	AgentMessageSendResponse,
	// Predictor
	PredictorStatusResponse,
	PredictorComparison,
	ComparisonsByProjectResponse,
	ComparisonsByEntityResponse,
	ComparisonsListResponse,
	TrainingRun,
	TrainingRunsResponse,
	TrainingPairsCountResponse,
	TrainPredictorResponse,
} from "./types-p2.js";

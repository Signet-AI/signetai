// P2 domain types for the Signet daemon HTTP API.
// These types cover Hooks, Connectors, Analytics, Knowledge Graph, Repair, Cross-Agent, and Predictor domains.

// ============================================================================
// Hooks types
// ============================================================================

export interface SessionStartResponse {
	/** Deprecated compatibility field from the pre-hook response shape. */
	readonly context?: string;
	readonly sessionId?: string;
	readonly identity?: {
		readonly name: string;
		readonly description?: string;
	};
	readonly memories?: readonly {
		readonly id: string;
		readonly content: string;
		readonly type: string;
		readonly importance: number;
		readonly created_at: string;
	}[];
	readonly stableSystemPrompt?: string;
	readonly dynamicContext?: string;
	/** Compatibility aggregate for clients predating the split contract. */
	readonly inject?: string;
	readonly contextHash?: string;
	readonly contextVersion?: number;
	readonly recentContext?: string;
	readonly warnings?: readonly string[];
	readonly sessionKnown?: boolean;
}

export interface UserPromptSubmitResponse {
	/** Deprecated compatibility field from the pre-hook response shape. */
	readonly context?: string;
	readonly dynamicContext?: string;
	/** Compatibility aggregate for clients predating the split contract. */
	readonly inject?: string;
	readonly contextHash?: string;
	readonly contextVersion?: number;
	readonly memoryCount?: number;
	readonly queryTerms?: string;
	readonly engine?: string;
	readonly sessionKnown?: boolean;
	readonly warnings?: readonly string[];
}

export interface SessionEndResponse {
	readonly memoriesSaved: number;
	readonly queued?: boolean;
	readonly jobId?: string;
	readonly transcriptCaptureJobId?: string;
}

export interface HookRecallResult {
	readonly id: string;
	readonly content: string;
	readonly content_length: number;
	readonly truncated: boolean;
	readonly score: number;
	readonly source: string;
	readonly type: string;
	readonly tags: string | null;
	readonly pinned: boolean;
	readonly importance: number;
	readonly who: string;
	readonly project: string | null;
	readonly created_at: string;
	readonly supplementary?: boolean;
	readonly already_recalled?: boolean;
}

export interface HookRecallDedupeMeta {
	readonly enabled: boolean;
	readonly contextEpoch?: number;
	readonly suppressed: number;
	readonly repeatedReturned: number;
}

export interface HookRecallResponse {
	readonly results: readonly HookRecallResult[];
	readonly memories?: readonly HookRecallResult[];
	readonly count?: number;
	readonly query: string;
	readonly method: "hybrid" | "keyword";
	readonly meta: {
		readonly totalReturned: number;
		readonly hasSupplementary: boolean;
		readonly noHits: boolean;
		readonly dedupe?: HookRecallDedupeMeta;
	};
	readonly bypassed?: boolean;
	readonly internal?: boolean;
}

export interface PreCompactionResponse {
	readonly instructions: string;
}

export interface CompactionCompleteResponse {
	readonly message: string;
	readonly success?: boolean;
	readonly memoryId?: string | null;
	readonly contextEpoch?: number;
}

export interface SynthesisConfigResponse {
	readonly enabled: boolean;
	readonly model?: string;
	readonly interval?: string;
	readonly lastRun?: string;
}

export interface SynthesisRequestResponse {
	readonly message: string;
	readonly triggered: boolean;
}

export interface SynthesisCompleteResponse {
	readonly message: string;
}

// ============================================================================
// Connectors types
// ============================================================================

export interface ConnectorRecord {
	readonly id: string;
	readonly provider: string;
	readonly displayName: string;
	readonly enabled: boolean;
	readonly configJson: string;
	readonly cursorJson: string | null;
	readonly status: string;
	readonly lastSync: string | null;
	readonly createdAt: string;
	readonly updatedAt: string;
}

export interface ConnectorListResponse {
	readonly connectors: readonly ConnectorRecord[];
	readonly count: number;
}

export interface ConnectorCreateResponse {
	readonly id: string;
}

export interface ConnectorSyncResponse {
	readonly status: string;
	readonly message?: string;
}

export interface ConnectorResyncResponse {
	readonly status: string;
	readonly total: number;
	readonly started: number;
	readonly alreadySyncing: number;
	readonly unsupported: number;
	readonly failed: number;
}

export interface ConnectorDeleteResponse {
	readonly deleted: boolean;
}

export interface ConnectorHealthResponse {
	readonly id: string;
	readonly status: string;
	readonly lastSync?: string;
	readonly documentsCount?: number;
	readonly memoriesCount?: number;
	readonly error?: string;
}

// ============================================================================
// Analytics types
// ============================================================================

export interface UsageCountersResponse {
	readonly requests: Record<string, number>;
	readonly errors: Record<string, number>;
	readonly period: {
		readonly start: string;
		readonly end: string;
	};
}

export interface ErrorEvent {
	readonly timestamp: string;
	readonly stage: string;
	readonly operation: string;
	readonly error: string;
	readonly code?: string;
	readonly actor?: string;
}

export interface ErrorsResponse {
	readonly errors: readonly ErrorEvent[];
	readonly summary: Record<string, number>;
}

export interface LatencyHistogram {
	readonly p50: number;
	readonly p95: number;
	readonly p99: number;
	readonly count: number;
}

export interface LatencyResponse {
	readonly remember: LatencyHistogram;
	readonly recall: LatencyHistogram;
	readonly mutate: LatencyHistogram;
	readonly predictor_score?: LatencyHistogram;
	readonly predictor_train?: LatencyHistogram;
}

export interface LogEntry {
	readonly timestamp: string;
	readonly level: string;
	readonly category: string;
	readonly message: string;
	readonly meta?: Record<string, unknown>;
}

export interface LogsResponse {
	readonly logs: readonly LogEntry[];
	readonly count: number;
}

export interface MemorySafetyResponse {
	readonly mutation: {
		readonly healthScore: number;
		readonly status: string;
	};
	readonly recentErrors: readonly ErrorEvent[];
	readonly errorSummary: Record<string, number>;
}

export interface ContinuityScore {
	readonly id: string;
	readonly session_key: string;
	readonly project: string | null;
	readonly harness: string | null;
	readonly score: number;
	readonly memories_recalled: number;
	readonly memories_used: number;
	readonly novel_context_count: number;
	readonly reasoning: string | null;
	readonly created_at: string;
}

export interface ContinuityResponse {
	readonly scores: readonly ContinuityScore[];
	readonly summary: {
		readonly count: number;
		readonly average: number;
		readonly trend: number;
		readonly latest: number | null;
	};
}

export interface ContinuityLatestScore {
	readonly project: string;
	readonly score: number;
	readonly created_at: string;
}

export interface ContinuityLatestResponse {
	readonly scores: readonly ContinuityLatestScore[];
}

// ============================================================================
// Knowledge Graph types
// ============================================================================

export interface KnowledgeEntity {
	readonly id: string;
	readonly agentId: string;
	readonly type: string;
	readonly name: string;
	readonly canonical: string;
	readonly description: string | null;
	readonly pinnedAt: string | null;
	readonly mentionCount: number;
	readonly aspectCount: number;
	readonly createdAt: string;
	readonly updatedAt: string;
}

export interface KnowledgeEntityDetail {
	readonly entity: KnowledgeEntity;
	readonly aspects: readonly EntityAspect[];
}

export interface KnowledgeEntityListResponse {
	readonly items: readonly KnowledgeEntity[];
	readonly limit: number;
	readonly offset: number;
}

export interface PinEntityResponse {
	readonly pinned: boolean;
	readonly pinnedAt: string;
}

export interface UnpinEntityResponse {
	readonly pinned: boolean;
}

export interface EntityAspect {
	readonly id: string;
	readonly label: string;
	readonly mentionCount: number;
}

export interface EntityAspectsResponse {
	readonly items: readonly EntityAspect[];
}

export interface AspectAttribute {
	readonly id: string;
	readonly kind: string;
	readonly valueText: string;
	readonly status: string;
	readonly createdAt: string;
}

export interface AspectAttributesResponse {
	readonly items: readonly AspectAttribute[];
	readonly limit: number;
	readonly offset: number;
}

export interface EntityDependency {
	readonly entityId: string;
	readonly entityName: string;
	readonly entityType: string;
	readonly aspectLabel: string;
	readonly relationType: string;
}

export interface EntityDependenciesResponse {
	readonly entityId: string;
	readonly dependencies: readonly EntityDependency[];
}

export interface KnowledgeStatsResponse {
	readonly entities: number;
	readonly aspects: number;
	readonly attributes: number;
	readonly mentions: number;
	readonly pinnedEntities: number;
}

export interface TraversalStatusResponse {
	readonly valid: boolean;
	readonly computedAt: string | null;
	readonly entityCount: number;
	readonly relationCount: number;
}

export interface ConstellationNode {
	readonly id: string;
	readonly type: string;
	readonly name: string;
	readonly x: number;
	readonly y: number;
	readonly z?: number;
	readonly size: number;
	readonly mentionCount: number;
}

export interface ConstellationEdge {
	readonly source: string;
	readonly target: string;
	readonly weight: number;
	readonly relationType: string;
}

export interface ConstellationResponse {
	readonly nodes: readonly ConstellationNode[];
	readonly edges: readonly ConstellationEdge[];
}

// ============================================================================
// Repair types
// ============================================================================

export interface RepairActionResponse {
	readonly action: string;
	readonly success: boolean;
	readonly affected: number;
	readonly message?: string;
}

export interface EmbeddingGapsResponse {
	readonly total: number;
	readonly embedded: number;
	readonly unembedded: number;
	readonly complete: boolean;
	readonly coverage: string;
}

export interface DedupStatsResponse {
	readonly total: number;
	readonly duplicates: number;
	readonly candidates: number;
}

export interface DeduplicateResponse extends RepairActionResponse {
	readonly duplicatesRemoved: number;
}

// ============================================================================
// Cross-Agent types
// ============================================================================

export interface AgentPresence {
	readonly agentId: string;
	readonly sessionKey: string;
	readonly project: string | null;
	readonly harness: string;
	readonly runtimePath: string | null;
	readonly lastSeen: string;
	readonly createdAt: string;
}

export interface AgentPresenceListResponse {
	readonly sessions: readonly AgentPresence[];
	readonly count: number;
}

export interface AgentPresenceUpdateResponse {
	readonly agentId: string;
	readonly sessionKey: string;
	readonly created: boolean;
}

export interface AgentMessage {
	readonly id: string;
	readonly fromAgentId: string;
	readonly fromSessionKey?: string;
	readonly toAgentId?: string;
	readonly toSessionKey?: string;
	readonly toSessionAgentId?: string;
	readonly type: "assist_request" | "decision_update" | "info" | "question";
	readonly content: string;
	readonly broadcast: boolean;
	readonly createdAt: string;
	readonly expiresAt: string;
	readonly deliveryPath: "local" | "acp";
	readonly deliveryStatus: "queued" | "delivered" | "failed";
	readonly deliveryState: "pending" | "in_flight" | "indeterminate" | "delivered" | "failed";
	readonly deliveryAttemptId?: string;
	readonly deliveryAttempts: number;
	readonly deliveryAttemptStartedAt?: string;
	readonly deliveryUpdatedAt?: string;
	readonly deliveryError?: string;
	readonly deliveryReceipt?: Readonly<Record<string, unknown>>;
	readonly acknowledgedAt?: string;
}

export interface AgentMessageListResponse {
	readonly items: readonly AgentMessage[];
	readonly count: number;
	readonly total: number;
	readonly unreadCount: number;
	readonly limit: number;
	readonly offset: number;
	readonly hasMore: boolean;
}

export interface AgentMessageSendResponse {
	readonly message: AgentMessage;
}

export interface AgentMessageAcknowledgeResponse {
	readonly messageId: string;
	readonly agentId: string;
	readonly acknowledgedAt: string;
	readonly alreadyAcknowledged: boolean;
}

// ============================================================================
// Predictor types — deprecated

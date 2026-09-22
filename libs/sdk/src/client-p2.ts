import type { SignetTransport } from "./transport.js";
import type {
	AgentMessageAcknowledgeResponse,
	AgentMessageListResponse,
	AgentMessageSendResponse,
	AgentPresenceListResponse,
	AgentPresenceUpdateResponse,
	AspectAttributesResponse,
	CompactionCompleteResponse,
	ConnectorCreateResponse,
	ConnectorDeleteResponse,
	ConnectorHealthResponse,
	ConnectorListResponse,
	ConnectorRecord,
	ConnectorResyncResponse,
	ConnectorSyncResponse,
	ConstellationResponse,
	ContinuityLatestResponse,
	ContinuityResponse,
	DedupStatsResponse,
	DeduplicateResponse,
	EmbeddingGapsResponse,
	EntityAspectsResponse,
	EntityDependenciesResponse,
	ErrorsResponse,
	HookRecallResponse,
	KnowledgeEntityDetail,
	KnowledgeEntityListResponse,
	KnowledgeStatsResponse,
	LatencyResponse,
	LogsResponse,
	MemorySafetyResponse,
	PinEntityResponse,
	PreCompactionResponse,
	RepairActionResponse,
	SessionEndResponse,
	SessionStartResponse,
	SynthesisConfigResponse,
	SynthesisRequestResponse,
	TraversalStatusResponse,
	UnpinEntityResponse,
	UsageCountersResponse,
	UserPromptSubmitResponse,
	VectorRepairResponse,
	VectorRepairOptions,
} from "./types-p2.js";

export class SignetClientP2 {
	constructor(private readonly transport: SignetTransport) {}
	async sessionStart(opts: {
		readonly sessionKey: string;
		readonly project?: string;
		readonly harness?: string;
		readonly runtimePath?: string;
	}): Promise<SessionStartResponse> {
		return this.transport.post<SessionStartResponse>("/api/hooks/session-start", opts);
	}
	async userPromptSubmit(opts: {
		readonly sessionKey: string;
		readonly prompt: string;
		readonly project?: string;
	}): Promise<UserPromptSubmitResponse> {
		return this.transport.post<UserPromptSubmitResponse>("/api/hooks/user-prompt-submit", opts);
	}
	async sessionEnd(opts: {
		readonly sessionKey: string;
		readonly harness: string;
		readonly project?: string;
		readonly transcriptPath?: string;
		readonly transcript?: string;
		readonly sessionId?: string;
		readonly agentId?: string;
		readonly capturedAt?: string;
		readonly reason?: string;
	}): Promise<SessionEndResponse> {
		return this.transport.post<SessionEndResponse>("/api/hooks/session-end", opts);
	}

	sessionEndFireAndForget(opts: {
		readonly sessionKey?: string;
		readonly summary?: string;
		readonly project?: string;
		readonly harness?: string;
		readonly agentId?: string;
		readonly transcriptPath?: string;
		readonly transcript?: string;
		readonly sessionId?: string;
		readonly cwd?: string;
		readonly capturedAt?: string;
		readonly reason?: string;
		readonly runtimePath?: string;
	}): void {
		this.transport.post("/api/hooks/session-end", opts).catch(() => {});
	}
	async hookRemember(opts: {
		readonly content: string;
		readonly type?: string;
		readonly importance?: number;
		readonly tags?: string;
		readonly who?: string;
		readonly sessionKey?: string;
		readonly runtimePath?: string;
	}): Promise<{ readonly id: string }> {
		return this.transport.post<{ readonly id: string }>("/api/hooks/remember", opts);
	}
	async rememberHook(opts: {
		readonly content: string;
		readonly type?: string;
		readonly importance?: number;
		readonly tags?: string;
		readonly who?: string;
		readonly sessionKey?: string;
		readonly runtimePath?: string;
	}): Promise<{ readonly id: string }> {
		return this.hookRemember(opts);
	}
	async hookRecall(opts: {
		readonly query: string;
		readonly keywordQuery?: string;
		readonly limit?: number;
		readonly project?: string;
		readonly type?: string;
		readonly tags?: string;
		readonly who?: string;
		readonly since?: string;
		readonly until?: string;
		readonly time?: {
			readonly start?: string;
			readonly end?: string;
			readonly facets?: readonly string[];
			readonly mode?: "auto" | "timeline" | "filter";
		};
		readonly expand?: boolean;
		readonly sessionKey?: string;
		readonly agentId?: string;
		readonly includeRecalled?: boolean;
		readonly runtimePath?: string;
	}): Promise<HookRecallResponse> {
		return this.transport.post<HookRecallResponse>("/api/hooks/recall", opts);
	}
	async recallHook(opts: {
		readonly query: string;
		readonly keywordQuery?: string;
		readonly limit?: number;
		readonly project?: string;
		readonly type?: string;
		readonly tags?: string;
		readonly who?: string;
		readonly since?: string;
		readonly until?: string;
		readonly time?: {
			readonly start?: string;
			readonly end?: string;
			readonly facets?: readonly string[];
			readonly mode?: "auto" | "timeline" | "filter";
		};
		readonly expand?: boolean;
		readonly sessionKey?: string;
		readonly agentId?: string;
		readonly includeRecalled?: boolean;
		readonly runtimePath?: string;
	}): Promise<HookRecallResponse> {
		return this.hookRecall(opts);
	}
	async preCompaction(opts: {
		readonly sessionKey: string;
		readonly context: string;
		readonly project?: string;
	}): Promise<PreCompactionResponse> {
		return this.transport.post<PreCompactionResponse>("/api/hooks/pre-compaction", opts);
	}
	async compactionComplete(opts: {
		readonly sessionKey: string;
		readonly summary: string;
		readonly project?: string;
	}): Promise<CompactionCompleteResponse> {
		return this.transport.post<CompactionCompleteResponse>("/api/hooks/compaction-complete", opts);
	}
	async getSynthesisConfig(): Promise<SynthesisConfigResponse> {
		return this.transport.get<SynthesisConfigResponse>("/api/hooks/synthesis/config");
	}
	async requestSynthesis(opts?: {
		readonly project?: string;
		readonly force?: boolean;
	}): Promise<SynthesisRequestResponse> {
		return this.transport.post<SynthesisRequestResponse>("/api/hooks/synthesis", opts ?? {});
	}
	async listConnectors(): Promise<ConnectorListResponse> {
		return this.transport.get<ConnectorListResponse>("/api/connectors");
	}
	async createConnector(opts: {
		readonly provider: "filesystem" | "github-docs" | "gdrive";
		readonly displayName?: string;
		readonly settings?: Record<string, unknown>;
	}): Promise<ConnectorCreateResponse> {
		return this.transport.post<ConnectorCreateResponse>("/api/connectors", opts);
	}
	async getConnector(id: string): Promise<ConnectorRecord> {
		return this.transport.get<ConnectorRecord>(`/api/connectors/${id}`);
	}
	async syncConnector(id: string): Promise<ConnectorSyncResponse> {
		return this.transport.post<ConnectorSyncResponse>(`/api/connectors/${id}/sync`, {});
	}
	async resyncAllConnectors(): Promise<ConnectorResyncResponse> {
		return this.transport.post<ConnectorResyncResponse>("/api/connectors/resync", {});
	}
	async fullSyncConnector(id: string): Promise<ConnectorSyncResponse> {
		return this.transport.post<ConnectorSyncResponse>(`/api/connectors/${id}/sync/full?confirm=true`, {});
	}
	async deleteConnector(id: string, opts?: { readonly cascade?: boolean }): Promise<ConnectorDeleteResponse> {
		const cascade = opts?.cascade ? "?cascade=true" : "";
		return this.transport.del<ConnectorDeleteResponse>(`/api/connectors/${id}${cascade}`, {});
	}
	async getConnectorHealth(id: string): Promise<ConnectorHealthResponse> {
		return this.transport.get<ConnectorHealthResponse>(`/api/connectors/${id}/health`);
	}
	async getUsageCounters(): Promise<UsageCountersResponse> {
		return this.transport.get<UsageCountersResponse>("/api/analytics/usage");
	}
	async getErrors(opts?: {
		readonly stage?: string;
		readonly since?: string;
		readonly limit?: number;
	}): Promise<ErrorsResponse> {
		return this.transport.get<ErrorsResponse>("/api/analytics/errors", opts);
	}
	async getLatency(): Promise<LatencyResponse> {
		return this.transport.get<LatencyResponse>("/api/analytics/latency");
	}
	async getAnalyticsLogs(opts?: {
		readonly limit?: number;
		readonly level?: "debug" | "info" | "warn" | "error";
		readonly category?: string;
		readonly since?: string;
	}): Promise<LogsResponse> {
		return this.transport.get<LogsResponse>("/api/analytics/logs", opts);
	}
	async getMemorySafety(): Promise<MemorySafetyResponse> {
		return this.transport.get<MemorySafetyResponse>("/api/analytics/memory-safety");
	}
	async getContinuity(opts?: { readonly project?: string; readonly limit?: number }): Promise<ContinuityResponse> {
		return this.transport.get<ContinuityResponse>("/api/analytics/continuity", opts);
	}
	async getLatestContinuity(): Promise<ContinuityLatestResponse> {
		return this.transport.get<ContinuityLatestResponse>("/api/analytics/continuity/latest");
	}
	async listKnowledgeEntities(opts?: {
		readonly agentId?: string;
		readonly type?: string;
		readonly query?: string;
		readonly limit?: number;
		readonly offset?: number;
	}): Promise<KnowledgeEntityListResponse> {
		return this.transport.get<KnowledgeEntityListResponse>("/api/knowledge/entities", opts);
	}
	async pinEntity(id: string, opts?: { readonly agentId?: string }): Promise<PinEntityResponse> {
		return this.transport.post<PinEntityResponse>(
			`/api/knowledge/entities/${id}/pin`,
			{},
			opts ? { query: opts } : undefined,
		);
	}
	async unpinEntity(id: string, opts?: { readonly agentId?: string }): Promise<UnpinEntityResponse> {
		const query = opts?.agentId ? `?agent_id=${opts.agentId}` : "";
		return this.transport.del<UnpinEntityResponse>(`/api/knowledge/entities/${id}/pin${query}`, {});
	}
	async getPinnedEntities(opts?: { readonly agentId?: string }): Promise<KnowledgeEntityListResponse> {
		return this.transport.get<KnowledgeEntityListResponse>("/api/knowledge/entities/pinned", opts);
	}
	async getEntityHealth(opts?: {
		readonly agentId?: string;
		readonly since?: string;
		readonly minComparisons?: number;
	}): Promise<{ readonly entities: readonly unknown[] }> {
		return this.transport.get<{ readonly entities: readonly unknown[] }>("/api/knowledge/entities/health", opts);
	}
	async getKnowledgeEntity(id: string, opts?: { readonly agentId?: string }): Promise<KnowledgeEntityDetail> {
		return this.transport.get<KnowledgeEntityDetail>(`/api/knowledge/entities/${id}`, opts);
	}
	async getEntityAspects(entityId: string, opts?: { readonly agentId?: string }): Promise<EntityAspectsResponse> {
		return this.transport.get<EntityAspectsResponse>(`/api/knowledge/entities/${entityId}/aspects`, opts);
	}
	async getAspectAttributes(
		entityId: string,
		aspectId: string,
		opts?: {
			readonly agentId?: string;
			readonly kind?: "attribute" | "constraint";
			readonly status?: "active" | "superseded" | "deleted";
			readonly limit?: number;
			readonly offset?: number;
		},
	): Promise<AspectAttributesResponse> {
		return this.transport.get<AspectAttributesResponse>(
			`/api/knowledge/entities/${entityId}/aspects/${aspectId}/attributes`,
			opts,
		);
	}
	async getEntityDependencies(
		entityId: string,
		opts?: { readonly agentId?: string },
	): Promise<EntityDependenciesResponse> {
		return this.transport.get<EntityDependenciesResponse>(`/api/knowledge/entities/${entityId}/dependencies`, opts);
	}
	async getKnowledgeStats(): Promise<KnowledgeStatsResponse> {
		return this.transport.get<KnowledgeStatsResponse>("/api/knowledge/stats");
	}
	async getTraversalStatus(): Promise<TraversalStatusResponse> {
		return this.transport.get<TraversalStatusResponse>("/api/knowledge/traversal/status");
	}
	async getConstellation(): Promise<ConstellationResponse> {
		return this.transport.get<ConstellationResponse>("/api/knowledge/constellation");
	}
	async requeueDeadJobs(): Promise<RepairActionResponse> {
		return this.transport.post<RepairActionResponse>("/api/repair/requeue-dead", {});
	}
	async releaseStaleLeases(): Promise<RepairActionResponse> {
		return this.transport.post<RepairActionResponse>("/api/repair/release-leases", {});
	}
	async checkFts(opts?: { readonly repair?: boolean }): Promise<RepairActionResponse> {
		return this.transport.post<RepairActionResponse>("/api/repair/check-fts", opts ?? {});
	}
	async triggerRetentionSweep(): Promise<RepairActionResponse> {
		return this.transport.post<RepairActionResponse>("/api/repair/retention-sweep", {});
	}
	async getEmbeddingGaps(): Promise<EmbeddingGapsResponse> {
		return this.transport.get<EmbeddingGapsResponse>("/api/repair/embedding-gaps");
	}
	async reembedMissing(opts?: { readonly limit?: number }): Promise<RepairActionResponse> {
		return this.transport.post<RepairActionResponse>("/api/repair/re-embed", opts ?? {});
	}
	async resyncVectorIndex(opts?: VectorRepairOptions): Promise<VectorRepairResponse> {
		return this.transport.post<VectorRepairResponse>("/api/repair/resync-vec", opts ?? {});
	}
	async cleanOrphanedEmbeddings(opts?: VectorRepairOptions): Promise<VectorRepairResponse> {
		return this.transport.post<VectorRepairResponse>("/api/repair/clean-orphans", opts ?? {});
	}
	async getDedupStats(): Promise<DedupStatsResponse> {
		return this.transport.get<DedupStatsResponse>("/api/repair/dedup-stats");
	}
	async deduplicateMemories(opts?: { readonly dryRun?: boolean }): Promise<DeduplicateResponse> {
		return this.transport.post<DeduplicateResponse>("/api/repair/deduplicate", opts ?? {});
	}
	async pruneChunkGroups(): Promise<RepairActionResponse> {
		return this.transport.post<RepairActionResponse>("/api/repair/prune-chunk-groups", {});
	}
	async pruneSingletonEntities(opts?: { readonly minMentions?: number }): Promise<RepairActionResponse> {
		return this.transport.post<RepairActionResponse>("/api/repair/prune-singleton-entities", opts ?? {});
	}
	async listAgentPresence(opts?: {
		readonly agentId?: string;
		readonly sessionKey?: string;
		readonly project?: string;
		readonly includeSelf?: boolean;
		readonly limit?: number;
	}): Promise<AgentPresenceListResponse> {
		return this.transport.get<AgentPresenceListResponse>("/api/cross-agent/presence", opts);
	}
	async updateAgentPresence(opts: {
		readonly harness: string;
		readonly runtimePath?: "plugin" | "legacy";
		readonly agentId?: string;
		readonly sessionKey?: string;
		readonly project?: string;
	}): Promise<AgentPresenceUpdateResponse> {
		return this.transport.post<AgentPresenceUpdateResponse>("/api/cross-agent/presence", opts);
	}
	async removeAgentPresence(sessionKey: string): Promise<{ readonly removed: boolean }> {
		return this.transport.del<{ readonly removed: boolean }>(`/api/cross-agent/presence/${sessionKey}`, {});
	}
	async listAgentMessages(opts?: {
		readonly agentId?: string;
		readonly sessionKey?: string;
		readonly since?: string;
		readonly limit?: number;
		readonly offset?: number;
		readonly unreadOnly?: boolean;
		readonly includeSent?: boolean;
		readonly includeBroadcast?: boolean;
	}): Promise<AgentMessageListResponse> {
		return this.transport.get<AgentMessageListResponse>("/api/cross-agent/messages", {
			agent_id: opts?.agentId,
			session_key: opts?.sessionKey,
			since: opts?.since,
			limit: opts?.limit,
			offset: opts?.offset,
			unread_only: opts?.unreadOnly,
			include_sent: opts?.includeSent,
			include_broadcast: opts?.includeBroadcast,
		});
	}
	async sendAgentMessage(opts: {
		readonly toAgentId?: string;
		readonly toSessionKey?: string;
		readonly type: "assist_request" | "decision_update" | "info" | "question";
		readonly content: string;
		readonly broadcast?: boolean;
		readonly via?: "local" | "acp";
		readonly acp?: {
			readonly baseUrl: string;
			readonly targetAgentName: string;
			readonly timeoutMs?: number;
			readonly metadata?: Readonly<Record<string, unknown>>;
		};
	}): Promise<AgentMessageSendResponse> {
		return this.transport.post<AgentMessageSendResponse>("/api/cross-agent/messages", opts);
	}
	async acknowledgeAgentMessage(
		messageId: string,
		opts?: { readonly agentId?: string; readonly sessionKey?: string },
	): Promise<AgentMessageAcknowledgeResponse> {
		return this.transport.post<AgentMessageAcknowledgeResponse>(
			`/api/cross-agent/messages/${encodeURIComponent(messageId)}/ack`,
			opts ?? {},
		);
	}
	async retryAgentMessage(messageId: string, opts?: { readonly agentId?: string }): Promise<AgentMessageSendResponse> {
		return this.transport.post<AgentMessageSendResponse>(
			`/api/cross-agent/messages/${encodeURIComponent(messageId)}/retry`,
			opts ?? {},
		);
	}

	private predictorDeprecated(): never {
		throw new Error(
			"Signet predictor APIs were removed in v0.112. Use memory search telemetry and pipeline diagnostics instead.",
		);
	}
	async getPredictorStatus(): Promise<never> {
		this.predictorDeprecated();
	}
	async getComparisonsByProject(_project: string): Promise<never> {
		this.predictorDeprecated();
	}
	async getComparisonsByEntity(_entityId: string): Promise<never> {
		this.predictorDeprecated();
	}
	async listComparisons(_opts?: {
		readonly limit?: number;
		readonly offset?: number;
		readonly agentId?: string;
	}): Promise<never> {
		this.predictorDeprecated();
	}
	async listTrainingRuns(_opts?: { readonly agentId?: string; readonly limit?: number }): Promise<never> {
		this.predictorDeprecated();
	}
	async getTrainingPairsCount(): Promise<never> {
		this.predictorDeprecated();
	}
	async trainPredictor(_opts?: { readonly force?: boolean }): Promise<never> {
		this.predictorDeprecated();
	}
}

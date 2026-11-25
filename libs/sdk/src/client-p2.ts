import type { RequestControl } from "./transport.js";
import type { SignetTransport } from "./transport.js";
import type {
	AgentMessageAcknowledgeResponse,
	AgentWakeResponse,
	BoardThreadDetailResponse,
	BoardThreadListResponse,
	BoardThreadStatus,
	BoardTopicListResponse,
	BoardWriteResponse,
	BoardThread,
	AgentMessageListResponse,
	AgentMessageSendResponse,
	AgentPresenceContext,
	AgentPresenceListResponse,
	AgentSessionInspectResponse,
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
	async sessionStart(
		opts: {
			readonly sessionKey: string;
			readonly project?: string;
			readonly harness?: string;
			readonly runtimePath?: string;
		},
		control?: RequestControl,
	): Promise<SessionStartResponse> {
		return this.transport.post<SessionStartResponse>("/api/hooks/session-start", opts, control);
	}
	async userPromptSubmit(
		opts: {
			readonly sessionKey: string;
			readonly prompt: string;
			readonly project?: string;
		},
		control?: RequestControl,
	): Promise<UserPromptSubmitResponse> {
		return this.transport.post<UserPromptSubmitResponse>("/api/hooks/user-prompt-submit", opts, control);
	}
	async sessionEnd(
		opts: {
			readonly sessionKey: string;
			readonly harness: string;
			readonly project?: string;
			readonly transcriptPath?: string;
			readonly transcript?: string;
			readonly sessionId?: string;
			readonly agentId?: string;
			readonly capturedAt?: string;
			readonly reason?: string;
		},
		control?: RequestControl,
	): Promise<SessionEndResponse> {
		return this.transport.post<SessionEndResponse>("/api/hooks/session-end", opts, control);
	}

	sessionEndFireAndForget(
		opts: {
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
		},
		control?: RequestControl,
	): void {
		this.transport.post("/api/hooks/session-end", opts, control).catch(() => {});
	}
	async hookRemember(
		opts: {
			readonly content: string;
			readonly type?: string;
			readonly importance?: number;
			readonly tags?: string;
			readonly who?: string;
			readonly sessionKey?: string;
			readonly runtimePath?: string;
		},
		control?: RequestControl,
	): Promise<{ readonly id: string }> {
		return this.transport.post<{ readonly id: string }>("/api/hooks/remember", opts, control);
	}
	async rememberHook(
		opts: {
			readonly content: string;
			readonly type?: string;
			readonly importance?: number;
			readonly tags?: string;
			readonly who?: string;
			readonly sessionKey?: string;
			readonly runtimePath?: string;
		},
		control?: RequestControl,
	): Promise<{ readonly id: string }> {
		return this.hookRemember(opts, control);
	}
	async hookRecall(
		opts: {
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
		},
		control?: RequestControl,
	): Promise<HookRecallResponse> {
		return this.transport.post<HookRecallResponse>("/api/hooks/recall", opts, control);
	}
	async recallHook(
		opts: {
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
		},
		control?: RequestControl,
	): Promise<HookRecallResponse> {
		return this.hookRecall(opts, control);
	}
	async preCompaction(
		opts: {
			readonly sessionKey: string;
			readonly context: string;
			readonly project?: string;
		},
		control?: RequestControl,
	): Promise<PreCompactionResponse> {
		return this.transport.post<PreCompactionResponse>("/api/hooks/pre-compaction", opts, control);
	}
	async compactionComplete(
		opts: {
			readonly sessionKey: string;
			readonly summary: string;
			readonly project?: string;
		},
		control?: RequestControl,
	): Promise<CompactionCompleteResponse> {
		return this.transport.post<CompactionCompleteResponse>("/api/hooks/compaction-complete", opts, control);
	}
	async getSynthesisConfig(control?: RequestControl): Promise<SynthesisConfigResponse> {
		return this.transport.get<SynthesisConfigResponse>("/api/hooks/synthesis/config", undefined, control);
	}
	async requestSynthesis(
		opts?: {
			readonly project?: string;
			readonly force?: boolean;
		},
		control?: RequestControl,
	): Promise<SynthesisRequestResponse> {
		return this.transport.post<SynthesisRequestResponse>("/api/hooks/synthesis", opts ?? {}, control);
	}
	async listConnectors(control?: RequestControl): Promise<ConnectorListResponse> {
		return this.transport.get<ConnectorListResponse>("/api/connectors", undefined, control);
	}
	async createConnector(
		opts: {
			readonly provider: "filesystem" | "github-docs" | "gdrive";
			readonly displayName?: string;
			readonly settings?: Record<string, unknown>;
		},
		control?: RequestControl,
	): Promise<ConnectorCreateResponse> {
		return this.transport.post<ConnectorCreateResponse>("/api/connectors", opts, control);
	}
	async getConnector(id: string, control?: RequestControl): Promise<ConnectorRecord> {
		return this.transport.get<ConnectorRecord>(`/api/connectors/${id}`, undefined, control);
	}
	async syncConnector(id: string, control?: RequestControl): Promise<ConnectorSyncResponse> {
		return this.transport.post<ConnectorSyncResponse>(`/api/connectors/${id}/sync`, {}, control);
	}
	async resyncAllConnectors(control?: RequestControl): Promise<ConnectorResyncResponse> {
		return this.transport.post<ConnectorResyncResponse>("/api/connectors/resync", {}, control);
	}
	async fullSyncConnector(id: string, control?: RequestControl): Promise<ConnectorSyncResponse> {
		return this.transport.post<ConnectorSyncResponse>(`/api/connectors/${id}/sync/full?confirm=true`, {}, control);
	}
	async deleteConnector(
		id: string,
		opts?: { readonly cascade?: boolean },
		control?: RequestControl,
	): Promise<ConnectorDeleteResponse> {
		const cascade = opts?.cascade ? "?cascade=true" : "";
		return this.transport.del<ConnectorDeleteResponse>(`/api/connectors/${id}${cascade}`, {}, control);
	}
	async getConnectorHealth(id: string, control?: RequestControl): Promise<ConnectorHealthResponse> {
		return this.transport.get<ConnectorHealthResponse>(`/api/connectors/${id}/health`, undefined, control);
	}
	async getUsageCounters(control?: RequestControl): Promise<UsageCountersResponse> {
		return this.transport.get<UsageCountersResponse>("/api/analytics/usage", undefined, control);
	}
	async getErrors(
		opts?: {
			readonly stage?: string;
			readonly since?: string;
			readonly limit?: number;
		},
		control?: RequestControl,
	): Promise<ErrorsResponse> {
		return this.transport.get<ErrorsResponse>("/api/analytics/errors", opts, control);
	}
	async getLatency(control?: RequestControl): Promise<LatencyResponse> {
		return this.transport.get<LatencyResponse>("/api/analytics/latency", undefined, control);
	}
	async getAnalyticsLogs(
		opts?: {
			readonly limit?: number;
			readonly level?: "debug" | "info" | "warn" | "error";
			readonly category?: string;
			readonly since?: string;
		},
		control?: RequestControl,
	): Promise<LogsResponse> {
		return this.transport.get<LogsResponse>("/api/analytics/logs", opts, control);
	}
	async getMemorySafety(control?: RequestControl): Promise<MemorySafetyResponse> {
		return this.transport.get<MemorySafetyResponse>("/api/analytics/memory-safety", undefined, control);
	}
	async getContinuity(
		opts?: { readonly project?: string; readonly limit?: number },
		control?: RequestControl,
	): Promise<ContinuityResponse> {
		return this.transport.get<ContinuityResponse>("/api/analytics/continuity", opts, control);
	}
	async getLatestContinuity(control?: RequestControl): Promise<ContinuityLatestResponse> {
		return this.transport.get<ContinuityLatestResponse>("/api/analytics/continuity/latest", undefined, control);
	}
	async listKnowledgeEntities(
		opts?: {
			readonly agentId?: string;
			readonly type?: string;
			readonly query?: string;
			readonly limit?: number;
			readonly offset?: number;
		},
		control?: RequestControl,
	): Promise<KnowledgeEntityListResponse> {
		return this.transport.get<KnowledgeEntityListResponse>("/api/knowledge/entities", opts, control);
	}
	async pinEntity(
		id: string,
		opts?: { readonly agentId?: string },
		control?: RequestControl,
	): Promise<PinEntityResponse> {
		return this.transport.post<PinEntityResponse>(
			`/api/knowledge/entities/${id}/pin`,
			{},
			{ ...(opts ? { query: opts } : undefined), ...control },
		);
	}
	async unpinEntity(
		id: string,
		opts?: { readonly agentId?: string },
		control?: RequestControl,
	): Promise<UnpinEntityResponse> {
		const query = opts?.agentId ? `?agent_id=${opts.agentId}` : "";
		return this.transport.del<UnpinEntityResponse>(`/api/knowledge/entities/${id}/pin${query}`, {}, control);
	}
	async getPinnedEntities(
		opts?: { readonly agentId?: string },
		control?: RequestControl,
	): Promise<KnowledgeEntityListResponse> {
		return this.transport.get<KnowledgeEntityListResponse>("/api/knowledge/entities/pinned", opts, control);
	}
	async getEntityHealth(
		opts?: {
			readonly agentId?: string;
			readonly since?: string;
			readonly minComparisons?: number;
		},
		control?: RequestControl,
	): Promise<{ readonly entities: readonly unknown[] }> {
		return this.transport.get<{ readonly entities: readonly unknown[] }>(
			"/api/knowledge/entities/health",
			opts,
			control,
		);
	}
	async getKnowledgeEntity(
		id: string,
		opts?: { readonly agentId?: string },
		control?: RequestControl,
	): Promise<KnowledgeEntityDetail> {
		return this.transport.get<KnowledgeEntityDetail>(`/api/knowledge/entities/${id}`, opts, control);
	}
	async getEntityAspects(
		entityId: string,
		opts?: { readonly agentId?: string },
		control?: RequestControl,
	): Promise<EntityAspectsResponse> {
		return this.transport.get<EntityAspectsResponse>(`/api/knowledge/entities/${entityId}/aspects`, opts, control);
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
		control?: RequestControl,
	): Promise<AspectAttributesResponse> {
		return this.transport.get<AspectAttributesResponse>(
			`/api/knowledge/entities/${entityId}/aspects/${aspectId}/attributes`,
			opts,
			control,
		);
	}
	async getEntityDependencies(
		entityId: string,
		opts?: { readonly agentId?: string },
		control?: RequestControl,
	): Promise<EntityDependenciesResponse> {
		return this.transport.get<EntityDependenciesResponse>(
			`/api/knowledge/entities/${entityId}/dependencies`,
			opts,
			control,
		);
	}
	async getKnowledgeStats(control?: RequestControl): Promise<KnowledgeStatsResponse> {
		return this.transport.get<KnowledgeStatsResponse>("/api/knowledge/stats", undefined, control);
	}
	async getTraversalStatus(control?: RequestControl): Promise<TraversalStatusResponse> {
		return this.transport.get<TraversalStatusResponse>("/api/knowledge/traversal/status", undefined, control);
	}
	async getConstellation(control?: RequestControl): Promise<ConstellationResponse> {
		return this.transport.get<ConstellationResponse>("/api/knowledge/constellation", undefined, control);
	}
	async requeueDeadJobs(control?: RequestControl): Promise<RepairActionResponse> {
		return this.transport.post<RepairActionResponse>("/api/repair/requeue-dead", {}, control);
	}
	async releaseStaleLeases(control?: RequestControl): Promise<RepairActionResponse> {
		return this.transport.post<RepairActionResponse>("/api/repair/release-leases", {}, control);
	}
	async checkFts(opts?: { readonly repair?: boolean }, control?: RequestControl): Promise<RepairActionResponse> {
		return this.transport.post<RepairActionResponse>("/api/repair/check-fts", opts ?? {}, control);
	}
	async triggerRetentionSweep(control?: RequestControl): Promise<RepairActionResponse> {
		return this.transport.post<RepairActionResponse>("/api/repair/retention-sweep", {}, control);
	}
	async getEmbeddingGaps(control?: RequestControl): Promise<EmbeddingGapsResponse> {
		return this.transport.get<EmbeddingGapsResponse>("/api/repair/embedding-gaps", undefined, control);
	}
	async reembedMissing(opts?: { readonly limit?: number }, control?: RequestControl): Promise<RepairActionResponse> {
		return this.transport.post<RepairActionResponse>("/api/repair/re-embed", opts ?? {}, control);
	}
	async resyncVectorIndex(opts?: VectorRepairOptions, control?: RequestControl): Promise<VectorRepairResponse> {
		return this.transport.post<VectorRepairResponse>("/api/repair/resync-vec", opts ?? {}, control);
	}
	async cleanOrphanedEmbeddings(opts?: VectorRepairOptions, control?: RequestControl): Promise<VectorRepairResponse> {
		return this.transport.post<VectorRepairResponse>("/api/repair/clean-orphans", opts ?? {}, control);
	}
	async getDedupStats(control?: RequestControl): Promise<DedupStatsResponse> {
		return this.transport.get<DedupStatsResponse>("/api/repair/dedup-stats", undefined, control);
	}
	async deduplicateMemories(
		opts?: { readonly dryRun?: boolean },
		control?: RequestControl,
	): Promise<DeduplicateResponse> {
		return this.transport.post<DeduplicateResponse>("/api/repair/deduplicate", opts ?? {}, control);
	}
	async pruneChunkGroups(control?: RequestControl): Promise<RepairActionResponse> {
		return this.transport.post<RepairActionResponse>("/api/repair/prune-chunk-groups", {}, control);
	}
	async pruneSingletonEntities(
		opts?: { readonly minMentions?: number },
		control?: RequestControl,
	): Promise<RepairActionResponse> {
		return this.transport.post<RepairActionResponse>("/api/repair/prune-singleton-entities", opts ?? {}, control);
	}
	async listAgentPresence(
		opts?: {
			readonly agentId?: string;
			readonly sessionKey?: string;
			readonly project?: string;
			readonly includeSelf?: boolean;
			readonly limit?: number;
			readonly scope?: "all";
		},
		control?: RequestControl,
	): Promise<AgentPresenceListResponse> {
		return this.transport.get<AgentPresenceListResponse>(
			"/api/cross-agent/presence",
			{
				agent_id: opts?.agentId,
				session_key: opts?.sessionKey,
				project: opts?.project,
				include_self: opts?.includeSelf,
				limit: opts?.limit,
				scope: opts?.scope,
			},
			control,
		);
	}
	async updateAgentPresence(
		opts: {
			readonly harness?: string;
			readonly runtimePath?: "plugin" | "legacy";
			readonly agentId?: string;
			readonly sessionKey?: string;
			readonly project?: string;
			readonly provider?: string;
			readonly context?: AgentPresenceContext;
		},
		control?: RequestControl,
	): Promise<AgentPresenceUpdateResponse> {
		return this.transport.post<AgentPresenceUpdateResponse>("/api/cross-agent/presence", opts, control);
	}
	async updateAgentContext(
		opts: {
			readonly sessionKey: string;
			readonly context: AgentPresenceContext;
			readonly agentId?: string;
			readonly harness?: string;
		},
		control?: RequestControl,
	): Promise<AgentPresenceUpdateResponse> {
		return this.transport.post<AgentPresenceUpdateResponse>("/api/cross-agent/presence", opts, control);
	}
	async inspectAgentSession(
		sessionKey: string,
		opts?: {
			readonly sessionAgentId?: string;
			readonly agentId?: string;
			readonly callerSessionKey?: string;
			readonly maxMessages?: number;
			readonly scope?: "all";
		},
		control?: RequestControl,
	): Promise<AgentSessionInspectResponse> {
		return this.transport.get<AgentSessionInspectResponse>(
			`/api/cross-agent/sessions/${encodeURIComponent(sessionKey)}/context`,
			{
				target_agent_id: opts?.sessionAgentId,
				agent_id: opts?.agentId,
				caller_session_key: opts?.callerSessionKey,
				max_messages: opts?.maxMessages,
				scope: opts?.scope,
			},
			control,
		);
	}
	async removeAgentPresence(sessionKey: string, control?: RequestControl): Promise<{ readonly removed: boolean }> {
		return this.transport.del<{ readonly removed: boolean }>(`/api/cross-agent/presence/${sessionKey}`, {}, control);
	}
	async listAgentMessages(
		opts?: {
			readonly scope?: "all";
			readonly agentId?: string;
			readonly sessionKey?: string;
			readonly since?: string;
			readonly limit?: number;
			readonly offset?: number;
			readonly unreadOnly?: boolean;
			readonly includeSent?: boolean;
			readonly includeBroadcast?: boolean;
		},
		control?: RequestControl,
	): Promise<AgentMessageListResponse> {
		return this.transport.get<AgentMessageListResponse>(
			"/api/cross-agent/messages",
			{
				scope: opts?.scope,
				agent_id: opts?.agentId,
				session_key: opts?.sessionKey,
				since: opts?.since,
				limit: opts?.limit,
				offset: opts?.offset,
				unread_only: opts?.unreadOnly,
				include_sent: opts?.includeSent,
				include_broadcast: opts?.includeBroadcast,
			},
			control,
		);
	}
	async sendAgentMessage(
		opts: {
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
		},
		control?: RequestControl,
	): Promise<AgentMessageSendResponse> {
		return this.transport.post<AgentMessageSendResponse>("/api/cross-agent/messages", opts, control);
	}
	async acknowledgeAgentMessage(
		messageId: string,
		opts?: { readonly agentId?: string; readonly sessionKey?: string },
		control?: RequestControl,
	): Promise<AgentMessageAcknowledgeResponse> {
		return this.transport.post<AgentMessageAcknowledgeResponse>(
			`/api/cross-agent/messages/${encodeURIComponent(messageId)}/ack`,
			opts ?? {},
			control,
		);
	}
	async retryAgentMessage(
		messageId: string,
		opts?: { readonly agentId?: string },
		control?: RequestControl,
	): Promise<AgentMessageSendResponse> {
		return this.transport.post<AgentMessageSendResponse>(
			`/api/cross-agent/messages/${encodeURIComponent(messageId)}/retry`,
			opts ?? {},
			control,
		);
	}
	async waitForAgentWake(
		opts: {
			readonly harness: string;
			readonly sessionKey: string;
			readonly agentId?: string;
			readonly project?: string;
			readonly waitMs?: number;
		},
		control?: RequestControl,
	): Promise<AgentWakeResponse> {
		const waitMs = Math.max(0, Math.min(25_000, opts.waitMs ?? 25_000));
		return this.transport.request<AgentWakeResponse>("POST", "/api/cross-agent/wake", {
			...{
				body: { ...opts, waitMs },
				timeoutMs: waitMs + 10_000,
			},
			...control,
		});
	}
	async listBoardTopics(
		opts?: { readonly agentId?: string; readonly scope?: "all" },
		control?: RequestControl,
	): Promise<BoardTopicListResponse> {
		return this.transport.get<BoardTopicListResponse>(
			"/api/board/topics",
			{
				agent_id: opts?.agentId,
				scope: opts?.scope,
			},
			control,
		);
	}
	async listBoardThreads(
		opts?: {
			readonly agentId?: string;
			readonly scope?: "all";
			readonly topic?: string;
			readonly tag?: string;
			readonly status?: BoardThreadStatus | "all";
			readonly limit?: number;
			readonly offset?: number;
		},
		control?: RequestControl,
	): Promise<BoardThreadListResponse> {
		return this.transport.get<BoardThreadListResponse>(
			"/api/board/threads",
			{
				agent_id: opts?.agentId,
				scope: opts?.scope,
				topic: opts?.topic,
				tag: opts?.tag,
				status: opts?.status,
				limit: opts?.limit,
				offset: opts?.offset,
			},
			control,
		);
	}
	async getBoardThread(
		threadId: string,
		opts?: { readonly agentId?: string; readonly scope?: "all"; readonly limit?: number; readonly offset?: number },
		control?: RequestControl,
	): Promise<BoardThreadDetailResponse> {
		return this.transport.get<BoardThreadDetailResponse>(
			`/api/board/threads/${encodeURIComponent(threadId)}`,
			{
				agent_id: opts?.agentId,
				scope: opts?.scope,
				limit: opts?.limit,
				offset: opts?.offset,
			},
			control,
		);
	}
	async createBoardThread(
		opts: {
			readonly topic: string;
			readonly title?: string;
			readonly body?: string;
			readonly tags?: readonly string[];
			readonly fromMessageId?: string;
			readonly agentId?: string;
			readonly sessionKey?: string;
			readonly harness?: string;
		},
		control?: RequestControl,
	): Promise<BoardWriteResponse> {
		return this.transport.post<BoardWriteResponse>("/api/board/threads", opts, control);
	}
	async replyToBoardThread(
		threadId: string,
		opts: {
			readonly body: string;
			readonly replyToPostId?: string;
			readonly agentId?: string;
			readonly sessionKey?: string;
			readonly harness?: string;
		},
		control?: RequestControl,
	): Promise<BoardWriteResponse> {
		return this.transport.post<BoardWriteResponse>(
			`/api/board/threads/${encodeURIComponent(threadId)}/posts`,
			opts,
			control,
		);
	}
	async updateBoardThread(
		threadId: string,
		opts: {
			readonly status?: BoardThreadStatus;
			readonly pinned?: boolean;
			readonly title?: string;
			readonly tags?: readonly string[];
			readonly agentId?: string;
			readonly scope?: "all";
		},
		control?: RequestControl,
	): Promise<{ readonly thread: BoardThread }> {
		return this.transport.patch<{ readonly thread: BoardThread }>(
			`/api/board/threads/${encodeURIComponent(threadId)}`,
			opts,
			control,
		);
	}
	async markBoardThreadRead(
		threadId: string,
		opts?: { readonly agentId?: string; readonly throughPostId?: string; readonly through?: string },
		control?: RequestControl,
	): Promise<{ readonly threadId: string; readonly lastReadAt: string; readonly lastReadPostId: string | null }> {
		return this.transport.post<{
			readonly threadId: string;
			readonly lastReadAt: string;
			readonly lastReadPostId: string | null;
		}>(`/api/board/threads/${encodeURIComponent(threadId)}/read`, opts ?? {}, control);
	}
	async deleteBoardThread(
		threadId: string,
		control?: RequestControl,
	): Promise<{ readonly threadId: string; readonly deletedPosts: number }> {
		return this.transport.del<{ readonly threadId: string; readonly deletedPosts: number }>(
			`/api/board/threads/${encodeURIComponent(threadId)}`,
			{ scope: "all" },
			control,
		);
	}

	private predictorDeprecated(): never {
		throw new Error(
			"Signet predictor APIs were removed in v0.112. Use memory search telemetry and pipeline diagnostics instead.",
		);
	}
	async getPredictorStatus(_control?: RequestControl): Promise<never> {
		this.predictorDeprecated();
	}
	async getComparisonsByProject(_project: string, _control?: RequestControl): Promise<never> {
		this.predictorDeprecated();
	}
	async getComparisonsByEntity(_entityId: string, _control?: RequestControl): Promise<never> {
		this.predictorDeprecated();
	}
	async listComparisons(
		_opts?: {
			readonly limit?: number;
			readonly offset?: number;
			readonly agentId?: string;
		},
		_control?: RequestControl,
	): Promise<never> {
		this.predictorDeprecated();
	}
	async listTrainingRuns(
		_opts?: { readonly agentId?: string; readonly limit?: number },
		_control?: RequestControl,
	): Promise<never> {
		this.predictorDeprecated();
	}
	async getTrainingPairsCount(_control?: RequestControl): Promise<never> {
		this.predictorDeprecated();
	}
	async trainPredictor(_opts?: { readonly force?: boolean }, _control?: RequestControl): Promise<never> {
		this.predictorDeprecated();
	}
}

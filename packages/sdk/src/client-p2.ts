/**
 * P2 domain methods for SignetClient.
 * This file will be merged into index.ts
 */

import type { SignetTransport } from "./transport.js";
import type {
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
	ConnectorListResponse,
	ConnectorRecord,
	ConnectorCreateResponse,
	ConnectorSyncResponse,
	ConnectorResyncResponse,
	ConnectorDeleteResponse,
	ConnectorHealthResponse,
	// Analytics
	UsageCountersResponse,
	ErrorsResponse,
	LatencyResponse,
	LogsResponse,
	MemorySafetyResponse,
	ContinuityResponse,
	ContinuityLatestResponse,
	// Knowledge Graph
	KnowledgeEntityListResponse,
	KnowledgeEntityDetail,
	PinEntityResponse,
	UnpinEntityResponse,
	EntityAspectsResponse,
	AspectAttributesResponse,
	EntityDependenciesResponse,
	KnowledgeStatsResponse,
	TraversalStatusResponse,
	ConstellationResponse,
	// Repair
	RepairActionResponse,
	EmbeddingGapsResponse,
	DedupStatsResponse,
	DeduplicateResponse,
	// Cross-Agent
	AgentPresenceListResponse,
	AgentPresenceUpdateResponse,
	AgentMessageListResponse,
	AgentMessageSendResponse,
	// Predictor
	PredictorStatusResponse,
	ComparisonsByProjectResponse,
	ComparisonsByEntityResponse,
	ComparisonsListResponse,
	TrainingRunsResponse,
	TrainingPairsCountResponse,
	TrainPredictorResponse,
} from "./types-p2.js";

// ============================================================================
// Hooks API (10 methods)
// ============================================================================

export class SignetClientP2 {
	constructor(private readonly transport: SignetTransport) {}

	// --- Hooks ---

	/**
	 * @example
	 * const result = await client.sessionStart({
	 *   sessionKey: 'sess-123',
	 *   project: 'my-project'
	 * });
	 */
	async sessionStart(opts: {
		readonly sessionKey: string;
		readonly project?: string;
		readonly harness?: string;
		readonly runtimePath?: string;
	}): Promise<SessionStartResponse> {
		return this.transport.post<SessionStartResponse>("/api/hooks/session-start", opts);
	}

	/**
	 * @example
	 * const result = await client.userPromptSubmit({
	 *   sessionKey: 'sess-123',
	 *   prompt: 'Help me with...'
	 * });
	 */
	async userPromptSubmit(opts: {
		readonly sessionKey: string;
		readonly prompt: string;
		readonly project?: string;
	}): Promise<UserPromptSubmitResponse> {
		return this.transport.post<UserPromptSubmitResponse>("/api/hooks/user-prompt-submit", opts);
	}

	/**
	 * @example
	 * const result = await client.sessionEnd({
	 *   sessionKey: 'sess-123',
	 *   summary: 'Completed task X'
	 * });
	 */
	async sessionEnd(opts: {
		readonly sessionKey: string;
		readonly summary?: string;
		readonly project?: string;
	}): Promise<SessionEndResponse> {
		return this.transport.post<SessionEndResponse>("/api/hooks/session-end", opts);
	}

	/**
	 * @example
	 * const result = await client.hookRemember({
	 *   content: 'User prefers dark mode',
	 *   type: 'preference'
	 * });
	 */
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

	/**
	 * @example
	 * const result = await client.hookRecall({
	 *   query: 'dark mode preferences'
	 * });
	 */
	async hookRecall(opts: {
		readonly query: string;
		readonly limit?: number;
		readonly type?: string;
		readonly tags?: string;
	}): Promise<{ readonly results: readonly unknown[] }> {
		return this.transport.post<{ readonly results: readonly unknown[] }>("/api/hooks/recall", opts);
	}

	/**
	 * @example
	 * const result = await client.preCompaction({
	 *   sessionKey: 'sess-123',
	 *   context: 'Current conversation about...'
	 * });
	 */
	async preCompaction(opts: {
		readonly sessionKey: string;
		readonly context: string;
		readonly project?: string;
	}): Promise<PreCompactionResponse> {
		return this.transport.post<PreCompactionResponse>("/api/hooks/pre-compaction", opts);
	}

	/**
	 * @example
	 * const result = await client.compactionComplete({
	 *   sessionKey: 'sess-123',
	 *   summary: 'Discussed X, Y, Z'
	 * });
	 */
	async compactionComplete(opts: {
		readonly sessionKey: string;
		readonly summary: string;
		readonly project?: string;
	}): Promise<CompactionCompleteResponse> {
		return this.transport.post<CompactionCompleteResponse>("/api/hooks/compaction-complete", opts);
	}

	/**
	 * @example
	 * const config = await client.getSynthesisConfig();
	 */
	async getSynthesisConfig(): Promise<SynthesisConfigResponse> {
		return this.transport.get<SynthesisConfigResponse>("/api/hooks/synthesis/config");
	}

	/**
	 * @example
	 * const result = await client.requestSynthesis({
	 *   project: 'my-project'
	 * });
	 */
	async requestSynthesis(opts?: {
		readonly project?: string;
		readonly force?: boolean;
	}): Promise<SynthesisRequestResponse> {
		return this.transport.post<SynthesisRequestResponse>("/api/hooks/synthesis", opts ?? {});
	}

	/**
	 * @example
	 * const result = await client.synthesisComplete({
	 *   content: '# MEMORY.md\n...'
	 * });
	 */
	async synthesisComplete(opts: {
		readonly content: string;
		readonly project?: string;
	}): Promise<SynthesisCompleteResponse> {
		return this.transport.post<SynthesisCompleteResponse>("/api/hooks/synthesis/complete", opts);
	}

	// --- Connectors ---

	/**
	 * @example
	 * const { connectors } = await client.listConnectors();
	 */
	async listConnectors(): Promise<ConnectorListResponse> {
		return this.transport.get<ConnectorListResponse>("/api/connectors");
	}

	/**
	 * @example
	 * const { id } = await client.createConnector({
	 *   provider: 'filesystem',
	 *   displayName: 'My Docs',
	 *   settings: { rootPath: '/path/to/docs' }
	 * });
	 */
	async createConnector(opts: {
		readonly provider: "filesystem" | "github-docs" | "gdrive";
		readonly displayName?: string;
		readonly settings?: Record<string, unknown>;
	}): Promise<ConnectorCreateResponse> {
		return this.transport.post<ConnectorCreateResponse>("/api/connectors", opts);
	}

	/**
	 * @example
	 * const connector = await client.getConnector('conn-123');
	 */
	async getConnector(id: string): Promise<ConnectorRecord> {
		return this.transport.get<ConnectorRecord>(`/api/connectors/${id}`);
	}

	/**
	 * @example
	 * const result = await client.syncConnector('conn-123');
	 */
	async syncConnector(id: string): Promise<ConnectorSyncResponse> {
		return this.transport.post<ConnectorSyncResponse>(`/api/connectors/${id}/sync`, {});
	}

	/**
	 * @example
	 * const result = await client.resyncAllConnectors();
	 */
	async resyncAllConnectors(): Promise<ConnectorResyncResponse> {
		return this.transport.post<ConnectorResyncResponse>("/api/connectors/resync", {});
	}

	/**
	 * @example
	 * const result = await client.fullSyncConnector('conn-123');
	 */
	async fullSyncConnector(id: string): Promise<ConnectorSyncResponse> {
		return this.transport.post<ConnectorSyncResponse>(`/api/connectors/${id}/sync/full?confirm=true`, {});
	}

	/**
	 * @example
	 * const { deleted } = await client.deleteConnector('conn-123', { cascade: true });
	 */
	async deleteConnector(id: string, opts?: { readonly cascade?: boolean }): Promise<ConnectorDeleteResponse> {
		const cascade = opts?.cascade ? "?cascade=true" : "";
		return this.transport.del<ConnectorDeleteResponse>(`/api/connectors/${id}${cascade}`, {});
	}

	/**
	 * @example
	 * const health = await client.getConnectorHealth('conn-123');
	 */
	async getConnectorHealth(id: string): Promise<ConnectorHealthResponse> {
		return this.transport.get<ConnectorHealthResponse>(`/api/connectors/${id}/health`);
	}

	// --- Analytics ---

	/**
	 * @example
	 * const usage = await client.getUsageCounters();
	 */
	async getUsageCounters(): Promise<UsageCountersResponse> {
		return this.transport.get<UsageCountersResponse>("/api/analytics/usage");
	}

	/**
	 * @example
	 * const { errors, summary } = await client.getErrors({ stage: 'mutation', limit: 50 });
	 */
	async getErrors(opts?: {
		readonly stage?: string;
		readonly since?: string;
		readonly limit?: number;
	}): Promise<ErrorsResponse> {
		return this.transport.get<ErrorsResponse>("/api/analytics/errors", opts);
	}

	/**
	 * @example
	 * const latency = await client.getLatency();
	 */
	async getLatency(): Promise<LatencyResponse> {
		return this.transport.get<LatencyResponse>("/api/analytics/latency");
	}

	/**
	 * @example
	 * const { logs, count } = await client.getAnalyticsLogs({ level: 'error', limit: 100 });
	 */
	async getAnalyticsLogs(opts?: {
		readonly limit?: number;
		readonly level?: "debug" | "info" | "warn" | "error";
		readonly category?: string;
		readonly since?: string;
	}): Promise<LogsResponse> {
		return this.transport.get<LogsResponse>("/api/analytics/logs", opts);
	}

	/**
	 * @example
	 * const safety = await client.getMemorySafety();
	 */
	async getMemorySafety(): Promise<MemorySafetyResponse> {
		return this.transport.get<MemorySafetyResponse>("/api/analytics/memory-safety");
	}

	/**
	 * @example
	 * const { scores, summary } = await client.getContinuity({ project: 'my-project', limit: 50 });
	 */
	async getContinuity(opts?: {
		readonly project?: string;
		readonly limit?: number;
	}): Promise<ContinuityResponse> {
		return this.transport.get<ContinuityResponse>("/api/analytics/continuity", opts);
	}

	/**
	 * @example
	 * const { scores } = await client.getLatestContinuity();
	 */
	async getLatestContinuity(): Promise<ContinuityLatestResponse> {
		return this.transport.get<ContinuityLatestResponse>("/api/analytics/continuity/latest");
	}

	// --- Knowledge Graph ---

	/**
	 * @example
	 * const { items } = await client.listKnowledgeEntities({ type: 'person', limit: 50 });
	 */
	async listKnowledgeEntities(opts?: {
		readonly agentId?: string;
		readonly type?: string;
		readonly query?: string;
		readonly limit?: number;
		readonly offset?: number;
	}): Promise<KnowledgeEntityListResponse> {
		return this.transport.get<KnowledgeEntityListResponse>("/api/knowledge/entities", opts);
	}

	/**
	 * @example
	 * const { pinned, pinnedAt } = await client.pinEntity('entity-123');
	 */
	async pinEntity(id: string, opts?: { readonly agentId?: string }): Promise<PinEntityResponse> {
		return this.transport.post<PinEntityResponse>(
			`/api/knowledge/entities/${id}/pin`,
			{},
			opts ? { query: opts } : undefined,
		);
	}

	/**
	 * @example
	 * const { pinned } = await client.unpinEntity('entity-123');
	 */
	async unpinEntity(id: string, opts?: { readonly agentId?: string }): Promise<UnpinEntityResponse> {
		const query = opts?.agentId ? `?agent_id=${opts.agentId}` : "";
		return this.transport.del<UnpinEntityResponse>(`/api/knowledge/entities/${id}/pin${query}`, {});
	}

	/**
	 * @example
	 * const entities = await client.getPinnedEntities();
	 */
	async getPinnedEntities(opts?: {
		readonly agentId?: string;
	}): Promise<KnowledgeEntityListResponse> {
		return this.transport.get<KnowledgeEntityListResponse>("/api/knowledge/entities/pinned", opts);
	}

	/**
	 * @example
	 * const health = await client.getEntityHealth({ minComparisons: 3 });
	 */
	async getEntityHealth(opts?: {
		readonly agentId?: string;
		readonly since?: string;
		readonly minComparisons?: number;
	}): Promise<{ readonly entities: readonly unknown[] }> {
		return this.transport.get<{ readonly entities: readonly unknown[] }>("/api/knowledge/entities/health", opts);
	}

	/**
	 * @example
	 * const entity = await client.getKnowledgeEntity('entity-123');
	 */
	async getKnowledgeEntity(id: string, opts?: { readonly agentId?: string }): Promise<KnowledgeEntityDetail> {
		return this.transport.get<KnowledgeEntityDetail>(`/api/knowledge/entities/${id}`, opts);
	}

	/**
	 * @example
	 * const { items } = await client.getEntityAspects('entity-123');
	 */
	async getEntityAspects(entityId: string, opts?: { readonly agentId?: string }): Promise<EntityAspectsResponse> {
		return this.transport.get<EntityAspectsResponse>(`/api/knowledge/entities/${entityId}/aspects`, opts);
	}

	/**
	 * @example
	 * const { items } = await client.getAspectAttributes('entity-123', 'aspect-456', { kind: 'attribute' });
	 */
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

	/**
	 * @example
	 * const { dependencies } = await client.getEntityDependencies('entity-123');
	 */
	async getEntityDependencies(
		entityId: string,
		opts?: { readonly agentId?: string },
	): Promise<EntityDependenciesResponse> {
		return this.transport.get<EntityDependenciesResponse>(`/api/knowledge/entities/${entityId}/dependencies`, opts);
	}

	/**
	 * @example
	 * const stats = await client.getKnowledgeStats();
	 */
	async getKnowledgeStats(): Promise<KnowledgeStatsResponse> {
		return this.transport.get<KnowledgeStatsResponse>("/api/knowledge/stats");
	}

	/**
	 * @example
	 * const status = await client.getTraversalStatus();
	 */
	async getTraversalStatus(): Promise<TraversalStatusResponse> {
		return this.transport.get<TraversalStatusResponse>("/api/knowledge/traversal/status");
	}

	/**
	 * @example
	 * const constellation = await client.getConstellation();
	 */
	async getConstellation(): Promise<ConstellationResponse> {
		return this.transport.get<ConstellationResponse>("/api/knowledge/constellation");
	}

	// --- Repair ---

	/**
	 * @example
	 * const result = await client.requeueDeadJobs();
	 */
	async requeueDeadJobs(): Promise<RepairActionResponse> {
		return this.transport.post<RepairActionResponse>("/api/repair/requeue-dead", {});
	}

	/**
	 * @example
	 * const result = await client.releaseStaleLeases();
	 */
	async releaseStaleLeases(): Promise<RepairActionResponse> {
		return this.transport.post<RepairActionResponse>("/api/repair/release-leases", {});
	}

	/**
	 * @example
	 * const result = await client.checkFts({ repair: true });
	 */
	async checkFts(opts?: { readonly repair?: boolean }): Promise<RepairActionResponse> {
		return this.transport.post<RepairActionResponse>("/api/repair/check-fts", opts ?? {});
	}

	/**
	 * @example
	 * const result = await client.triggerRetentionSweep();
	 */
	async triggerRetentionSweep(): Promise<RepairActionResponse> {
		return this.transport.post<RepairActionResponse>("/api/repair/retention-sweep", {});
	}

	/**
	 * @example
	 * const gaps = await client.getEmbeddingGaps();
	 */
	async getEmbeddingGaps(): Promise<EmbeddingGapsResponse> {
		return this.transport.get<EmbeddingGapsResponse>("/api/repair/embedding-gaps");
	}

	/**
	 * @example
	 * const result = await client.reembedMissing({ limit: 100 });
	 */
	async reembedMissing(opts?: {
		readonly limit?: number;
	}): Promise<RepairActionResponse> {
		return this.transport.post<RepairActionResponse>("/api/repair/re-embed", opts ?? {});
	}

	/**
	 * @example
	 * const result = await client.resyncVectorIndex();
	 */
	async resyncVectorIndex(): Promise<RepairActionResponse> {
		return this.transport.post<RepairActionResponse>("/api/repair/resync-vec", {});
	}

	/**
	 * @example
	 * const result = await client.cleanOrphanedEmbeddings();
	 */
	async cleanOrphanedEmbeddings(): Promise<RepairActionResponse> {
		return this.transport.post<RepairActionResponse>("/api/repair/clean-orphans", {});
	}

	/**
	 * @example
	 * const stats = await client.getDedupStats();
	 */
	async getDedupStats(): Promise<DedupStatsResponse> {
		return this.transport.get<DedupStatsResponse>("/api/repair/dedup-stats");
	}

	/**
	 * @example
	 * const result = await client.deduplicateMemories({ dryRun: false });
	 */
	async deduplicateMemories(opts?: {
		readonly dryRun?: boolean;
	}): Promise<DeduplicateResponse> {
		return this.transport.post<DeduplicateResponse>("/api/repair/deduplicate", opts ?? {});
	}

	/**
	 * @example
	 * const result = await client.reclassifyEntities();
	 */
	async reclassifyEntities(): Promise<RepairActionResponse> {
		return this.transport.post<RepairActionResponse>("/api/repair/reclassify-entities", {});
	}

	/**
	 * @example
	 * const result = await client.pruneChunkGroups();
	 */
	async pruneChunkGroups(): Promise<RepairActionResponse> {
		return this.transport.post<RepairActionResponse>("/api/repair/prune-chunk-groups", {});
	}

	/**
	 * @example
	 * const result = await client.pruneSingletonEntities({ minMentions: 2 });
	 */
	async pruneSingletonEntities(opts?: {
		readonly minMentions?: number;
	}): Promise<RepairActionResponse> {
		return this.transport.post<RepairActionResponse>("/api/repair/prune-singleton-entities", opts ?? {});
	}

	/**
	 * @example
	 * const result = await client.structuralBackfill();
	 */
	async structuralBackfill(): Promise<RepairActionResponse> {
		return this.transport.post<RepairActionResponse>("/api/repair/structural-backfill", {});
	}

	// --- Cross-Agent ---

	/**
	 * @example
	 * const { sessions, count } = await client.listAgentPresence({ project: 'my-project' });
	 */
	async listAgentPresence(opts?: {
		readonly agentId?: string;
		readonly sessionKey?: string;
		readonly project?: string;
		readonly includeSelf?: boolean;
		readonly limit?: number;
	}): Promise<AgentPresenceListResponse> {
		return this.transport.get<AgentPresenceListResponse>("/api/cross-agent/presence", opts);
	}

	/**
	 * @example
	 * const result = await client.updateAgentPresence({
	 *   harness: 'claude-code',
	 *   runtimePath: 'plugin',
	 *   project: 'my-project'
	 * });
	 */
	async updateAgentPresence(opts: {
		readonly harness: string;
		readonly runtimePath?: "plugin" | "legacy";
		readonly agentId?: string;
		readonly sessionKey?: string;
		readonly project?: string;
	}): Promise<AgentPresenceUpdateResponse> {
		return this.transport.post<AgentPresenceUpdateResponse>("/api/cross-agent/presence", opts);
	}

	/**
	 * @example
	 * await client.removeAgentPresence('sess-123');
	 */
	async removeAgentPresence(sessionKey: string): Promise<{ readonly removed: boolean }> {
		return this.transport.del<{ readonly removed: boolean }>(`/api/cross-agent/presence/${sessionKey}`, {});
	}

	/**
	 * @example
	 * const { messages, count } = await client.listAgentMessages({ limit: 50 });
	 */
	async listAgentMessages(opts?: {
		readonly agentId?: string;
		readonly sessionKey?: string;
		readonly since?: string;
		readonly limit?: number;
		readonly includeSent?: boolean;
		readonly includeBroadcast?: boolean;
	}): Promise<AgentMessageListResponse> {
		return this.transport.get<AgentMessageListResponse>("/api/cross-agent/messages", opts);
	}

	/**
	 * @example
	 * const { id } = await client.sendAgentMessage({
	 *   toAgentId: 'agent-456',
	 *   type: 'assist_request',
	 *   content: 'Need help with...'
	 * });
	 */
	async sendAgentMessage(opts: {
		readonly toAgentId?: string;
		readonly toSessionKey?: string;
		readonly type: "assist_request" | "decision_update" | "info" | "question";
		readonly content: string;
		readonly broadcast?: boolean;
		readonly via?: "local" | "acp";
	}): Promise<AgentMessageSendResponse> {
		return this.transport.post<AgentMessageSendResponse>("/api/cross-agent/messages", opts);
	}

	// --- Predictor ---

	/**
	 * @example
	 * const status = await client.getPredictorStatus();
	 */
	async getPredictorStatus(): Promise<PredictorStatusResponse> {
		return this.transport.get<PredictorStatusResponse>("/api/predictor/status");
	}

	/**
	 * @example
	 * const { comparisons, count } = await client.getComparisonsByProject('my-project');
	 */
	async getComparisonsByProject(project: string): Promise<ComparisonsByProjectResponse> {
		return this.transport.get<ComparisonsByProjectResponse>("/api/predictor/comparisons/by-project", { project });
	}

	/**
	 * @example
	 * const { comparisons, count } = await client.getComparisonsByEntity('entity-123');
	 */
	async getComparisonsByEntity(entityId: string): Promise<ComparisonsByEntityResponse> {
		return this.transport.get<ComparisonsByEntityResponse>("/api/predictor/comparisons/by-entity", {
			entity_id: entityId,
		});
	}

	/**
	 * @example
	 * const { comparisons, total } = await client.listComparisons({ limit: 50, offset: 0 });
	 */
	async listComparisons(opts?: {
		readonly limit?: number;
		readonly offset?: number;
		readonly agentId?: string;
	}): Promise<ComparisonsListResponse> {
		return this.transport.get<ComparisonsListResponse>("/api/predictor/comparisons", opts);
	}

	/**
	 * @example
	 * const { runs, count } = await client.listTrainingRuns();
	 */
	async listTrainingRuns(opts?: {
		readonly agentId?: string;
		readonly limit?: number;
	}): Promise<TrainingRunsResponse> {
		return this.transport.get<TrainingRunsResponse>("/api/predictor/training", opts);
	}

	/**
	 * @example
	 * const { count } = await client.getTrainingPairsCount();
	 */
	async getTrainingPairsCount(): Promise<TrainingPairsCountResponse> {
		return this.transport.get<TrainingPairsCountResponse>("/api/predictor/training-pairs-count");
	}

	/**
	 * @example
	 * const result = await client.trainPredictor({ force: false });
	 */
	async trainPredictor(opts?: {
		readonly force?: boolean;
	}): Promise<TrainPredictorResponse> {
		return this.transport.post<TrainPredictorResponse>("/api/predictor/train", opts ?? {});
	}
}

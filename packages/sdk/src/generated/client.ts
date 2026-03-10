/**
 * AUTO-GENERATED FILE — DO NOT EDIT
 * Generated from daemon.ts routes by scripts/generate-client.ts
 *
 * This file provides broad coverage of daemon endpoints.
 * Manual helpers live in ../helpers.ts
 */

export class GeneratedClient {
	constructor(
		private readonly transport: {
			readonly get: <T>(path: string, query?: Record<string, unknown>) => Promise<T>;
			readonly post: <T>(path: string, body?: unknown) => Promise<T>;
			readonly put: <T>(path: string, body?: unknown) => Promise<T>;
			readonly patch: <T>(path: string, body?: unknown) => Promise<T>;
			readonly del: <T>(path: string, query?: Record<string, unknown>) => Promise<T>;
		},
	) {}

	async getHealth(query?: Record<string, unknown>): Promise<unknown> {
		return this.transport.get<unknown>("/health", query);
	}

	async getApiFeatures(query?: Record<string, unknown>): Promise<unknown> {
		return this.transport.get<unknown>("/api/features", query);
	}

	async getApiAuthWhoami(query?: Record<string, unknown>): Promise<unknown> {
		return this.transport.get<unknown>("/api/auth/whoami", query);
	}

	async postApiAuthToken(opts?: Record<string, unknown>): Promise<unknown> {
		return this.transport.post<unknown>("/api/auth/token", opts);
	}

	async getApiLogs(query?: Record<string, unknown>): Promise<unknown> {
		return this.transport.get<unknown>("/api/logs", query);
	}

	async getApiLogsStream(query?: Record<string, unknown>): Promise<unknown> {
		return this.transport.get<unknown>("/api/logs/stream", query);
	}

	async getApiConfig(query?: Record<string, unknown>): Promise<unknown> {
		return this.transport.get<unknown>("/api/config", query);
	}

	async postApiConfig(opts?: Record<string, unknown>): Promise<unknown> {
		return this.transport.post<unknown>("/api/config", opts);
	}

	async getApiIdentity(query?: Record<string, unknown>): Promise<unknown> {
		return this.transport.get<unknown>("/api/identity", query);
	}

	async getApiMemories(query?: Record<string, unknown>): Promise<unknown> {
		return this.transport.get<unknown>("/api/memories", query);
	}

	async getApiMemoryTimeline(query?: Record<string, unknown>): Promise<unknown> {
		return this.transport.get<unknown>("/api/memory/timeline", query);
	}

	async getMemorySearch(query?: Record<string, unknown>): Promise<unknown> {
		return this.transport.get<unknown>("/memory/search", query);
	}

	async postApiMemoryRemember(opts?: Record<string, unknown>): Promise<unknown> {
		return this.transport.post<unknown>("/api/memory/remember", opts);
	}

	async postApiMemorySave(opts?: Record<string, unknown>): Promise<unknown> {
		return this.transport.post<unknown>("/api/memory/save", opts);
	}

	async postApiHookRemember(opts?: Record<string, unknown>): Promise<unknown> {
		return this.transport.post<unknown>("/api/hook/remember", opts);
	}

	async getApiMemoryById(id: string, query?: Record<string, unknown>): Promise<unknown> {
		return this.transport.get<unknown>(`/api/memory/${id}`, query);
	}

	async getApiMemoryByIdHistory(id: string, query?: Record<string, unknown>): Promise<unknown> {
		return this.transport.get<unknown>(`/api/memory/${id}/history`, query);
	}

	async postApiMemoryByIdRecover(id: string, opts?: Record<string, unknown>): Promise<unknown> {
		return this.transport.post<unknown>(`/api/memory/${id}/recover`, opts);
	}

	async patchApiMemoryById(id: string, opts?: Record<string, unknown>): Promise<unknown> {
		return this.transport.patch<unknown>(`/api/memory/${id}`, opts);
	}

	async deleteApiMemoryById(id: string, query?: Record<string, unknown>): Promise<unknown> {
		return this.transport.del<unknown>(`/api/memory/${id}`, query);
	}

	async postApiMemoryFeedback(opts?: Record<string, unknown>): Promise<unknown> {
		return this.transport.post<unknown>("/api/memory/feedback", opts);
	}

	async postApiMemoryForget(opts?: Record<string, unknown>): Promise<unknown> {
		return this.transport.post<unknown>("/api/memory/forget", opts);
	}

	async postApiMemoryModify(opts?: Record<string, unknown>): Promise<unknown> {
		return this.transport.post<unknown>("/api/memory/modify", opts);
	}

	async postApiMemoryRecall(opts?: Record<string, unknown>): Promise<unknown> {
		return this.transport.post<unknown>("/api/memory/recall", opts);
	}

	async getApiMemorySearch(query?: Record<string, unknown>): Promise<unknown> {
		return this.transport.get<unknown>("/api/memory/search", query);
	}

	async getMemorySimilar(query?: Record<string, unknown>): Promise<unknown> {
		return this.transport.get<unknown>("/memory/similar", query);
	}

	async getApiEmbeddings(query?: Record<string, unknown>): Promise<unknown> {
		return this.transport.get<unknown>("/api/embeddings", query);
	}

	async getApiEmbeddingsStatus(query?: Record<string, unknown>): Promise<unknown> {
		return this.transport.get<unknown>("/api/embeddings/status", query);
	}

	async getApiEmbeddingsHealth(query?: Record<string, unknown>): Promise<unknown> {
		return this.transport.get<unknown>("/api/embeddings/health", query);
	}

	async getApiEmbeddingsProjection(query?: Record<string, unknown>): Promise<unknown> {
		return this.transport.get<unknown>("/api/embeddings/projection", query);
	}

	async postApiDocuments(opts?: Record<string, unknown>): Promise<unknown> {
		return this.transport.post<unknown>("/api/documents", opts);
	}

	async getApiDocuments(query?: Record<string, unknown>): Promise<unknown> {
		return this.transport.get<unknown>("/api/documents", query);
	}

	async getApiDocumentsById(id: string, query?: Record<string, unknown>): Promise<unknown> {
		return this.transport.get<unknown>(`/api/documents/${id}`, query);
	}

	async getApiDocumentsByIdChunks(id: string, query?: Record<string, unknown>): Promise<unknown> {
		return this.transport.get<unknown>(`/api/documents/${id}/chunks`, query);
	}

	async deleteApiDocumentsById(id: string, query?: Record<string, unknown>): Promise<unknown> {
		return this.transport.del<unknown>(`/api/documents/${id}`, query);
	}

	async getApiConnectors(query?: Record<string, unknown>): Promise<unknown> {
		return this.transport.get<unknown>("/api/connectors", query);
	}

	async postApiConnectors(opts?: Record<string, unknown>): Promise<unknown> {
		return this.transport.post<unknown>("/api/connectors", opts);
	}

	async getApiConnectorsById(id: string, query?: Record<string, unknown>): Promise<unknown> {
		return this.transport.get<unknown>(`/api/connectors/${id}`, query);
	}

	async postApiConnectorsByIdSync(id: string, opts?: Record<string, unknown>): Promise<unknown> {
		return this.transport.post<unknown>(`/api/connectors/${id}/sync`, opts);
	}

	async postApiConnectorsResync(opts?: Record<string, unknown>): Promise<unknown> {
		return this.transport.post<unknown>("/api/connectors/resync", opts);
	}

	async postApiConnectorsByIdSyncFull(id: string, opts?: Record<string, unknown>): Promise<unknown> {
		return this.transport.post<unknown>(`/api/connectors/${id}/sync/full`, opts);
	}

	async deleteApiConnectorsById(id: string, query?: Record<string, unknown>): Promise<unknown> {
		return this.transport.del<unknown>(`/api/connectors/${id}`, query);
	}

	async getApiConnectorsByIdHealth(id: string, query?: Record<string, unknown>): Promise<unknown> {
		return this.transport.get<unknown>(`/api/connectors/${id}/health`, query);
	}

	async getApiHarnesses(query?: Record<string, unknown>): Promise<unknown> {
		return this.transport.get<unknown>("/api/harnesses", query);
	}

	async postApiHarnessesRegenerate(opts?: Record<string, unknown>): Promise<unknown> {
		return this.transport.post<unknown>("/api/harnesses/regenerate", opts);
	}

	async getApiSecrets(query?: Record<string, unknown>): Promise<unknown> {
		return this.transport.get<unknown>("/api/secrets", query);
	}

	async getApiSecrets1passwordStatus(query?: Record<string, unknown>): Promise<unknown> {
		return this.transport.get<unknown>("/api/secrets/1password/status", query);
	}

	async postApiSecrets1passwordConnect(opts?: Record<string, unknown>): Promise<unknown> {
		return this.transport.post<unknown>("/api/secrets/1password/connect", opts);
	}

	async deleteApiSecrets1passwordConnect(query?: Record<string, unknown>): Promise<unknown> {
		return this.transport.del<unknown>("/api/secrets/1password/connect", query);
	}

	async getApiSecrets1passwordVaults(query?: Record<string, unknown>): Promise<unknown> {
		return this.transport.get<unknown>("/api/secrets/1password/vaults", query);
	}

	async postApiSecrets1passwordImport(opts?: Record<string, unknown>): Promise<unknown> {
		return this.transport.post<unknown>("/api/secrets/1password/import", opts);
	}

	async postApiSecretsExec(opts?: Record<string, unknown>): Promise<unknown> {
		return this.transport.post<unknown>("/api/secrets/exec", opts);
	}

	async postApiSecretsByNameExec(name: string, opts?: Record<string, unknown>): Promise<unknown> {
		return this.transport.post<unknown>(`/api/secrets/${name}/exec`, opts);
	}

	async postApiSecretsByName(name: string, opts?: Record<string, unknown>): Promise<unknown> {
		return this.transport.post<unknown>(`/api/secrets/${name}`, opts);
	}

	async deleteApiSecretsByName(name: string, query?: Record<string, unknown>): Promise<unknown> {
		return this.transport.del<unknown>(`/api/secrets/${name}`, query);
	}

	async postApiHooksSessionStart(opts?: Record<string, unknown>): Promise<unknown> {
		return this.transport.post<unknown>("/api/hooks/session-start", opts);
	}

	async postApiHooksUserPromptSubmit(opts?: Record<string, unknown>): Promise<unknown> {
		return this.transport.post<unknown>("/api/hooks/user-prompt-submit", opts);
	}

	async postApiHooksSessionEnd(opts?: Record<string, unknown>): Promise<unknown> {
		return this.transport.post<unknown>("/api/hooks/session-end", opts);
	}

	async postApiHooksRemember(opts?: Record<string, unknown>): Promise<unknown> {
		return this.transport.post<unknown>("/api/hooks/remember", opts);
	}

	async postApiHooksRecall(opts?: Record<string, unknown>): Promise<unknown> {
		return this.transport.post<unknown>("/api/hooks/recall", opts);
	}

	async postApiHooksPreCompaction(opts?: Record<string, unknown>): Promise<unknown> {
		return this.transport.post<unknown>("/api/hooks/pre-compaction", opts);
	}

	async postApiHooksCompactionComplete(opts?: Record<string, unknown>): Promise<unknown> {
		return this.transport.post<unknown>("/api/hooks/compaction-complete", opts);
	}

	async getApiCrossAgentPresence(query?: Record<string, unknown>): Promise<unknown> {
		return this.transport.get<unknown>("/api/cross-agent/presence", query);
	}

	async postApiCrossAgentPresence(opts?: Record<string, unknown>): Promise<unknown> {
		return this.transport.post<unknown>("/api/cross-agent/presence", opts);
	}

	async deleteApiCrossAgentPresenceBySessionKey(sessionKey: string, query?: Record<string, unknown>): Promise<unknown> {
		return this.transport.del<unknown>(`/api/cross-agent/presence/${sessionKey}`, query);
	}

	async getApiCrossAgentMessages(query?: Record<string, unknown>): Promise<unknown> {
		return this.transport.get<unknown>("/api/cross-agent/messages", query);
	}

	async postApiCrossAgentMessages(opts?: Record<string, unknown>): Promise<unknown> {
		return this.transport.post<unknown>("/api/cross-agent/messages", opts);
	}

	async getApiCrossAgentStream(query?: Record<string, unknown>): Promise<unknown> {
		return this.transport.get<unknown>("/api/cross-agent/stream", query);
	}

	async getApiHooksSynthesisConfig(query?: Record<string, unknown>): Promise<unknown> {
		return this.transport.get<unknown>("/api/hooks/synthesis/config", query);
	}

	async postApiHooksSynthesis(opts?: Record<string, unknown>): Promise<unknown> {
		return this.transport.post<unknown>("/api/hooks/synthesis", opts);
	}

	async postApiHooksSynthesisComplete(opts?: Record<string, unknown>): Promise<unknown> {
		return this.transport.post<unknown>("/api/hooks/synthesis/complete", opts);
	}

	async postApiSynthesisTrigger(opts?: Record<string, unknown>): Promise<unknown> {
		return this.transport.post<unknown>("/api/synthesis/trigger", opts);
	}

	async getApiSynthesisStatus(query?: Record<string, unknown>): Promise<unknown> {
		return this.transport.get<unknown>("/api/synthesis/status", query);
	}

	async getApiSessions(query?: Record<string, unknown>): Promise<unknown> {
		return this.transport.get<unknown>("/api/sessions", query);
	}

	async getApiSessionsByKey(key: string, query?: Record<string, unknown>): Promise<unknown> {
		return this.transport.get<unknown>(`/api/sessions/${key}`, query);
	}

	async postApiSessionsByKeyBypass(key: string, opts?: Record<string, unknown>): Promise<unknown> {
		return this.transport.post<unknown>(`/api/sessions/${key}/bypass`, opts);
	}

	async getApiGitStatus(query?: Record<string, unknown>): Promise<unknown> {
		return this.transport.get<unknown>("/api/git/status", query);
	}

	async postApiGitPull(opts?: Record<string, unknown>): Promise<unknown> {
		return this.transport.post<unknown>("/api/git/pull", opts);
	}

	async postApiGitPush(opts?: Record<string, unknown>): Promise<unknown> {
		return this.transport.post<unknown>("/api/git/push", opts);
	}

	async postApiGitSync(opts?: Record<string, unknown>): Promise<unknown> {
		return this.transport.post<unknown>("/api/git/sync", opts);
	}

	async getApiGitConfig(query?: Record<string, unknown>): Promise<unknown> {
		return this.transport.get<unknown>("/api/git/config", query);
	}

	async postApiGitConfig(opts?: Record<string, unknown>): Promise<unknown> {
		return this.transport.post<unknown>("/api/git/config", opts);
	}

	async getApiUpdateCheck(query?: Record<string, unknown>): Promise<unknown> {
		return this.transport.get<unknown>("/api/update/check", query);
	}

	async getApiUpdateConfig(query?: Record<string, unknown>): Promise<unknown> {
		return this.transport.get<unknown>("/api/update/config", query);
	}

	async postApiUpdateConfig(opts?: Record<string, unknown>): Promise<unknown> {
		return this.transport.post<unknown>("/api/update/config", opts);
	}

	async postApiUpdateRun(opts?: Record<string, unknown>): Promise<unknown> {
		return this.transport.post<unknown>("/api/update/run", opts);
	}

	async getApiTasksByIdStream(id: string, query?: Record<string, unknown>): Promise<unknown> {
		return this.transport.get<unknown>(`/api/tasks/${id}/stream`, query);
	}

	async getApiTasks(query?: Record<string, unknown>): Promise<unknown> {
		return this.transport.get<unknown>("/api/tasks", query);
	}

	async postApiTasks(opts?: Record<string, unknown>): Promise<unknown> {
		return this.transport.post<unknown>("/api/tasks", opts);
	}

	async getApiTasksById(id: string, query?: Record<string, unknown>): Promise<unknown> {
		return this.transport.get<unknown>(`/api/tasks/${id}`, query);
	}

	async patchApiTasksById(id: string, opts?: Record<string, unknown>): Promise<unknown> {
		return this.transport.patch<unknown>(`/api/tasks/${id}`, opts);
	}

	async deleteApiTasksById(id: string, query?: Record<string, unknown>): Promise<unknown> {
		return this.transport.del<unknown>(`/api/tasks/${id}`, query);
	}

	async postApiTasksByIdRun(id: string, opts?: Record<string, unknown>): Promise<unknown> {
		return this.transport.post<unknown>(`/api/tasks/${id}/run`, opts);
	}

	async getApiTasksByIdRuns(id: string, query?: Record<string, unknown>): Promise<unknown> {
		return this.transport.get<unknown>(`/api/tasks/${id}/runs`, query);
	}

	async getApiStatus(query?: Record<string, unknown>): Promise<unknown> {
		return this.transport.get<unknown>("/api/status", query);
	}

	async getApiHomeGreeting(query?: Record<string, unknown>): Promise<unknown> {
		return this.transport.get<unknown>("/api/home/greeting", query);
	}

	async getApiDiagnostics(query?: Record<string, unknown>): Promise<unknown> {
		return this.transport.get<unknown>("/api/diagnostics", query);
	}

	async getApiDiagnosticsByDomain(domain: string, query?: Record<string, unknown>): Promise<unknown> {
		return this.transport.get<unknown>(`/api/diagnostics/${domain}`, query);
	}

	async getApiPipelineStatus(query?: Record<string, unknown>): Promise<unknown> {
		return this.transport.get<unknown>("/api/pipeline/status", query);
	}

	async getApiPredictorStatus(query?: Record<string, unknown>): Promise<unknown> {
		return this.transport.get<unknown>("/api/predictor/status", query);
	}

	async postApiRepairRequeueDead(opts?: Record<string, unknown>): Promise<unknown> {
		return this.transport.post<unknown>("/api/repair/requeue-dead", opts);
	}

	async postApiRepairReleaseLeases(opts?: Record<string, unknown>): Promise<unknown> {
		return this.transport.post<unknown>("/api/repair/release-leases", opts);
	}

	async postApiRepairCheckFts(opts?: Record<string, unknown>): Promise<unknown> {
		return this.transport.post<unknown>("/api/repair/check-fts", opts);
	}

	async postApiRepairRetentionSweep(opts?: Record<string, unknown>): Promise<unknown> {
		return this.transport.post<unknown>("/api/repair/retention-sweep", opts);
	}

	async getApiRepairEmbeddingGaps(query?: Record<string, unknown>): Promise<unknown> {
		return this.transport.get<unknown>("/api/repair/embedding-gaps", query);
	}

	async postApiRepairReEmbed(opts?: Record<string, unknown>): Promise<unknown> {
		return this.transport.post<unknown>("/api/repair/re-embed", opts);
	}

	async postApiRepairResyncVec(opts?: Record<string, unknown>): Promise<unknown> {
		return this.transport.post<unknown>("/api/repair/resync-vec", opts);
	}

	async postApiRepairCleanOrphans(opts?: Record<string, unknown>): Promise<unknown> {
		return this.transport.post<unknown>("/api/repair/clean-orphans", opts);
	}

	async getApiRepairDedupStats(query?: Record<string, unknown>): Promise<unknown> {
		return this.transport.get<unknown>("/api/repair/dedup-stats", query);
	}

	async postApiRepairDeduplicate(opts?: Record<string, unknown>): Promise<unknown> {
		return this.transport.post<unknown>("/api/repair/deduplicate", opts);
	}

	async postApiRepairReclassifyEntities(opts?: Record<string, unknown>): Promise<unknown> {
		return this.transport.post<unknown>("/api/repair/reclassify-entities", opts);
	}

	async postApiRepairPruneChunkGroups(opts?: Record<string, unknown>): Promise<unknown> {
		return this.transport.post<unknown>("/api/repair/prune-chunk-groups", opts);
	}

	async postApiRepairPruneSingletonEntities(opts?: Record<string, unknown>): Promise<unknown> {
		return this.transport.post<unknown>("/api/repair/prune-singleton-entities", opts);
	}

	async postApiRepairStructuralBackfill(opts?: Record<string, unknown>): Promise<unknown> {
		return this.transport.post<unknown>("/api/repair/structural-backfill", opts);
	}

	async getApiCheckpoints(query?: Record<string, unknown>): Promise<unknown> {
		return this.transport.get<unknown>("/api/checkpoints", query);
	}

	async getApiCheckpointsBySessionKey(sessionKey: string, query?: Record<string, unknown>): Promise<unknown> {
		return this.transport.get<unknown>(`/api/checkpoints/${sessionKey}`, query);
	}

	async getApiKnowledgeEntities(query?: Record<string, unknown>): Promise<unknown> {
		return this.transport.get<unknown>("/api/knowledge/entities", query);
	}

	async postApiKnowledgeEntitiesByIdPin(id: string, opts?: Record<string, unknown>): Promise<unknown> {
		return this.transport.post<unknown>(`/api/knowledge/entities/${id}/pin`, opts);
	}

	async deleteApiKnowledgeEntitiesByIdPin(id: string, query?: Record<string, unknown>): Promise<unknown> {
		return this.transport.del<unknown>(`/api/knowledge/entities/${id}/pin`, query);
	}

	async getApiKnowledgeEntitiesPinned(query?: Record<string, unknown>): Promise<unknown> {
		return this.transport.get<unknown>("/api/knowledge/entities/pinned", query);
	}

	async getApiKnowledgeEntitiesHealth(query?: Record<string, unknown>): Promise<unknown> {
		return this.transport.get<unknown>("/api/knowledge/entities/health", query);
	}

	async getApiKnowledgeEntitiesById(id: string, query?: Record<string, unknown>): Promise<unknown> {
		return this.transport.get<unknown>(`/api/knowledge/entities/${id}`, query);
	}

	async getApiKnowledgeEntitiesByIdAspects(id: string, query?: Record<string, unknown>): Promise<unknown> {
		return this.transport.get<unknown>(`/api/knowledge/entities/${id}/aspects`, query);
	}

	async getApiKnowledgeEntitiesByIdAspectsByAspectIdAttributes(
		id: string,
		aspectId: string,
		query?: Record<string, unknown>,
	): Promise<unknown> {
		return this.transport.get<unknown>(`/api/knowledge/entities/${id}/aspects/${aspectId}/attributes`, query);
	}

	async getApiKnowledgeEntitiesByIdDependencies(id: string, query?: Record<string, unknown>): Promise<unknown> {
		return this.transport.get<unknown>(`/api/knowledge/entities/${id}/dependencies`, query);
	}

	async getApiKnowledgeStats(query?: Record<string, unknown>): Promise<unknown> {
		return this.transport.get<unknown>("/api/knowledge/stats", query);
	}

	async getApiKnowledgeTraversalStatus(query?: Record<string, unknown>): Promise<unknown> {
		return this.transport.get<unknown>("/api/knowledge/traversal/status", query);
	}

	async getApiKnowledgeConstellation(query?: Record<string, unknown>): Promise<unknown> {
		return this.transport.get<unknown>("/api/knowledge/constellation", query);
	}

	async getApiAnalyticsUsage(query?: Record<string, unknown>): Promise<unknown> {
		return this.transport.get<unknown>("/api/analytics/usage", query);
	}

	async getApiAnalyticsErrors(query?: Record<string, unknown>): Promise<unknown> {
		return this.transport.get<unknown>("/api/analytics/errors", query);
	}

	async getApiAnalyticsLatency(query?: Record<string, unknown>): Promise<unknown> {
		return this.transport.get<unknown>("/api/analytics/latency", query);
	}

	async getApiAnalyticsLogs(query?: Record<string, unknown>): Promise<unknown> {
		return this.transport.get<unknown>("/api/analytics/logs", query);
	}

	async getApiAnalyticsMemorySafety(query?: Record<string, unknown>): Promise<unknown> {
		return this.transport.get<unknown>("/api/analytics/memory-safety", query);
	}

	async getApiAnalyticsContinuity(query?: Record<string, unknown>): Promise<unknown> {
		return this.transport.get<unknown>("/api/analytics/continuity", query);
	}

	async getApiAnalyticsContinuityLatest(query?: Record<string, unknown>): Promise<unknown> {
		return this.transport.get<unknown>("/api/analytics/continuity/latest", query);
	}

	async getApiPredictorComparisonsByProject(query?: Record<string, unknown>): Promise<unknown> {
		return this.transport.get<unknown>("/api/predictor/comparisons/by-project", query);
	}

	async getApiPredictorComparisonsByEntity(query?: Record<string, unknown>): Promise<unknown> {
		return this.transport.get<unknown>("/api/predictor/comparisons/by-entity", query);
	}

	async getApiPredictorComparisons(query?: Record<string, unknown>): Promise<unknown> {
		return this.transport.get<unknown>("/api/predictor/comparisons", query);
	}

	async getApiPredictorTraining(query?: Record<string, unknown>): Promise<unknown> {
		return this.transport.get<unknown>("/api/predictor/training", query);
	}

	async getApiPredictorTrainingPairsCount(query?: Record<string, unknown>): Promise<unknown> {
		return this.transport.get<unknown>("/api/predictor/training-pairs-count", query);
	}

	async postApiPredictorTrain(opts?: Record<string, unknown>): Promise<unknown> {
		return this.transport.post<unknown>("/api/predictor/train", opts);
	}

	async getApiTelemetryEvents(query?: Record<string, unknown>): Promise<unknown> {
		return this.transport.get<unknown>("/api/telemetry/events", query);
	}

	async getApiTelemetryStats(query?: Record<string, unknown>): Promise<unknown> {
		return this.transport.get<unknown>("/api/telemetry/stats", query);
	}

	async getApiTelemetryExport(query?: Record<string, unknown>): Promise<unknown> {
		return this.transport.get<unknown>("/api/telemetry/export", query);
	}

	async getApiTelemetryTrainingExport(query?: Record<string, unknown>): Promise<unknown> {
		return this.transport.get<unknown>("/api/telemetry/training-export", query);
	}

	async getApiTimelineById(id: string, query?: Record<string, unknown>): Promise<unknown> {
		return this.transport.get<unknown>(`/api/timeline/${id}`, query);
	}

	async getApiTimelineByIdExport(id: string, query?: Record<string, unknown>): Promise<unknown> {
		return this.transport.get<unknown>(`/api/timeline/${id}/export`, query);
	}

	async get(query?: Record<string, unknown>): Promise<unknown> {
		return this.transport.get<unknown>("/", query);
	}
}

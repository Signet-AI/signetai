/**
 * @signet/sdk — HTTP client for the Signet daemon API.
 * No native dependencies (no SQLite).
 */

import {
	applyNativeRecallScoreThreshold,
	buildNativeRecallRequestBody,
	resolveNativeDaemonUrl,
} from "./native-contract.js";
import { SignetClientP2 } from "./client-p2.js";
import { SignetClientHelpers } from "./helpers.js";
import { SignetTransport } from "./transport.js";
import type {
	BatchModifyResponse,
	BitwardenConnectResult,
	BitwardenMigrationResult,
	BitwardenStatus,
	CheckpointListResponse,
	ConfigListResponse,
	ConfigWriteResponse,
	DeleteResult,
	DocumentChunksResponse,
	DocumentCreateResult,
	DocumentDeleteResult,
	DocumentListResponse,
	DocumentRecord,
	EmbeddingHealthResponse,
	EmbeddingProjectionResponse,
	EmbeddingStatusResponse,
	FeaturesResponse,
	ForgetResponse,
	GitConfig,
	GitPullResult,
	GitPushResult,
	GitStatus,
	GitSyncResult,
	GreetingResponse,
	HarnessListResponse,
	HarnessRegenerateResponse,
	HealthResponse,
	HistoryResponse,
	IdentityResponse,
	JobStatus,
	MemoryListResponse,
	MemoryRecord,
	MemorySearchTelemetryResponse,
	ModifyResult,
	OnePasswordConnectResult,
	OnePasswordImportResult,
	OnePasswordStatus,
	PipelineStatusResponse,
	PluginAuditListResponse,
	PluginDiagnosticsResponse,
	PluginListResponse,
	PluginPromptContributionListResponse,
	PluginRegistryRecord,
	RecallResponse,
	RecoverResult,
	RememberResult,
	SdkRecallOptions,
	SecretExecJob,
	SecretExecOptions,
	SecretListResponse,
	SessionInfo,
	SessionListResponse,
	SkillBrowseResponse,
	SkillDeleteResult,
	SkillGetResponse,
	SkillInstallResult,
	SkillListResponse,
	SkillSearchResponse,
	StatusResponse,
	TelemetryEventsResponse,
	TelemetryStatsResponse,
	TimelineExportResponse,
	TimelineResponse,
} from "./types.js";

export interface SignetClientConfig {
	readonly daemonUrl?: string;
	readonly timeoutMs?: number;
	readonly retries?: number;
	readonly actor?: string;
	readonly actorType?: string;
	readonly token?: string;
	readonly agentId?: string;
	readonly agentType?: string;
	readonly workspaceId?: string;
}

// biome-ignore lint/suspicious/noUnsafeDeclarationMerging: P2 methods are mixed into SignetClient below for compatibility.
export class SignetClient extends SignetClientHelpers {
	constructor(config?: SignetClientConfig) {
		const headers: Record<string, string> = {};
		if (config?.token) {
			headers.Authorization = `Bearer ${config.token}`;
		}
		if (config?.actor) {
			headers["x-signet-actor"] = config.actor;
		}
		if (config?.actorType) {
			headers["x-signet-actor-type"] = config.actorType;
		}
		if (config?.agentId) headers["x-signet-agent-id"] = config.agentId;
		if (config?.agentType) headers["x-signet-agent-type"] = config.agentType;
		if (config?.workspaceId) headers["x-signet-workspace"] = config.workspaceId;

		const transport = new SignetTransport({
			baseUrl: config?.daemonUrl ?? resolveNativeDaemonUrl({}),
			timeoutMs: config?.timeoutMs ?? 10_000,
			retries: config?.retries ?? 2,
			headers: Object.keys(headers).length > 0 ? headers : undefined,
		});

		super(transport);
	}

	async remember(
		content: string,
		opts?: {
			readonly type?: string;
			readonly importance?: number;
			readonly tags?: string;
			readonly who?: string;
			readonly pinned?: boolean;
			readonly sourceType?: string;
			readonly sourceId?: string;
			readonly sourcePath?: string;
			readonly occurredAt?: string;
			readonly observedAt?: string;
			readonly sourceCreatedAt?: string;
			readonly validFrom?: string;
			readonly validUntil?: string;
			readonly reviewAfter?: string;
			readonly mode?: "auto" | "sync" | "async";
			readonly idempotencyKey?: string;
			readonly runtimePath?: string;
		},
	): Promise<RememberResult> {
		return this.transport.post<RememberResult>("/api/memory/remember", {
			content,
			...opts,
		});
	}

	async recall(query: string, opts?: SdkRecallOptions): Promise<RecallResponse> {
		const { minScore, ...requestOptions } = opts ?? {};
		return applyNativeRecallScoreThreshold(
			await this.transport.post<RecallResponse>(
				"/api/memory/recall",
				buildNativeRecallRequestBody(query, { ...requestOptions, minScore }),
			),
			minScore,
		);
	}

	async getMemory(id: string): Promise<MemoryRecord> {
		return this.transport.get<MemoryRecord>(`/api/memory/${id}`);
	}

	async listMemories(opts?: {
		readonly limit?: number;
		readonly offset?: number;
		readonly type?: string;
	}): Promise<MemoryListResponse> {
		return this.transport.get<MemoryListResponse>("/api/memories", {
			limit: opts?.limit,
			offset: opts?.offset,
			type: opts?.type,
		});
	}

	async modifyMemory(
		id: string,
		patch: {
			readonly content?: string;
			readonly type?: string;
			readonly importance?: number;
			readonly tags?: string;
			readonly pinned?: boolean;
			readonly project?: string;
			readonly reason: string;
			readonly ifVersion?: number;
		},
	): Promise<ModifyResult> {
		const { ifVersion, ...rest } = patch;
		return this.transport.patch<ModifyResult>(`/api/memory/${id}`, {
			...rest,
			if_version: ifVersion,
		});
	}

	async forgetMemory(
		id: string,
		opts: {
			readonly reason: string;
			readonly force?: boolean;
			readonly ifVersion?: number;
		},
	): Promise<DeleteResult> {
		return this.transport.del<DeleteResult>(`/api/memory/${id}`, {
			reason: opts.reason,
			force: opts.force,
			if_version: opts.ifVersion,
		});
	}

	async batchForget(opts: {
		readonly mode: "preview" | "execute";
		readonly query?: string;
		readonly ids?: readonly string[];
		readonly type?: string;
		readonly tags?: string;
		readonly who?: string;
		readonly source_type?: string;
		readonly since?: string;
		readonly until?: string;
		readonly limit?: number;
		readonly reason?: string;
		readonly force?: boolean;
		readonly confirm_token?: string;
	}): Promise<ForgetResponse> {
		return this.transport.post<ForgetResponse>("/api/memory/forget", opts);
	}

	async batchModify(
		patches: readonly {
			readonly id: string;
			readonly content?: string;
			readonly type?: string;
			readonly importance?: number;
			readonly tags?: string;
			readonly pinned?: boolean;
			readonly project?: string;
			readonly reason: string;
			readonly ifVersion?: number;
		}[],
		opts?: {
			readonly reason?: string;
			readonly changed_by?: string;
		},
	): Promise<BatchModifyResponse> {
		const mapped = patches.map(({ ifVersion, ...rest }) => ({
			...rest,
			if_version: ifVersion,
		}));
		return this.transport.post<BatchModifyResponse>("/api/memory/modify", {
			patches: mapped,
			...opts,
		});
	}

	async getHistory(memoryId: string, opts?: { readonly limit?: number }): Promise<HistoryResponse> {
		return this.transport.get<HistoryResponse>(`/api/memory/${memoryId}/history`, { limit: opts?.limit });
	}

	async recoverMemory(
		id: string,
		opts?: {
			readonly reason?: string;
			readonly ifVersion?: number;
		},
	): Promise<RecoverResult> {
		return this.transport.post<RecoverResult>(`/api/memory/${id}/recover`, {
			reason: opts?.reason,
			if_version: opts?.ifVersion,
		});
	}

	async getJob(jobId: string): Promise<JobStatus> {
		return this.transport.get<JobStatus>(`/api/memory/jobs/${jobId}`);
	}

	async createDocument(opts: {
		readonly source_type: "text" | "url" | "file";
		readonly content?: string;
		readonly url?: string;
		readonly title?: string;
		readonly content_type?: string;
		readonly connector_id?: string;
		readonly metadata?: Record<string, unknown>;
	}): Promise<DocumentCreateResult> {
		return this.transport.post<DocumentCreateResult>("/api/documents", opts);
	}

	async getDocument(id: string): Promise<DocumentRecord> {
		return this.transport.get<DocumentRecord>(`/api/documents/${id}`);
	}

	async listDocuments(opts?: {
		readonly status?: string;
		readonly limit?: number;
		readonly offset?: number;
	}): Promise<DocumentListResponse> {
		return this.transport.get<DocumentListResponse>("/api/documents", {
			status: opts?.status,
			limit: opts?.limit,
			offset: opts?.offset,
		});
	}

	async getDocumentChunks(id: string): Promise<DocumentChunksResponse> {
		return this.transport.get<DocumentChunksResponse>(`/api/documents/${id}/chunks`);
	}

	async deleteDocument(id: string, reason: string): Promise<DocumentDeleteResult> {
		return this.transport.del<DocumentDeleteResult>(`/api/documents/${id}`, { reason });
	}

	async health(): Promise<HealthResponse> {
		return this.transport.get<HealthResponse>("/health");
	}

	async status(): Promise<StatusResponse> {
		return this.transport.get<StatusResponse>("/api/status");
	}

	async diagnostics(domain?: string): Promise<unknown> {
		const path = domain ? `/api/diagnostics/${domain}` : "/api/diagnostics";
		return this.transport.get<unknown>(path);
	}

	async createToken(opts: {
		readonly role: string;
		readonly scope?: {
			readonly project?: string;
			readonly agent?: string;
			readonly user?: string;
		};
		readonly ttlSeconds?: number;
	}): Promise<{ token: string; expiresAt: string }> {
		return this.transport.post<{ token: string; expiresAt: string }>("/api/auth/token", opts);
	}

	async whoami(): Promise<{ authenticated: boolean; claims: unknown }> {
		return this.transport.get<{ authenticated: boolean; claims: unknown }>("/api/auth/whoami");
	}
	async getTimeline(entityId: string): Promise<TimelineResponse> {
		return this.transport.get<TimelineResponse>(`/api/timeline/${entityId}`);
	}
	async exportTimeline(entityId: string): Promise<TimelineExportResponse> {
		return this.transport.get<TimelineExportResponse>(`/api/timeline/${entityId}/export`);
	}
	async getPipelineStatus(): Promise<PipelineStatusResponse> {
		return this.transport.get<PipelineStatusResponse>("/api/pipeline/status");
	}
	async getTelemetryEvents(opts?: {
		readonly event?: string;
		readonly since?: string;
		readonly until?: string;
		readonly limit?: number;
	}): Promise<TelemetryEventsResponse> {
		return this.transport.get<TelemetryEventsResponse>("/api/telemetry/events", {
			event: opts?.event,
			since: opts?.since,
			until: opts?.until,
			limit: opts?.limit,
		});
	}
	async getTelemetryStats(opts?: { readonly since?: string }): Promise<TelemetryStatsResponse> {
		return this.transport.get<TelemetryStatsResponse>("/api/telemetry/stats", {
			since: opts?.since,
		});
	}
	async exportTelemetry(opts?: { readonly since?: string; readonly limit?: number }): Promise<string> {
		return this.transport.get<string>("/api/telemetry/export", {
			since: opts?.since,
			limit: opts?.limit,
		});
	}
	async getMemorySearchTelemetry(opts?: {
		readonly agentId?: string;
		readonly sessionKey?: string;
		readonly route?: string;
		readonly since?: string;
		readonly until?: string;
		readonly noHits?: boolean;
		readonly limit?: number;
		readonly offset?: number;
	}): Promise<MemorySearchTelemetryResponse> {
		return this.transport.get<MemorySearchTelemetryResponse>("/api/telemetry/memory-search", {
			agent_id: opts?.agentId,
			session_key: opts?.sessionKey,
			route: opts?.route,
			since: opts?.since,
			until: opts?.until,
			no_hits: opts?.noHits,
			limit: opts?.limit,
			offset: opts?.offset,
		});
	}
	async exportMemorySearchTelemetry(opts?: {
		readonly agentId?: string;
		readonly sessionKey?: string;
		readonly route?: string;
		readonly since?: string;
		readonly until?: string;
		readonly noHits?: boolean;
		readonly limit?: number;
	}): Promise<string> {
		return this.transport.get<string>("/api/telemetry/memory-search/export", {
			agent_id: opts?.agentId,
			session_key: opts?.sessionKey,
			route: opts?.route,
			since: opts?.since,
			until: opts?.until,
			no_hits: opts?.noHits,
			limit: opts?.limit,
		});
	}
	async listConfig(): Promise<ConfigListResponse> {
		return this.transport.get<ConfigListResponse>("/api/config");
	}
	async writeConfig(file: string, content: string): Promise<ConfigWriteResponse> {
		return this.transport.post<ConfigWriteResponse>("/api/config", {
			file,
			content,
		});
	}
	async getIdentity(): Promise<IdentityResponse> {
		return this.transport.get<IdentityResponse>("/api/identity");
	}
	async getEmbeddingStatus(): Promise<EmbeddingStatusResponse> {
		return this.transport.get<EmbeddingStatusResponse>("/api/embeddings/status");
	}
	async getEmbeddingHealth(): Promise<EmbeddingHealthResponse> {
		return this.transport.get<EmbeddingHealthResponse>("/api/embeddings/health");
	}
	async getEmbeddingProjection(opts?: { readonly dimensions?: 2 | 3 }): Promise<EmbeddingProjectionResponse> {
		return this.transport.get<EmbeddingProjectionResponse>("/api/embeddings/projection", {
			dimensions: opts?.dimensions,
		});
	}
	async listHarnesses(): Promise<HarnessListResponse> {
		return this.transport.get<HarnessListResponse>("/api/harnesses");
	}
	async regenerateHarnesses(): Promise<HarnessRegenerateResponse> {
		return this.transport.post<HarnessRegenerateResponse>("/api/harnesses/regenerate", {});
	}
	async listCheckpoints(opts: { readonly project: string; readonly limit?: number }): Promise<CheckpointListResponse> {
		return this.transport.get<CheckpointListResponse>("/api/checkpoints", {
			project: opts.project,
			limit: opts.limit,
		});
	}
	async listSessionCheckpoints(sessionKey: string): Promise<CheckpointListResponse> {
		return this.transport.get<CheckpointListResponse>(`/api/checkpoints/${sessionKey}`);
	}
	async getFeatures(): Promise<FeaturesResponse> {
		return this.transport.get<FeaturesResponse>("/api/features");
	}
	async getGreeting(): Promise<GreetingResponse> {
		return this.transport.get<GreetingResponse>("/api/home/greeting");
	}
	async listSessions(): Promise<SessionListResponse> {
		return this.transport.get<SessionListResponse>("/api/sessions");
	}
	async getSession(key: string): Promise<SessionInfo> {
		return this.transport.get<SessionInfo>(`/api/sessions/${key}`);
	}
	async setSessionBypass(key: string, enabled: boolean): Promise<{ key: string; bypassed: boolean }> {
		return this.transport.post<{ key: string; bypassed: boolean }>(`/api/sessions/${key}/bypass`, { enabled });
	}
	async getGitStatus(): Promise<GitStatus> {
		return this.transport.get<GitStatus>("/api/git/status");
	}
	async gitPull(): Promise<GitPullResult> {
		return this.transport.post<GitPullResult>("/api/git/pull", {});
	}
	async gitPush(): Promise<GitPushResult> {
		return this.transport.post<GitPushResult>("/api/git/push", {});
	}
	async gitSync(): Promise<GitSyncResult> {
		return this.transport.post<GitSyncResult>("/api/git/sync", {});
	}
	async getGitConfig(): Promise<GitConfig> {
		return this.transport.get<GitConfig>("/api/git/config");
	}
	async updateGitConfig(patch: Partial<GitConfig>): Promise<{ success: boolean; config: GitConfig }> {
		return this.transport.post<{ success: boolean; config: GitConfig }>("/api/git/config", patch);
	}
	async listSecrets(): Promise<SecretListResponse> {
		return this.transport.get<SecretListResponse>("/api/secrets");
	}
	async storeSecret(name: string, value: string): Promise<{ success: boolean; name: string }> {
		return this.transport.post<{ success: boolean; name: string }>(`/api/secrets/${name}`, { value });
	}
	async deleteSecret(name: string): Promise<{ success: boolean; name: string }> {
		return this.transport.del<{ success: boolean; name: string }>(`/api/secrets/${name}`);
	}
	async execWithSecrets(
		command: string,
		secrets: Record<string, string>,
		options: SecretExecOptions = {},
	): Promise<SecretExecJob> {
		return this.transport.post<SecretExecJob>("/api/secrets/exec", {
			command,
			secrets,
			...options,
		});
	}
	async getSecretExecJob(jobId: string): Promise<SecretExecJob> {
		return this.transport.get<SecretExecJob>(`/api/secrets/exec/${jobId}`);
	}
	async getBitwardenStatus(): Promise<BitwardenStatus> {
		return this.transport.get<BitwardenStatus>("/api/secrets/bitwarden/status");
	}
	async connectBitwarden(
		session: string,
		options: { readonly activate?: boolean; readonly folderId?: string } = {},
	): Promise<BitwardenConnectResult> {
		return this.transport.post<BitwardenConnectResult>("/api/secrets/bitwarden/connect", {
			session,
			...options,
		});
	}
	async disconnectBitwarden(): Promise<{
		success: boolean;
		disconnected: boolean;
		existed: boolean;
		activeProvider: boolean;
	}> {
		return this.transport.del<{ success: boolean; disconnected: boolean; existed: boolean; activeProvider: boolean }>(
			"/api/secrets/bitwarden/connect",
		);
	}
	async setSecretProvider(
		provider: "local" | "bitwarden",
	): Promise<{ success: boolean; provider: "local" | "bitwarden" }> {
		return this.transport.post<{ success: boolean; provider: "local" | "bitwarden" }>(
			"/api/secrets/bitwarden/provider",
			{
				provider,
			},
		);
	}
	async listBitwardenFolders(): Promise<{
		folders: readonly { readonly id: string; readonly name: string }[];
		count: number;
	}> {
		return this.transport.get<{ folders: readonly { readonly id: string; readonly name: string }[]; count: number }>(
			"/api/secrets/bitwarden/folders",
		);
	}
	async migrateSecretsToBitwarden(
		opts: {
			readonly dryRun?: boolean;
			readonly deleteLocal?: boolean;
			readonly overwrite?: boolean;
			readonly folderId?: string;
		} = {},
	): Promise<BitwardenMigrationResult> {
		return this.transport.post<BitwardenMigrationResult>("/api/secrets/bitwarden/migrate", opts);
	}
	async getOnePasswordStatus(): Promise<OnePasswordStatus> {
		return this.transport.get<OnePasswordStatus>("/api/secrets/1password/status");
	}
	async connectOnePassword(token: string): Promise<OnePasswordConnectResult> {
		return this.transport.post<OnePasswordConnectResult>("/api/secrets/1password/connect", { token });
	}
	async disconnectOnePassword(): Promise<{ success: boolean; disconnected: boolean; existed: boolean }> {
		return this.transport.del<{ success: boolean; disconnected: boolean; existed: boolean }>(
			"/api/secrets/1password/connect",
		);
	}
	async listOnePasswordVaults(): Promise<{
		vaults: readonly { readonly id: string; readonly name: string }[];
		count: number;
	}> {
		return this.transport.get<{ vaults: readonly { readonly id: string; readonly name: string }[]; count: number }>(
			"/api/secrets/1password/vaults",
		);
	}
	async importOnePasswordSecrets(opts: {
		readonly token?: string;
		readonly vaults?: readonly string[];
		readonly prefix?: string;
		readonly overwrite?: boolean;
	}): Promise<OnePasswordImportResult> {
		return this.transport.post<OnePasswordImportResult>("/api/secrets/1password/import", opts);
	}
	async listPlugins(): Promise<PluginListResponse> {
		return this.transport.get<PluginListResponse>("/api/plugins");
	}
	async getPlugin(id: string): Promise<PluginRegistryRecord> {
		return this.transport.get<PluginRegistryRecord>(`/api/plugins/${id}`);
	}
	async getPluginDiagnostics(id: string): Promise<PluginDiagnosticsResponse> {
		return this.transport.get<PluginDiagnosticsResponse>(`/api/plugins/${id}/diagnostics`);
	}
	async listPluginPromptContributions(): Promise<PluginPromptContributionListResponse> {
		return this.transport.get<PluginPromptContributionListResponse>("/api/plugins/prompt-contributions");
	}
	async listPluginAuditEvents(opts?: {
		readonly pluginId?: string;
		readonly event?: string;
		readonly since?: string;
		readonly until?: string;
		readonly limit?: number;
	}): Promise<PluginAuditListResponse> {
		return this.transport.get<PluginAuditListResponse>("/api/plugins/audit", {
			pluginId: opts?.pluginId,
			event: opts?.event,
			since: opts?.since,
			until: opts?.until,
			limit: opts?.limit,
		});
	}
	async listSkills(): Promise<SkillListResponse> {
		return this.transport.get<SkillListResponse>("/api/skills");
	}
	async browseSkills(): Promise<SkillBrowseResponse> {
		return this.transport.get<SkillBrowseResponse>("/api/skills/browse");
	}
	async searchSkills(query: string): Promise<SkillSearchResponse> {
		return this.transport.get<SkillSearchResponse>("/api/skills/search", { q: query });
	}
	async getSkill(name: string, source?: string): Promise<SkillGetResponse> {
		return this.transport.get<SkillGetResponse>(`/api/skills/${name}`, {
			source,
		});
	}
	async installSkill(name: string, source?: string): Promise<SkillInstallResult> {
		return this.transport.post<SkillInstallResult>("/api/skills/install", {
			name,
			source,
		});
	}
	async uninstallSkill(name: string): Promise<SkillDeleteResult> {
		return this.transport.del<SkillDeleteResult>(`/api/skills/${name}`);
	}
}

export interface SignetClient extends SignetClientP2 {}
for (const key of Reflect.ownKeys(SignetClientP2.prototype)) {
	if (key === "constructor") continue;
	const descriptor = Object.getOwnPropertyDescriptor(SignetClientP2.prototype, key);
	if (descriptor) {
		Object.defineProperty(SignetClient.prototype, key, descriptor);
	}
}
export const SignetSDK = SignetClient;
export const Signet = SignetClient;
export type { SignetTransport } from "./transport.js";
export {
	SignetApiError,
	SignetError,
	SignetNetworkError,
	SignetTimeoutError,
} from "./errors.js";
export type {
	AccountingCoverage,
	AccountingCoverageTotals,
	AccountingProvenance,
	AccountingSummaryProvenance,
	AggregateRecallUsage,
	AggregateRecallUsageStage,
	BatchModifyItemResult,
	BatchModifyResponse,
	CheckpointListResponse,
	ConfigListResponse,
	ConfigWriteResponse,
	DeleteResult,
	DocumentChunksResponse,
	DocumentCreateResult,
	DocumentDeleteResult,
	DocumentListResponse,
	DocumentRecord,
	DreamingCacheAccounting,
	DreamingCacheAccountingTotals,
	EmbeddingHealthResponse,
	EmbeddingProjectionResponse,
	EmbeddingStatusResponse,
	FeaturesResponse,
	ForgetExecuteResponse,
	ForgetPreviewResponse,
	ForgetResponse,
	GitConfig,
	GitPullResult,
	GitPushResult,
	GitStatus,
	GitSyncResult,
	GreetingResponse,
	HarnessListResponse,
	HarnessRegenerateResponse,
	HealthResponse,
	HistoryEvent,
	HistoryResponse,
	IdentityResponse,
	JobStatus,
	MemoryListResponse,
	MemoryRecord,
	MemorySearchTelemetryItem,
	MemorySearchTelemetryResponse,
	MemorySearchTelemetryResult,
	ModifyResult,
	BitwardenConnectResult,
	BitwardenMigrationResult,
	BitwardenStatus,
	OnePasswordConnectResult,
	OnePasswordImportResult,
	OnePasswordStatus,
	PipelineStatusResponse,
	PluginAuditEvent,
	PluginAuditListResponse,
	PluginAuditResult,
	PluginAuditSource,
	PluginConnectorSummary,
	PluginDashboardSummary,
	PluginDiagnosticsResponse,
	PluginHealth,
	PluginLifecycleState,
	PluginListResponse,
	PluginPromptContribution,
	PluginPromptContributionDiagnostic,
	PluginPromptContributionListResponse,
	PluginPromptMode,
	PluginPromptSummary,
	PluginPromptTarget,
	PluginRegistryRecord,
	PluginRouteSummary,
	PluginSdkSummary,
	PluginSurfaceBase,
	PluginSurfaceSummary,
	PluginToolSummary,
	RecallResponse,
	RecallResult,
	RecoverResult,
	SdkRecallOptions,
	RememberResult,
	SecretExecJob,
	SecretExecOptions,
	SecretExecResult,
	SecretListResponse,
	SessionInfo,
	SessionListResponse,
	SkillBrowseResponse,
	SkillBrowseResult,
	SkillDeleteResult,
	SkillGetResponse,
	SkillInstallResult,
	SkillListResponse,
	SkillMeta,
	SkillSearchResponse,
	StatusResponse,
	TelemetryEventsResponse,
	TelemetryStatsResponse,
	TimelineExportResponse,
	TimelineResponse,
	InstalledSkill,
} from "./types.js";

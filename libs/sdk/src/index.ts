import type { RequestControl } from "./transport.js";
import { parseRememberResponse } from "@signet/core/remember";
import { buildRecallRequestBody } from "@signet/core/recall";
import { SignetClientP2 } from "./client-p2.js";
import { SignetClientHelpers, applyRecallMinScore } from "./helpers.js";
import { SignetTransport, type CredentialProvider } from "./transport.js";
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
	readonly transport?: SignetTransport;
	readonly timeoutMs?: number;
	readonly retries?: number;
	readonly credentialProvider?: CredentialProvider;
	readonly cookieAuth?: boolean;
	readonly runtimePath?: string;
}

// biome-ignore lint/suspicious/noUnsafeDeclarationMerging: P2 methods are mixed into SignetClient below for compatibility.
export class SignetClient extends SignetClientHelpers {
	constructor(config?: SignetClientConfig) {
		if (config?.transport) {
			super(config.transport);
			return;
		}
		if (!config?.daemonUrl) throw new TypeError("daemonUrl is required; use @signet/sdk/node to resolve a target");
		super(
			new SignetTransport({
				baseUrl: config.daemonUrl,
				timeoutMs: config.timeoutMs,
				retries: config.retries,
				credentialProvider: config.credentialProvider,
				cookieAuth: config.cookieAuth,
				headers: config.runtimePath ? { "x-signet-runtime-path": config.runtimePath } : undefined,
			}),
		);
	}

	async remember(
		content: string,
		opts?: {
			readonly type?: string;
			readonly importance?: number;
			readonly tags?: string;
			readonly who?: string;
			readonly project?: string;
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
		control?: RequestControl,
	): Promise<RememberResult> {
		return parseRememberResponse(
			await this.transport.post<unknown>(
				"/api/memory/remember",
				{
					content,
					...opts,
				},
				control,
			),
		);
	}

	async recall(query: string, opts?: SdkRecallOptions, control?: RequestControl): Promise<RecallResponse> {
		const { minScore, ...requestOptions } = opts ?? {};
		return applyRecallMinScore(
			await this.transport.post<RecallResponse>(
				"/api/memory/recall",
				buildRecallRequestBody(query, { ...requestOptions, minScore }),
				control,
			),
			minScore,
		);
	}

	async getMemory(id: string, control?: RequestControl): Promise<MemoryRecord> {
		return this.transport.get<MemoryRecord>(`/api/memory/${id}`, undefined, control);
	}

	async listMemories(
		opts?: {
			readonly limit?: number;
			readonly offset?: number;
			readonly type?: string;
		},
		control?: RequestControl,
	): Promise<MemoryListResponse> {
		return this.transport.get<MemoryListResponse>(
			"/api/memories",
			{
				limit: opts?.limit,
				offset: opts?.offset,
				type: opts?.type,
			},
			control,
		);
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
		control?: RequestControl,
	): Promise<ModifyResult> {
		const { ifVersion, ...rest } = patch;
		return this.transport.patch<ModifyResult>(
			`/api/memory/${id}`,
			{
				...rest,
				if_version: ifVersion,
			},
			control,
		);
	}

	async forgetMemory(
		id: string,
		opts: {
			readonly reason: string;
			readonly force?: boolean;
			readonly ifVersion?: number;
		},
		control?: RequestControl,
	): Promise<DeleteResult> {
		return this.transport.del<DeleteResult>(
			`/api/memory/${id}`,
			{
				reason: opts.reason,
				force: opts.force,
				if_version: opts.ifVersion,
			},
			control,
		);
	}

	async batchForget(
		opts: {
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
		},
		control?: RequestControl,
	): Promise<ForgetResponse> {
		return this.transport.post<ForgetResponse>("/api/memory/forget", opts, control);
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
		control?: RequestControl,
	): Promise<BatchModifyResponse> {
		const mapped = patches.map(({ ifVersion, ...rest }) => ({
			...rest,
			if_version: ifVersion,
		}));
		return this.transport.post<BatchModifyResponse>(
			"/api/memory/modify",
			{
				patches: mapped,
				...opts,
			},
			control,
		);
	}

	async getHistory(
		memoryId: string,
		opts?: { readonly limit?: number },
		control?: RequestControl,
	): Promise<HistoryResponse> {
		return this.transport.get<HistoryResponse>(`/api/memory/${memoryId}/history`, { limit: opts?.limit }, control);
	}

	async recoverMemory(
		id: string,
		opts?: {
			readonly reason?: string;
			readonly ifVersion?: number;
		},
		control?: RequestControl,
	): Promise<RecoverResult> {
		return this.transport.post<RecoverResult>(
			`/api/memory/${id}/recover`,
			{
				reason: opts?.reason,
				if_version: opts?.ifVersion,
			},
			control,
		);
	}

	async getJob(jobId: string, control?: RequestControl): Promise<JobStatus> {
		return this.transport.get<JobStatus>(`/api/memory/jobs/${jobId}`, undefined, control);
	}

	async createDocument(
		opts: {
			readonly source_type: "text" | "url" | "file";
			readonly content?: string;
			readonly url?: string;
			readonly title?: string;
			readonly content_type?: string;
			readonly connector_id?: string;
			readonly metadata?: Record<string, unknown>;
		},
		control?: RequestControl,
	): Promise<DocumentCreateResult> {
		return this.transport.post<DocumentCreateResult>("/api/documents", opts, control);
	}

	async getDocument(id: string, control?: RequestControl): Promise<DocumentRecord> {
		return this.transport.get<DocumentRecord>(`/api/documents/${id}`, undefined, control);
	}

	async listDocuments(
		opts?: {
			readonly status?: string;
			readonly limit?: number;
			readonly offset?: number;
		},
		control?: RequestControl,
	): Promise<DocumentListResponse> {
		return this.transport.get<DocumentListResponse>(
			"/api/documents",
			{
				status: opts?.status,
				limit: opts?.limit,
				offset: opts?.offset,
			},
			control,
		);
	}

	async getDocumentChunks(id: string, control?: RequestControl): Promise<DocumentChunksResponse> {
		return this.transport.get<DocumentChunksResponse>(`/api/documents/${id}/chunks`, undefined, control);
	}

	async deleteDocument(id: string, reason: string, control?: RequestControl): Promise<DocumentDeleteResult> {
		return this.transport.del<DocumentDeleteResult>(`/api/documents/${id}`, { reason }, control);
	}

	async health(control?: RequestControl): Promise<HealthResponse> {
		return this.transport.get<HealthResponse>("/health", undefined, control);
	}

	async status(control?: RequestControl): Promise<StatusResponse> {
		return this.transport.get<StatusResponse>("/api/status", undefined, control);
	}

	async diagnostics(domain?: string, control?: RequestControl): Promise<unknown> {
		const path = domain ? `/api/diagnostics/${domain}` : "/api/diagnostics";
		return this.transport.get<unknown>(path, undefined, control);
	}

	async createToken(
		opts: {
			readonly role: string;
			readonly scope?: {
				readonly project?: string;
				readonly agent?: string;
				readonly user?: string;
			};
			readonly ttlSeconds?: number;
		},
		control?: RequestControl,
	): Promise<{ token: string; expiresAt: string }> {
		return this.transport.post<{ token: string; expiresAt: string }>("/api/auth/token", opts, control);
	}

	async whoami(control?: RequestControl): Promise<{ authenticated: boolean; claims: unknown }> {
		return this.transport.get<{ authenticated: boolean; claims: unknown }>("/api/auth/whoami", undefined, control);
	}
	async getTimeline(entityId: string, control?: RequestControl): Promise<TimelineResponse> {
		return this.transport.get<TimelineResponse>(`/api/timeline/${entityId}`, undefined, control);
	}
	async exportTimeline(entityId: string, control?: RequestControl): Promise<TimelineExportResponse> {
		return this.transport.get<TimelineExportResponse>(`/api/timeline/${entityId}/export`, undefined, control);
	}
	async getPipelineStatus(control?: RequestControl): Promise<PipelineStatusResponse> {
		return this.transport.get<PipelineStatusResponse>("/api/pipeline/status", undefined, control);
	}
	async getTelemetryEvents(
		opts?: {
			readonly event?: string;
			readonly since?: string;
			readonly until?: string;
			readonly limit?: number;
		},
		control?: RequestControl,
	): Promise<TelemetryEventsResponse> {
		return this.transport.get<TelemetryEventsResponse>(
			"/api/telemetry/events",
			{
				event: opts?.event,
				since: opts?.since,
				until: opts?.until,
				limit: opts?.limit,
			},
			control,
		);
	}
	async getTelemetryStats(
		opts?: { readonly since?: string },
		control?: RequestControl,
	): Promise<TelemetryStatsResponse> {
		return this.transport.get<TelemetryStatsResponse>(
			"/api/telemetry/stats",
			{
				since: opts?.since,
			},
			control,
		);
	}
	async exportTelemetry(
		opts?: { readonly since?: string; readonly limit?: number },
		control?: RequestControl,
	): Promise<string> {
		return this.transport.get<string>(
			"/api/telemetry/export",
			{
				since: opts?.since,
				limit: opts?.limit,
			},
			control,
		);
	}
	async getMemorySearchTelemetry(
		opts?: {
			readonly agentId?: string;
			readonly sessionKey?: string;
			readonly route?: string;
			readonly since?: string;
			readonly until?: string;
			readonly noHits?: boolean;
			readonly limit?: number;
			readonly offset?: number;
		},
		control?: RequestControl,
	): Promise<MemorySearchTelemetryResponse> {
		return this.transport.get<MemorySearchTelemetryResponse>(
			"/api/telemetry/memory-search",
			{
				agent_id: opts?.agentId,
				session_key: opts?.sessionKey,
				route: opts?.route,
				since: opts?.since,
				until: opts?.until,
				no_hits: opts?.noHits,
				limit: opts?.limit,
				offset: opts?.offset,
			},
			control,
		);
	}
	async exportMemorySearchTelemetry(
		opts?: {
			readonly agentId?: string;
			readonly sessionKey?: string;
			readonly route?: string;
			readonly since?: string;
			readonly until?: string;
			readonly noHits?: boolean;
			readonly limit?: number;
		},
		control?: RequestControl,
	): Promise<string> {
		return this.transport.get<string>(
			"/api/telemetry/memory-search/export",
			{
				agent_id: opts?.agentId,
				session_key: opts?.sessionKey,
				route: opts?.route,
				since: opts?.since,
				until: opts?.until,
				no_hits: opts?.noHits,
				limit: opts?.limit,
			},
			control,
		);
	}
	async listConfig(control?: RequestControl): Promise<ConfigListResponse> {
		return this.transport.get<ConfigListResponse>("/api/config", undefined, control);
	}
	async writeConfig(file: string, content: string, control?: RequestControl): Promise<ConfigWriteResponse> {
		return this.transport.post<ConfigWriteResponse>(
			"/api/config",
			{
				file,
				content,
			},
			control,
		);
	}
	async getIdentity(control?: RequestControl): Promise<IdentityResponse> {
		return this.transport.get<IdentityResponse>("/api/identity", undefined, control);
	}
	async getEmbeddingStatus(control?: RequestControl): Promise<EmbeddingStatusResponse> {
		return this.transport.get<EmbeddingStatusResponse>("/api/embeddings/status", undefined, control);
	}
	async getEmbeddingHealth(control?: RequestControl): Promise<EmbeddingHealthResponse> {
		return this.transport.get<EmbeddingHealthResponse>("/api/embeddings/health", undefined, control);
	}
	async getEmbeddingProjection(
		opts?: { readonly dimensions?: 2 | 3 },
		control?: RequestControl,
	): Promise<EmbeddingProjectionResponse> {
		return this.transport.get<EmbeddingProjectionResponse>(
			"/api/embeddings/projection",
			{
				dimensions: opts?.dimensions,
			},
			control,
		);
	}
	async listHarnesses(control?: RequestControl): Promise<HarnessListResponse> {
		return this.transport.get<HarnessListResponse>("/api/harnesses", undefined, control);
	}
	async regenerateHarnesses(control?: RequestControl): Promise<HarnessRegenerateResponse> {
		return this.transport.post<HarnessRegenerateResponse>("/api/harnesses/regenerate", {}, control);
	}
	async listCheckpoints(
		opts: { readonly project: string; readonly limit?: number },
		control?: RequestControl,
	): Promise<CheckpointListResponse> {
		return this.transport.get<CheckpointListResponse>(
			"/api/checkpoints",
			{
				project: opts.project,
				limit: opts.limit,
			},
			control,
		);
	}
	async listSessionCheckpoints(sessionKey: string, control?: RequestControl): Promise<CheckpointListResponse> {
		return this.transport.get<CheckpointListResponse>(`/api/checkpoints/${sessionKey}`, undefined, control);
	}
	async getFeatures(control?: RequestControl): Promise<FeaturesResponse> {
		return this.transport.get<FeaturesResponse>("/api/features", undefined, control);
	}
	async getGreeting(control?: RequestControl): Promise<GreetingResponse> {
		return this.transport.get<GreetingResponse>("/api/home/greeting", undefined, control);
	}
	async listSessions(control?: RequestControl): Promise<SessionListResponse> {
		return this.transport.get<SessionListResponse>("/api/sessions", undefined, control);
	}
	async getSession(key: string, control?: RequestControl): Promise<SessionInfo> {
		return this.transport.get<SessionInfo>(`/api/sessions/${key}`, undefined, control);
	}
	async setSessionBypass(
		key: string,
		enabled: boolean,
		control?: RequestControl,
	): Promise<{ key: string; bypassed: boolean }> {
		return this.transport.post<{ key: string; bypassed: boolean }>(`/api/sessions/${key}/bypass`, { enabled }, control);
	}
	async getGitStatus(control?: RequestControl): Promise<GitStatus> {
		return this.transport.get<GitStatus>("/api/git/status", undefined, control);
	}
	async gitPull(control?: RequestControl): Promise<GitPullResult> {
		return this.transport.post<GitPullResult>("/api/git/pull", {}, control);
	}
	async gitPush(control?: RequestControl): Promise<GitPushResult> {
		return this.transport.post<GitPushResult>("/api/git/push", {}, control);
	}
	async gitSync(control?: RequestControl): Promise<GitSyncResult> {
		return this.transport.post<GitSyncResult>("/api/git/sync", {}, control);
	}
	async getGitConfig(control?: RequestControl): Promise<GitConfig> {
		return this.transport.get<GitConfig>("/api/git/config", undefined, control);
	}
	async updateGitConfig(
		patch: Partial<GitConfig>,
		control?: RequestControl,
	): Promise<{ success: boolean; config: GitConfig }> {
		return this.transport.post<{ success: boolean; config: GitConfig }>("/api/git/config", patch, control);
	}
	async listSecrets(control?: RequestControl): Promise<SecretListResponse> {
		return this.transport.get<SecretListResponse>("/api/secrets", undefined, control);
	}
	async storeSecret(
		name: string,
		value: string,
		control?: RequestControl,
	): Promise<{ success: boolean; name: string }> {
		return this.transport.post<{ success: boolean; name: string }>(`/api/secrets/${name}`, { value }, control);
	}
	async deleteSecret(name: string, control?: RequestControl): Promise<{ success: boolean; name: string }> {
		return this.transport.del<{ success: boolean; name: string }>(`/api/secrets/${name}`, undefined, control);
	}
	async execWithSecrets(
		command: string,
		secrets: Record<string, string>,
		options: SecretExecOptions = {},
		control?: RequestControl,
	): Promise<SecretExecJob> {
		return this.transport.post<SecretExecJob>(
			"/api/secrets/exec",
			{
				command,
				secrets,
				...options,
			},
			control,
		);
	}
	async getSecretExecJob(jobId: string, control?: RequestControl): Promise<SecretExecJob> {
		return this.transport.get<SecretExecJob>(`/api/secrets/exec/${jobId}`, undefined, control);
	}
	async getBitwardenStatus(control?: RequestControl): Promise<BitwardenStatus> {
		return this.transport.get<BitwardenStatus>("/api/secrets/bitwarden/status", undefined, control);
	}
	async connectBitwarden(
		session: string,
		options: { readonly activate?: boolean; readonly folderId?: string } = {},
		control?: RequestControl,
	): Promise<BitwardenConnectResult> {
		return this.transport.post<BitwardenConnectResult>(
			"/api/secrets/bitwarden/connect",
			{
				session,
				...options,
			},
			control,
		);
	}
	async disconnectBitwarden(control?: RequestControl): Promise<{
		success: boolean;
		disconnected: boolean;
		existed: boolean;
		activeProvider: boolean;
	}> {
		return this.transport.del<{ success: boolean; disconnected: boolean; existed: boolean; activeProvider: boolean }>(
			"/api/secrets/bitwarden/connect",
			undefined,
			control,
		);
	}
	async setSecretProvider(
		provider: "local" | "bitwarden",
		control?: RequestControl,
	): Promise<{ success: boolean; provider: "local" | "bitwarden" }> {
		return this.transport.post<{ success: boolean; provider: "local" | "bitwarden" }>(
			"/api/secrets/bitwarden/provider",
			{
				provider,
			},
			control,
		);
	}
	async listBitwardenFolders(control?: RequestControl): Promise<{
		folders: readonly { readonly id: string; readonly name: string }[];
		count: number;
	}> {
		return this.transport.get<{ folders: readonly { readonly id: string; readonly name: string }[]; count: number }>(
			"/api/secrets/bitwarden/folders",
			undefined,
			control,
		);
	}
	async migrateSecretsToBitwarden(
		opts: {
			readonly dryRun?: boolean;
			readonly deleteLocal?: boolean;
			readonly overwrite?: boolean;
			readonly folderId?: string;
		} = {},
		control?: RequestControl,
	): Promise<BitwardenMigrationResult> {
		return this.transport.post<BitwardenMigrationResult>("/api/secrets/bitwarden/migrate", opts, control);
	}
	async getOnePasswordStatus(control?: RequestControl): Promise<OnePasswordStatus> {
		return this.transport.get<OnePasswordStatus>("/api/secrets/1password/status", undefined, control);
	}
	async connectOnePassword(token: string, control?: RequestControl): Promise<OnePasswordConnectResult> {
		return this.transport.post<OnePasswordConnectResult>("/api/secrets/1password/connect", { token }, control);
	}
	async disconnectOnePassword(
		control?: RequestControl,
	): Promise<{ success: boolean; disconnected: boolean; existed: boolean }> {
		return this.transport.del<{ success: boolean; disconnected: boolean; existed: boolean }>(
			"/api/secrets/1password/connect",
			undefined,
			control,
		);
	}
	async listOnePasswordVaults(control?: RequestControl): Promise<{
		vaults: readonly { readonly id: string; readonly name: string }[];
		count: number;
	}> {
		return this.transport.get<{ vaults: readonly { readonly id: string; readonly name: string }[]; count: number }>(
			"/api/secrets/1password/vaults",
			undefined,
			control,
		);
	}
	async importOnePasswordSecrets(
		opts: {
			readonly token?: string;
			readonly vaults?: readonly string[];
			readonly prefix?: string;
			readonly overwrite?: boolean;
		},
		control?: RequestControl,
	): Promise<OnePasswordImportResult> {
		return this.transport.post<OnePasswordImportResult>("/api/secrets/1password/import", opts, control);
	}
	async listPlugins(control?: RequestControl): Promise<PluginListResponse> {
		return this.transport.get<PluginListResponse>("/api/plugins", undefined, control);
	}
	async getPlugin(id: string, control?: RequestControl): Promise<PluginRegistryRecord> {
		return this.transport.get<PluginRegistryRecord>(`/api/plugins/${id}`, undefined, control);
	}
	async getPluginDiagnostics(id: string, control?: RequestControl): Promise<PluginDiagnosticsResponse> {
		return this.transport.get<PluginDiagnosticsResponse>(`/api/plugins/${id}/diagnostics`, undefined, control);
	}
	async listPluginPromptContributions(control?: RequestControl): Promise<PluginPromptContributionListResponse> {
		return this.transport.get<PluginPromptContributionListResponse>(
			"/api/plugins/prompt-contributions",
			undefined,
			control,
		);
	}
	async listPluginAuditEvents(
		opts?: {
			readonly pluginId?: string;
			readonly event?: string;
			readonly since?: string;
			readonly until?: string;
			readonly limit?: number;
		},
		control?: RequestControl,
	): Promise<PluginAuditListResponse> {
		return this.transport.get<PluginAuditListResponse>(
			"/api/plugins/audit",
			{
				pluginId: opts?.pluginId,
				event: opts?.event,
				since: opts?.since,
				until: opts?.until,
				limit: opts?.limit,
			},
			control,
		);
	}
	async listSkills(control?: RequestControl): Promise<SkillListResponse> {
		return this.transport.get<SkillListResponse>("/api/skills", undefined, control);
	}
	async browseSkills(control?: RequestControl): Promise<SkillBrowseResponse> {
		return this.transport.get<SkillBrowseResponse>("/api/skills/browse", undefined, control);
	}
	async searchSkills(query: string, control?: RequestControl): Promise<SkillSearchResponse> {
		return this.transport.get<SkillSearchResponse>("/api/skills/search", { q: query }, control);
	}
	async getSkill(name: string, source?: string, control?: RequestControl): Promise<SkillGetResponse> {
		return this.transport.get<SkillGetResponse>(
			`/api/skills/${name}`,
			{
				source,
			},
			control,
		);
	}
	async installSkill(name: string, source?: string, control?: RequestControl): Promise<SkillInstallResult> {
		return this.transport.post<SkillInstallResult>(
			"/api/skills/install",
			{
				name,
				source,
			},
			control,
		);
	}
	async uninstallSkill(name: string, control?: RequestControl): Promise<SkillDeleteResult> {
		return this.transport.del<SkillDeleteResult>(`/api/skills/${name}`, undefined, control);
	}
}

export interface SignetClient extends Pick<SignetClientP2, keyof SignetClientP2> {}
for (const key of Reflect.ownKeys(SignetClientP2.prototype)) {
	if (key === "constructor") continue;
	const descriptor = Object.getOwnPropertyDescriptor(SignetClientP2.prototype, key);
	if (descriptor) {
		Object.defineProperty(SignetClient.prototype, key, descriptor);
	}
}
export const SignetSDK = SignetClient;
export const Signet = SignetClient;
export { SignetResponseError } from "./errors.js";
export { SignetTransport } from "./transport.js";
export type { CredentialProvider, RequestControl, RequestOptions, TransportConfig, Query } from "./transport.js";
export {
	SignetApiError,
	SignetUnauthorizedError,
	SignetOutboxAdmissionError,
	SignetForbiddenError,
	type UnauthorizedReason,
	type ForbiddenReason,
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

export { SignetCredentialError } from "./errors.js";

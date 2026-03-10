/**
 * @signet/sdk — HTTP client for the Signet daemon API.
 * No native dependencies (no SQLite, no @signet/core).
 */

import { SignetClientP2 } from "./client-p2.js";
import { SignetClientHelpers } from "./helpers.js";
import { SignetTransport } from "./transport.js";
import type {
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
	ModifyResult,
	OnePasswordConnectResult,
	OnePasswordImportResult,
	OnePasswordStatus,
	PipelineStatusResponse,
	RecallResponse,
	RecoverResult,
	RememberResult,
	SecretExecResult,
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
	TaskCreatePayload,
	TaskCreateResult,
	TaskGetResponse,
	TaskListResponse,
	TaskRecord,
	TaskRun,
	TaskRunListResponse,
	TaskUpdatePayload,
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
}

export class SignetClient extends SignetClientHelpers {
	constructor(config?: SignetClientConfig) {
		const headers: Record<string, string> = {};
		if (config?.token) {
			headers["Authorization"] = `Bearer ${config.token}`;
		}
		if (config?.actor) {
			headers["x-signet-actor"] = config.actor;
		}
		if (config?.actorType) {
			headers["x-signet-actor-type"] = config.actorType;
		}

		const transport = new SignetTransport({
			baseUrl: config?.daemonUrl ?? "http://localhost:3850",
			timeoutMs: config?.timeoutMs ?? 10_000,
			retries: config?.retries ?? 2,
			headers: Object.keys(headers).length > 0 ? headers : undefined,
		});

		super(transport);
	}

	// --- Memory lifecycle ---

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

	async recall(
		query: string,
		opts?: {
			readonly limit?: number;
			readonly type?: string;
			readonly tags?: string;
			readonly who?: string;
			readonly pinned?: boolean;
			readonly importance_min?: number;
			readonly since?: string;
			readonly minScore?: number;
		},
	): Promise<RecallResponse> {
		return this.transport.post<RecallResponse>("/api/memory/recall", {
			query,
			...opts,
		});
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

	// --- Jobs ---

	async getJob(jobId: string): Promise<JobStatus> {
		return this.transport.get<JobStatus>(`/api/memory/jobs/${jobId}`);
	}

	// --- Documents ---

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

	// --- Health / status ---

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

	// --- Auth ---

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

	// --- Timeline ---

	/**
	 * Get timeline events for an entity.
	 *
	 * @example
	 * ```typescript
	 * const timeline = await client.getTimeline("mem-abc-123");
	 * console.log(timeline.events[0].event);
	 * ```
	 */
	async getTimeline(entityId: string): Promise<TimelineResponse> {
		return this.transport.get<TimelineResponse>(`/api/timeline/${entityId}`);
	}

	/**
	 * Export timeline with metadata.
	 *
	 * @example
	 * ```typescript
	 * const export = await client.exportTimeline("mem-abc-123");
	 * console.log(export.meta.version);
	 * ```
	 */
	async exportTimeline(entityId: string): Promise<TimelineExportResponse> {
		return this.transport.get<TimelineExportResponse>(`/api/timeline/${entityId}/export`);
	}

	// --- Pipeline ---

	/**
	 * Get pipeline status snapshot.
	 *
	 * @example
	 * ```typescript
	 * const status = await client.getPipelineStatus();
	 * console.log(status.mode); // "shadow" | "controlled-write" | "frozen" | "disabled"
	 * ```
	 */
	async getPipelineStatus(): Promise<PipelineStatusResponse> {
		return this.transport.get<PipelineStatusResponse>("/api/pipeline/status");
	}

	// --- Telemetry ---

	/**
	 * Query telemetry events.
	 *
	 * @example
	 * ```typescript
	 * const events = await client.getTelemetryEvents({
	 *   event: "llm.generate",
	 *   limit: 50
	 * });
	 * console.log(events.enabled, events.events.length);
	 * ```
	 */
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

	/**
	 * Get aggregated telemetry statistics.
	 *
	 * @example
	 * ```typescript
	 * const stats = await client.getTelemetryStats({ since: "2024-01-01" });
	 * if (stats.enabled) {
	 *   console.log(stats.llm.calls, stats.llm.totalCost);
	 * }
	 * ```
	 */
	async getTelemetryStats(opts?: {
		readonly since?: string;
	}): Promise<TelemetryStatsResponse> {
		return this.transport.get<TelemetryStatsResponse>("/api/telemetry/stats", {
			since: opts?.since,
		});
	}

	/**
	 * Export telemetry events as NDJSON text.
	 *
	 * @example
	 * ```typescript
	 * const ndjson = await client.exportTelemetry({ limit: 1000 });
	 * const events = ndjson.split("\n").map(JSON.parse);
	 * ```
	 */
	async exportTelemetry(opts?: {
		readonly since?: string;
		readonly limit?: number;
	}): Promise<string> {
		return this.transport.get<string>("/api/telemetry/export", {
			since: opts?.since,
			limit: opts?.limit,
		});
	}

	// --- Config / Identity ---

	/**
	 * List all config files.
	 *
	 * @example
	 * ```typescript
	 * const config = await client.listConfig();
	 * const agentsMd = config.files.find(f => f.name === "AGENTS.md");
	 * console.log(agentsMd?.content);
	 * ```
	 */
	async listConfig(): Promise<ConfigListResponse> {
		return this.transport.get<ConfigListResponse>("/api/config");
	}

	/**
	 * Write a config file.
	 *
	 * @example
	 * ```typescript
	 * await client.writeConfig("USER.md", "# User\n\n- Location: Seattle");
	 * ```
	 */
	async writeConfig(file: string, content: string): Promise<ConfigWriteResponse> {
		return this.transport.post<ConfigWriteResponse>("/api/config", {
			file,
			content,
		});
	}

	/**
	 * Get parsed identity from IDENTITY.md.
	 *
	 * @example
	 * ```typescript
	 * const identity = await client.getIdentity();
	 * console.log(identity.name, identity.creature);
	 * ```
	 */
	async getIdentity(): Promise<IdentityResponse> {
		return this.transport.get<IdentityResponse>("/api/identity");
	}

	// --- Embeddings ---

	/**
	 * Get embedding status.
	 *
	 * @example
	 * ```typescript
	 * const status = await client.getEmbeddingStatus();
	 * console.log(status.provider, status.model, status.available);
	 * ```
	 */
	async getEmbeddingStatus(): Promise<EmbeddingStatusResponse> {
		return this.transport.get<EmbeddingStatusResponse>("/api/embeddings/status");
	}

	/**
	 * Get embedding health metrics.
	 *
	 * @example
	 * ```typescript
	 * const health = await client.getEmbeddingHealth();
	 * console.log(`${health.coveragePercent}% embedded`);
	 * ```
	 */
	async getEmbeddingHealth(): Promise<EmbeddingHealthResponse> {
		return this.transport.get<EmbeddingHealthResponse>("/api/embeddings/health");
	}

	/**
	 * Get UMAP projection of embeddings (2D or 3D).
	 *
	 * @example
	 * ```typescript
	 * const projection = await client.getEmbeddingProjection({ dimensions: 2 });
	 * if (projection.status === "ready") {
	 *   console.log(projection.nodes[0]?.x, projection.nodes[0]?.y);
	 * }
	 * ```
	 */
	async getEmbeddingProjection(opts?: {
		readonly dimensions?: 2 | 3;
	}): Promise<EmbeddingProjectionResponse> {
		return this.transport.get<EmbeddingProjectionResponse>("/api/embeddings/projection", {
			dimensions: opts?.dimensions,
		});
	}

	// --- Harnesses ---

	/**
	 * List all harnesses.
	 *
	 * @example
	 * ```typescript
	 * const harnesses = await client.listHarnesses();
	 * console.log(harnesses.harnesses.filter(h => h.exists));
	 * ```
	 */
	async listHarnesses(): Promise<HarnessListResponse> {
		return this.transport.get<HarnessListResponse>("/api/harnesses");
	}

	/**
	 * Regenerate harness configs.
	 *
	 * @example
	 * ```typescript
	 * const result = await client.regenerateHarnesses();
	 * if (result.success) {
	 *   console.log("Harnesses regenerated");
	 * }
	 * ```
	 */
	async regenerateHarnesses(): Promise<HarnessRegenerateResponse> {
		return this.transport.post<HarnessRegenerateResponse>("/api/harnesses/regenerate", {});
	}

	// --- Checkpoints ---

	/**
	 * List checkpoints by project.
	 *
	 * @example
	 * ```typescript
	 * const checkpoints = await client.listCheckpoints({
	 *   project: "/home/user/myproject",
	 *   limit: 10
	 * });
	 * console.log(checkpoints.count);
	 * ```
	 */
	async listCheckpoints(opts: {
		readonly project: string;
		readonly limit?: number;
	}): Promise<CheckpointListResponse> {
		return this.transport.get<CheckpointListResponse>("/api/checkpoints", {
			project: opts.project,
			limit: opts.limit,
		});
	}

	/**
	 * List checkpoints by session.
	 *
	 * @example
	 * ```typescript
	 * const checkpoints = await client.listSessionCheckpoints("sess-abc-123");
	 * console.log(checkpoints.checkpoints[0].checkpointType);
	 * ```
	 */
	async listSessionCheckpoints(sessionKey: string): Promise<CheckpointListResponse> {
		return this.transport.get<CheckpointListResponse>(`/api/checkpoints/${sessionKey}`);
	}

	// --- Misc ---

	/**
	 * Get feature flags.
	 *
	 * @example
	 * ```typescript
	 * const features = await client.getFeatures();
	 * console.log(features.graphEnabled);
	 * ```
	 */
	async getFeatures(): Promise<FeaturesResponse> {
		return this.transport.get<FeaturesResponse>("/api/features");
	}

	/**
	 * Get home greeting.
	 *
	 * @example
	 * ```typescript
	 * const greeting = await client.getGreeting();
	 * console.log(greeting.greeting);
	 * ```
	 */
	async getGreeting(): Promise<GreetingResponse> {
		return this.transport.get<GreetingResponse>("/api/home/greeting");
	}

	// --- Sessions ---

	/**
	 * List all active sessions.
	 *
	 * @example
	 * ```typescript
	 * const { sessions } = await client.listSessions();
	 * console.log(sessions.filter(s => s.bypassed));
	 * ```
	 */
	async listSessions(): Promise<SessionListResponse> {
		return this.transport.get<SessionListResponse>("/api/sessions");
	}

	/**
	 * Get a single session by key.
	 *
	 * @example
	 * ```typescript
	 * const session = await client.getSession("sess-abc-123");
	 * console.log(session.runtimePath, session.bypassed);
	 * ```
	 */
	async getSession(key: string): Promise<SessionInfo> {
		return this.transport.get<SessionInfo>(`/api/sessions/${key}`);
	}

	/**
	 * Toggle bypass for a session.
	 *
	 * @example
	 * ```typescript
	 * await client.setSessionBypass("sess-abc-123", true);
	 * const session = await client.getSession("sess-abc-123");
	 * console.log(session.bypassed); // true
	 * ```
	 */
	async setSessionBypass(key: string, enabled: boolean): Promise<{ key: string; bypassed: boolean }> {
		return this.transport.post<{ key: string; bypassed: boolean }>(`/api/sessions/${key}/bypass`, { enabled });
	}

	// --- Git Sync ---

	/**
	 * Get git status.
	 *
	 * @example
	 * ```typescript
	 * const status = await client.getGitStatus();
	 * console.log(status.isRepo, status.branch, status.hasCredentials);
	 * ```
	 */
	async getGitStatus(): Promise<GitStatus> {
		return this.transport.get<GitStatus>("/api/git/status");
	}

	/**
	 * Pull changes from remote.
	 *
	 * @example
	 * ```typescript
	 * const result = await client.gitPull();
	 * console.log(result.success, result.changes);
	 * ```
	 */
	async gitPull(): Promise<GitPullResult> {
		return this.transport.post<GitPullResult>("/api/git/pull", {});
	}

	/**
	 * Push changes to remote.
	 *
	 * @example
	 * ```typescript
	 * const result = await client.gitPush();
	 * console.log(result.success, result.changes);
	 * ```
	 */
	async gitPush(): Promise<GitPushResult> {
		return this.transport.post<GitPushResult>("/api/git/push", {});
	}

	/**
	 * Full sync (pull + push).
	 *
	 * @example
	 * ```typescript
	 * const result = await client.gitSync();
	 * console.log(result.pulled, result.pushed);
	 * ```
	 */
	async gitSync(): Promise<GitSyncResult> {
		return this.transport.post<GitSyncResult>("/api/git/sync", {});
	}

	/**
	 * Get git configuration.
	 *
	 * @example
	 * ```typescript
	 * const config = await client.getGitConfig();
	 * console.log(config.autoSync, config.branch, config.remote);
	 * ```
	 */
	async getGitConfig(): Promise<GitConfig> {
		return this.transport.get<GitConfig>("/api/git/config");
	}

	/**
	 * Update git configuration.
	 *
	 * @example
	 * ```typescript
	 * await client.updateGitConfig({
	 *   autoSync: true,
	 *   syncInterval: 300
	 * });
	 * ```
	 */
	async updateGitConfig(patch: Partial<GitConfig>): Promise<{ success: boolean; config: GitConfig }> {
		return this.transport.post<{ success: boolean; config: GitConfig }>("/api/git/config", patch);
	}

	// --- Tasks/Scheduler ---

	/**
	 * List all scheduled tasks.
	 *
	 * @example
	 * ```typescript
	 * const { tasks, presets } = await client.listTasks();
	 * console.log(tasks.filter(t => t.enabled));
	 * console.log(presets["@hourly"]); // "0 * * * *"
	 * ```
	 */
	async listTasks(): Promise<TaskListResponse> {
		return this.transport.get<TaskListResponse>("/api/tasks");
	}

	/**
	 * Create a new scheduled task.
	 *
	 * @example
	 * ```typescript
	 * const result = await client.createTask({
	 *   name: "Daily Report",
	 *   prompt: "Generate daily report",
	 *   cronExpression: "0 9 * * *",
	 *   harness: "claude-code"
	 * });
	 * console.log(result.id, result.nextRunAt);
	 * ```
	 */
	async createTask(payload: TaskCreatePayload): Promise<TaskCreateResult> {
		return this.transport.post<TaskCreateResult>("/api/tasks", payload);
	}

	/**
	 * Get a single task with recent runs.
	 *
	 * @example
	 * ```typescript
	 * const { task, runs } = await client.getTask("task-abc-123");
	 * console.log(task.name, runs[0]?.status);
	 * ```
	 */
	async getTask(id: string): Promise<TaskGetResponse> {
		return this.transport.get<TaskGetResponse>(`/api/tasks/${id}`);
	}

	/**
	 * Update a task.
	 *
	 * @example
	 * ```typescript
	 * await client.updateTask("task-abc-123", {
	 *   enabled: false,
	 *   prompt: "Updated prompt"
	 * });
	 * ```
	 */
	async updateTask(id: string, patch: TaskUpdatePayload): Promise<{ success: boolean }> {
		return this.transport.patch<{ success: boolean }>(`/api/tasks/${id}`, patch);
	}

	/**
	 * Delete a task.
	 *
	 * @example
	 * ```typescript
	 * await client.deleteTask("task-abc-123");
	 * ```
	 */
	async deleteTask(id: string): Promise<{ success: boolean }> {
		return this.transport.del<{ success: boolean }>(`/api/tasks/${id}`);
	}

	/**
	 * Trigger an immediate task run.
	 *
	 * @example
	 * ```typescript
	 * const result = await client.runTask("task-abc-123");
	 * console.log(result.runId, result.status);
	 * ```
	 */
	async runTask(id: string): Promise<{ runId: string; status: "running" }> {
		return this.transport.post<{ runId: string; status: "running" }>(`/api/tasks/${id}/run`, {});
	}

	/**
	 * Get paginated run history for a task.
	 *
	 * @example
	 * ```typescript
	 * const runs = await client.listTaskRuns("task-abc-123", { limit: 20, offset: 0 });
	 * console.log(runs.runs.length, runs.total, runs.hasMore);
	 * ```
	 */
	async listTaskRuns(
		id: string,
		opts?: {
			readonly limit?: number;
			readonly offset?: number;
		},
	): Promise<TaskRunListResponse> {
		return this.transport.get<TaskRunListResponse>(`/api/tasks/${id}/runs`, {
			limit: opts?.limit,
			offset: opts?.offset,
		});
	}

	// --- Secrets ---

	/**
	 * List secret names (never values).
	 *
	 * @example
	 * ```typescript
	 * const { secrets } = await client.listSecrets();
	 * console.log(secrets); // ["GITHUB_TOKEN", "OPENAI_API_KEY"]
	 * ```
	 */
	async listSecrets(): Promise<SecretListResponse> {
		return this.transport.get<SecretListResponse>("/api/secrets");
	}

	/**
	 * Store a secret.
	 *
	 * @example
	 * ```typescript
	 * await client.storeSecret("MY_API_KEY", "sk-abc123");
	 * ```
	 */
	async storeSecret(name: string, value: string): Promise<{ success: boolean; name: string }> {
		return this.transport.post<{ success: boolean; name: string }>(`/api/secrets/${name}`, { value });
	}

	/**
	 * Delete a secret.
	 *
	 * @example
	 * ```typescript
	 * await client.deleteSecret("MY_API_KEY");
	 * ```
	 */
	async deleteSecret(name: string): Promise<{ success: boolean; name: string }> {
		return this.transport.del<{ success: boolean; name: string }>(`/api/secrets/${name}`);
	}

	/**
	 * Execute a command with secrets injected as env vars.
	 *
	 * @example
	 * ```typescript
	 * const result = await client.execWithSecrets("echo $GREETING", {
	 *   GREETING: "MY_SECRET"
	 * });
	 * console.log(result.stdout, result.code);
	 * ```
	 */
	async execWithSecrets(command: string, secrets: Record<string, string>): Promise<SecretExecResult> {
		return this.transport.post<SecretExecResult>("/api/secrets/exec", {
			command,
			secrets,
		});
	}

	/**
	 * Get 1Password connection status.
	 *
	 * @example
	 * ```typescript
	 * const status = await client.getOnePasswordStatus();
	 * console.log(status.configured, status.connected, status.vaultCount);
	 * ```
	 */
	async getOnePasswordStatus(): Promise<OnePasswordStatus> {
		return this.transport.get<OnePasswordStatus>("/api/secrets/1password/status");
	}

	/**
	 * Connect 1Password service account.
	 *
	 * @example
	 * ```typescript
	 * const result = await client.connectOnePassword("ops_token_abc123");
	 * console.log(result.vaultCount);
	 * ```
	 */
	async connectOnePassword(token: string): Promise<OnePasswordConnectResult> {
		return this.transport.post<OnePasswordConnectResult>("/api/secrets/1password/connect", { token });
	}

	/**
	 * Disconnect 1Password service account.
	 *
	 * @example
	 * ```typescript
	 * await client.disconnectOnePassword();
	 * ```
	 */
	async disconnectOnePassword(): Promise<{ success: boolean; disconnected: boolean; existed: boolean }> {
		return this.transport.del<{ success: boolean; disconnected: boolean; existed: boolean }>(
			"/api/secrets/1password/connect",
		);
	}

	/**
	 * List 1Password vaults.
	 *
	 * @example
	 * ```typescript
	 * const { vaults } = await client.listOnePasswordVaults();
	 * console.log(vaults.map(v => v.name));
	 * ```
	 */
	async listOnePasswordVaults(): Promise<{
		vaults: readonly { readonly id: string; readonly name: string }[];
		count: number;
	}> {
		return this.transport.get<{ vaults: readonly { readonly id: string; readonly name: string }[]; count: number }>(
			"/api/secrets/1password/vaults",
		);
	}

	/**
	 * Import secrets from 1Password.
	 *
	 * @example
	 * ```typescript
	 * const result = await client.importOnePasswordSecrets({
	 *   vaults: ["Private", "Work"],
	 *   prefix: "OP",
	 *   overwrite: false
	 * });
	 * console.log(result.importedCount);
	 * ```
	 */
	async importOnePasswordSecrets(opts: {
		readonly token?: string;
		readonly vaults?: readonly string[];
		readonly prefix?: string;
		readonly overwrite?: boolean;
	}): Promise<OnePasswordImportResult> {
		return this.transport.post<OnePasswordImportResult>("/api/secrets/1password/import", opts);
	}

	// --- Skills ---

	/**
	 * List installed skills.
	 *
	 * @example
	 * ```typescript
	 * const { skills } = await client.listSkills();
	 * console.log(skills.map(s => s.name));
	 * ```
	 */
	async listSkills(): Promise<SkillListResponse> {
		return this.transport.get<SkillListResponse>("/api/skills");
	}

	/**
	 * Browse available skills.
	 *
	 * @example
	 * ```typescript
	 * const { results, total } = await client.browseSkills();
	 * console.log(results.filter(r => r.installed));
	 * ```
	 */
	async browseSkills(): Promise<SkillBrowseResponse> {
		return this.transport.get<SkillBrowseResponse>("/api/skills/browse");
	}

	/**
	 * Search skills by query.
	 *
	 * @example
	 * ```typescript
	 * const { results } = await client.searchSkills("git");
	 * console.log(results[0].name, results[0].description);
	 * ```
	 */
	async searchSkills(query: string): Promise<SkillSearchResponse> {
		return this.transport.get<SkillSearchResponse>("/api/skills/search", { q: query });
	}

	/**
	 * Get skill details.
	 *
	 * @example
	 * ```typescript
	 * const skill = await client.getSkill("signet-design");
	 * console.log(skill.description, skill.content);
	 * ```
	 */
	async getSkill(name: string, source?: string): Promise<SkillGetResponse> {
		return this.transport.get<SkillGetResponse>(`/api/skills/${name}`, {
			source,
		});
	}

	/**
	 * Install a skill.
	 *
	 * @example
	 * ```typescript
	 * const result = await client.installSkill("signet-design");
	 * console.log(result.success);
	 * ```
	 */
	async installSkill(name: string, source?: string): Promise<SkillInstallResult> {
		return this.transport.post<SkillInstallResult>("/api/skills/install", {
			name,
			source,
		});
	}

	/**
	 * Uninstall a skill.
	 *
	 * @example
	 * ```typescript
	 * const result = await client.uninstallSkill("signet-design");
	 * console.log(result.message);
	 * ```
	 */
	async uninstallSkill(name: string): Promise<SkillDeleteResult> {
		return this.transport.del<SkillDeleteResult>(`/api/skills/${name}`);
	}
}

export interface SignetClient extends SignetClientP2 {}
Object.assign(SignetClient.prototype, SignetClientP2.prototype);

/** @deprecated Use SignetClient instead */
export const SignetSDK = SignetClient;

/** @deprecated Use SignetClient instead */
export const Signet = SignetClient;

// Re-export everything consumers need
export type { SignetTransport } from "./transport.js";
export {
	SignetApiError,
	SignetError,
	SignetNetworkError,
	SignetTimeoutError,
} from "./errors.js";
export type {
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
	ModifyResult,
	OnePasswordConnectResult,
	OnePasswordImportResult,
	OnePasswordStatus,
	PipelineStatusResponse,
	RecallResponse,
	RecallResult,
	RecoverResult,
	RememberResult,
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
	TaskCreatePayload,
	TaskCreateResult,
	TaskGetResponse,
	TaskListResponse,
	TaskRecord,
	TaskRun,
	TaskRunListResponse,
	TaskUpdatePayload,
	TelemetryEventsResponse,
	TelemetryStatsResponse,
	TimelineExportResponse,
	TimelineResponse,
	InstalledSkill,
} from "./types.js";

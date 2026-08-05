/**
 * Typed Signet daemon API client. Covers the endpoints the redesigned
 * dashboard consumes (see surfaces/dashboard/DASHBOARD_API_MAP.md §3, §6). The
 * previous Svelte client had ~110 functions; only the surfaces the mockup
 * stages are implemented here. Gap-list items (§4) are intentionally absent,
 * but §6 documents which mockup surfaces already have daemon backing the Svelte
 * client never wired (review-queue, ontology proposals, os/chat, bitwarden).
 *
 * Base resolution mirrors the Electron + daemon contract: requests go to the
 * same origin (daemon in-browser; `app://signet/` proxies /api,/memory,/health
 * to the daemon in Electron).
 */

const API_BASE = "";

/** Appends an optional API key/auth header if one is stored (dashboard auth). */
function authHeaders(): HeadersInit {
	const token = typeof localStorage !== "undefined" ? localStorage.getItem("signet-token") : null;
	return token ? { Authorization: `Bearer ${token}` } : {};
}

async function getJSON<T>(path: string, init?: RequestInit): Promise<T | null> {
	try {
		const res = await fetch(`${API_BASE}${path}`, {
			...init,
			headers: { Accept: "application/json", ...authHeaders(), ...(init?.headers ?? {}) },
		});
		if (!res.ok) return null;
		return (await res.json()) as T;
	} catch {
		return null;
	}
}

async function postJSON<T>(path: string, body?: unknown): Promise<T | null> {
	return getJSON<T>(path, {
		method: "POST",
		headers: body ? { "Content-Type": "application/json" } : undefined,
		body: body ? JSON.stringify(body) : undefined,
	});
}

/** POST/DELETE that preserves the daemon's `{error}` body on failure so
 *  forms can surface the real rejection reason. */
async function mutateJSON<T extends { error?: string }>(
	path: string,
	method: "POST" | "DELETE",
	body?: unknown,
): Promise<{ ok: boolean; data: T | null }> {
	try {
		const res = await fetch(`${API_BASE}${path}`, {
			method,
			headers: {
				Accept: "application/json",
				...authHeaders(),
				...(body ? { "Content-Type": "application/json" } : {}),
			},
			body: body ? JSON.stringify(body) : undefined,
		});
		const data = (await res.json().catch(() => null)) as T | null;
		return { ok: res.ok, data };
	} catch {
		return { ok: false, data: null };
	}
}

// ── Types (derived from real daemon responses) ──────────────────────────────

export interface ConfigFile {
	name: string;
	content: string;
	size: number;
}

export interface CatalogModel {
	id: string;
	name: string;
	contextWindow: number;
	input: readonly string[];
	reasoning: boolean;
}

export interface OAuthProviderMeta {
	readonly id: string;
	readonly name: string;
	readonly usesCallbackServer: boolean;
}

export interface OAuthProviderStatus extends OAuthProviderMeta {
	readonly connected: boolean;
	readonly error?: string;
}

export interface InferenceCatalog {
	providers: readonly string[];
	models: Record<string, CatalogModel[]>;
	modelErrors: Record<string, string>;
	oauthProviders: readonly OAuthProviderStatus[];
	acpxAgents: readonly string[];
}

/** Subset of the inference router status the settings screens consume. */
export interface InferenceStatus {
	runtimeSnapshot?: {
		targets?: Record<string, { available?: boolean; unavailableReason?: string } | undefined>;
	};
}

export type OAuthLoginEvent =
	| { readonly type: "session"; readonly sessionId: string; readonly providerId: string }
	| { readonly type: "auth"; readonly url: string; readonly instructions?: string }
	| {
			readonly type: "device_code";
			readonly userCode: string;
			readonly verificationUri: string;
			readonly intervalSeconds?: number;
			readonly expiresInSeconds?: number;
	  }
	| {
			readonly type: "prompt";
			readonly responseId: string;
			readonly message: string;
			readonly placeholder?: string;
			readonly allowEmpty?: boolean;
	  }
	| {
			readonly type: "select";
			readonly responseId: string;
			readonly message: string;
			readonly options: ReadonlyArray<{ readonly id: string; readonly label: string }>;
	  }
	| { readonly type: "manual_code"; readonly responseId: string; readonly message: string }
	| { readonly type: "progress"; readonly message: string }
	| { readonly type: "connected" }
	| { readonly type: "error"; readonly error: string }
	| { readonly type: "done" };

export interface OAuthLoginHandle {
	readonly sessionId: string | null;
	onEvent: (handler: (event: OAuthLoginEvent) => void) => void;
	onError: (handler: (message: string) => void) => void;
	close: () => void;
}

export interface SaveConfigResult {
	readonly ok: boolean;
	readonly status: number;
	readonly error?: string;
}

export interface LogEntry {
	timestamp: string;
	level: "debug" | "info" | "warn" | "error";
	category: string;
	message: string;
	data?: Record<string, unknown>;
}

// 1Password service-account integration (daemon routes/secrets-routes.ts).
export interface OnePasswordVault {
	id: string;
	name: string;
}

export interface OnePasswordStatus {
	configured: boolean;
	connected: boolean;
	vaultCount?: number;
	vaults: OnePasswordVault[];
	error?: string;
}

export interface OnePasswordResult {
	success: boolean;
	error?: string;
	vaultCount?: number;
	vaults?: OnePasswordVault[];
	importedCount?: number;
	skippedCount?: number;
	errorCount?: number;
}

export interface DaemonStatus {
	status: string;
	version: string;
	uptime: number;
	port: number;
	host: string;
	bindHost: string;
	networkMode: string;
	agentId: string;
	agentsDir: string;
	pipelineV2?: {
		enabled: boolean;
		paused: boolean;
		shadowMode: boolean;
		extraction?: { provider?: string; model?: string };
	};
}

export interface KnowledgeStats {
	entityCount: number;
	aspectCount: number;
	attributeCount: number;
	dependencyCount: number;
	coveragePercent: number;
}

export interface KnowledgeConstellation {
	entities: Array<{
		id: string;
		name: string;
		entityType: string;
		mentions: number;
		pinned: boolean;
		aspects: Array<{
			id: string;
			name: string;
			weight: number;
			attributes: Array<{
				id: string;
				content: string;
				kind: string;
				importance: number;
				version: number;
			}>;
		}>;
	}>;
	dependencies: Array<{
		sourceEntityId: string;
		targetEntityId: string;
		dependencyType: string;
		strength: number;
	}>;
	proposals: Array<{ id: string }>;
	metadata: { proposals: { pending: number } };
}

export interface MemoryStats {
	total: number;
	withEmbeddings: number;
	critical: number;
}

export interface Memory {
	id: string;
	content: string;
	created_at: string;
	who: string;
	importance: number;
	/** Inconsistent in the wild: string (delimited) | string[] | null. */
	tags: string | string[] | null;
	source_type?: string | null;
	pinned: 0 | 1;
	type: string;
}

export interface MemoryTimelineBucket {
	label: string;
	start: string;
	memoriesAdded: number;
}

export interface MemoryTimeline {
	totalMemories: number;
	buckets: MemoryTimelineBucket[];
	dailyBuckets?: Array<{ date: string; memoriesAdded: number }>;
}

export interface EmbeddingHealthReport {
	status: "healthy" | "degraded" | "unhealthy";
	checks: Array<{
		name: string;
		status: "ok" | "warn" | "fail";
		detail?: Record<string, unknown>;
	}>;
}

export interface SourceStats {
	artifacts: number;
	chunks: number;
	indexed: number;
}

export interface SourceHealth {
	status: "healthy" | "degraded" | "unhealthy" | "empty";
	latestArtifactAt?: string | null;
	failures?: { total: number; recoverable: number };
}

export interface SignetSource {
	id: string;
	kind: string;
	name: string;
	root: string;
	enabled: boolean;
	mode: string;
	createdAt: string;
	updatedAt: string;
	disabledReason?: string | null;
	lastIndexedAt?: string | null;
	stats?: SourceStats;
	health?: SourceHealth;
	/** Present on daemons that track per-source index jobs. */
	indexJob?: SourceIndexJob | null;
	/** Top-level on the daemon entry (obsidian exclude globs). */
	excludeGlobs?: string[];
	/** Kind-specific config bag (github repos/tokenRef, discord guildIds/tokenRef) — mirrors core SignetSourceEntry. */
	providerSettings?: Record<string, unknown> | null;
}

/** Mirrors daemon `source-index-progress.ts` SourceIndexJob. */
export interface SourceIndexJob {
	readonly id: string;
	readonly sourceId: string;
	readonly status: "queued" | "running" | "complete" | "error";
	readonly queuedAt: string;
	readonly startedAt?: string;
	readonly finishedAt?: string;
	readonly scanned?: number;
	readonly total?: number;
	readonly indexed?: number;
	readonly currentPath?: string;
	readonly error?: string;
}

export interface SourcesResponse {
	version: number;
	sources: SignetSource[];
}

/** Daily brief reflections — daemon `reflection-routes.ts` formatReflection. */
export interface DailyReflection {
	id: string;
	date: string;
	summary: string;
	patterns: string[];
	question: string | null;
	answer: string | null;
	answerMemoryId: string | null;
	createdAt: string;
	answeredAt: string | null;
}

export interface TodayReflectionResponse {
	reflection: DailyReflection | null;
	reflections?: DailyReflection[];
	generated?: number;
	message?: string;
	error?: string;
}

export interface ContinuityScore {
	project: string;
	score: number;
	created_at: string;
}

export interface HomeGreeting {
	greeting: string;
	cachedAt: string;
}

// ── Client ──────────────────────────────────────────────────────────────────

export const api = {
	getStatus: () => getJSON<DaemonStatus>("/api/status"),
	getHealth: async (): Promise<boolean> => {
		try {
			return (await fetch(`${API_BASE}/health`)).ok;
		} catch {
			return false;
		}
	},

	// Memory
	getMemories: (opts: { limit?: number; offset?: number; type?: string } = {}) => {
		const p = new URLSearchParams();
		if (opts.limit) p.set("limit", String(opts.limit));
		if (opts.offset) p.set("offset", String(opts.offset));
		if (opts.type) p.set("type", opts.type);
		const qs = p.toString();
		return getJSON<{ memories: Memory[]; stats: MemoryStats }>(`/api/memories${qs ? `?${qs}` : ""}`);
	},
	getMemoryTimeline: (tzOffset = 0) => getJSON<MemoryTimeline>(`/api/memory/timeline?tzOffset=${tzOffset}`),
	getEmbeddingHealth: () => getJSON<EmbeddingHealthReport>("/api/embeddings/health"),
	searchMemories: async (
		q: string,
		limit = 20,
		filters: { type?: string; tags?: string[] } = {},
	): Promise<{ memories: Memory[] } | null> => {
		const params = new URLSearchParams({ q, limit: String(limit) });
		if (filters.type) params.set("type", filters.type);
		if (filters.tags?.length) params.set("tags", filters.tags.join(","));
		const result = await getJSON<{ results?: Memory[] }>(`/memory/search?${params}`);
		return result ? { memories: result.results ?? [] } : null;
	},
	/** PATCH /api/memory/:id — daemon requires a non-empty `reason`. */
	updateMemory: async (
		id: string,
		patch: { pinned?: boolean; content?: string; type?: string; tags?: string[] | null; importance?: number },
		reason: string,
	): Promise<{ ok: boolean; error?: string }> => {
		try {
			const res = await fetch(`${API_BASE}/api/memory/${encodeURIComponent(id)}`, {
				method: "PATCH",
				headers: { "Content-Type": "application/json", ...authHeaders() },
				body: JSON.stringify({ ...patch, reason }),
			});
			if (res.ok) return { ok: true };
			const body = (await res.json().catch(() => null)) as { error?: string } | null;
			return { ok: false, error: body?.error ?? `HTTP ${res.status}` };
		} catch {
			return { ok: false, error: "daemon unreachable" };
		}
	},
	/** DELETE /api/memory/:id — soft delete; daemon requires a non-empty `reason`. */
	deleteMemory: async (id: string, reason: string): Promise<{ ok: boolean; error?: string }> => {
		try {
			const res = await fetch(`${API_BASE}/api/memory/${encodeURIComponent(id)}`, {
				method: "DELETE",
				headers: { "Content-Type": "application/json", ...authHeaders() },
				body: JSON.stringify({ reason }),
			});
			if (res.ok) return { ok: true };
			const body = (await res.json().catch(() => null)) as { error?: string } | null;
			return { ok: false, error: body?.error ?? `HTTP ${res.status}` };
		} catch {
			return { ok: false, error: "daemon unreachable" };
		}
	},

	/** GET /api/reflections/today — today's daily brief reflections (newest first). */
	getTodayReflections: (agentId?: string) => {
		const q = agentId && agentId !== "default" ? `?agentId=${encodeURIComponent(agentId)}` : "";
		return getJSON<TodayReflectionResponse>(`/api/reflections/today${q}`);
	},
	/** POST /api/reflections/generate — LLM daily brief(s); slow by nature (up to ~2min).
	 *  Omitted count falls back to the daemon's configured daily brief count. */
	generateReflections: async (agentId: string | undefined, count?: number): Promise<TodayReflectionResponse> => {
		const agentQ = agentId && agentId !== "default" ? `?agentId=${encodeURIComponent(agentId)}` : "";
		const sep = agentQ ? "&" : "?";
		const countQ = count === undefined ? "" : `${sep}count=${count}`;
		try {
			const res = await fetch(`${API_BASE}/api/reflections/generate${agentQ}${countQ}`, {
				method: "POST",
				headers: authHeaders(),
			});
			if (!res.ok) {
				const body = (await res.json().catch(() => null)) as { error?: string } | null;
				return { reflection: null, reflections: [], error: body?.error ?? "Failed to generate Daily Brief" };
			}
			return (await res.json()) as TodayReflectionResponse;
		} catch {
			return { reflection: null, reflections: [], error: "Failed to reach the daemon" };
		}
	},
	/** POST /api/reflections/:id/answer — writes the answer back into the memory thread. */
	answerReflection: async (
		id: string,
		answer: string,
		agentId?: string,
	): Promise<{ success: boolean; memoryId?: string; error?: string }> => {
		const q = agentId && agentId !== "default" ? `?agentId=${encodeURIComponent(agentId)}` : "";
		try {
			const res = await fetch(`${API_BASE}/api/reflections/${encodeURIComponent(id)}/answer${q}`, {
				method: "POST",
				headers: { "Content-Type": "application/json", ...authHeaders() },
				body: JSON.stringify({ answer: answer.trim() }),
			});
			const data = (await res.json().catch(() => null)) as { memoryId?: string; error?: string } | null;
			if (!res.ok) return { success: false, error: data?.error ?? "Request failed" };
			return { success: true, memoryId: data?.memoryId };
		} catch {
			return { success: false, error: "daemon unreachable" };
		}
	},

	// Knowledge graph
	getKnowledgeStats: () => getJSON<KnowledgeStats>("/api/knowledge/stats"),
	getKnowledgeConstellation: (limit = 48, dependencyLimit = 160) =>
		getJSON<KnowledgeConstellation>(
			`/api/knowledge/constellation?limit=${limit}&max_aspects_per_entity=4&dependency_limit=${dependencyLimit}`,
		),

	// Sources
	getSources: () => getJSON<SourcesResponse>("/api/sources"),
	/** Re-index = re-POST the source's own config; the daemon upserts (created:false) and re-queues an index job. */
	reindexSource: async (source: SignetSource): Promise<{ ok: boolean; error?: string }> => {
		const ps = source.providerSettings ?? {};
		const tokenRef = typeof ps.tokenRef === "string" && ps.tokenRef ? ps.tokenRef : undefined;
		const bodies: Record<string, unknown> = {
			obsidian: { root: source.root, name: source.name, excludeGlobs: source.excludeGlobs },
			github: { repos: Array.isArray(ps.repos) ? ps.repos : [], tokenRef, name: source.name },
			discord: { guildIds: Array.isArray(ps.guildIds) ? ps.guildIds : [], tokenRef, name: source.name },
		};
		const body = bodies[source.kind] as { repos?: unknown[]; guildIds?: unknown[] } | undefined;
		if (!body) return { ok: false, error: `re-index not supported for ${source.kind}` };
		if (source.kind === "github" && !body.repos?.length) return { ok: false, error: "source config is missing repos" };
		if (source.kind === "discord" && !body.guildIds?.length)
			return { ok: false, error: "source config is missing guild ids" };
		try {
			const res = await fetch(`${API_BASE}/api/sources/${source.kind}`, {
				method: "POST",
				headers: { "Content-Type": "application/json", ...authHeaders() },
				body: JSON.stringify(body),
			});
			if (res.ok) return { ok: true };
			const errBody = (await res.json().catch(() => null)) as { error?: string } | null;
			return { ok: false, error: errBody?.error ?? `HTTP ${res.status}` };
		} catch {
			return { ok: false, error: "daemon unreachable" };
		}
	},
	/** DELETE /api/sources/:id — removes config and purges indexed artifacts. */
	removeSource: async (id: string): Promise<{ ok: boolean; error?: string }> => {
		try {
			const res = await fetch(`${API_BASE}/api/sources/${encodeURIComponent(id)}`, {
				method: "DELETE",
				headers: authHeaders(),
			});
			if (res.ok) return { ok: true };
			const errBody = (await res.json().catch(() => null)) as { error?: string } | null;
			return { ok: false, error: errBody?.error ?? `HTTP ${res.status}` };
		} catch {
			return { ok: false, error: "daemon unreachable" };
		}
	},
	/** POST /api/sources/:kind — connect a source; daemon upserts and queues an index job (202). */
	addSource: async (kind: string, body: unknown): Promise<{ ok: boolean; error?: string }> => {
		try {
			const res = await fetch(`${API_BASE}/api/sources/${kind}`, {
				method: "POST",
				headers: { "Content-Type": "application/json", ...authHeaders() },
				body: JSON.stringify(body),
			});
			if (res.ok) return { ok: true };
			const errBody = (await res.json().catch(() => null)) as { error?: string } | null;
			return { ok: false, error: errBody?.error ?? `HTTP ${res.status}` };
		} catch {
			return { ok: false, error: "daemon unreachable" };
		}
	},
	/** POST /api/sources/pick-directory — native folder picker (Electron only; 501 in a plain browser). */
	pickDirectory: async (): Promise<{ ok: boolean; path?: string; unavailable?: boolean }> => {
		try {
			const res = await fetch(`${API_BASE}/api/sources/pick-directory`, {
				method: "POST",
				headers: { "Content-Type": "application/json", ...authHeaders() },
				body: JSON.stringify({ title: "Choose your vault folder" }),
			});
			if (res.status === 501) return { ok: false, unavailable: true };
			if (!res.ok) return { ok: false };
			const body = (await res.json().catch(() => null)) as { path?: string } | null;
			return body?.path ? { ok: true, path: body.path } : { ok: false };
		} catch {
			return { ok: false };
		}
	},
	/** GET /api/sources/:id/snapshot — exported artifact payload (downloaded client-side). */
	getSourceSnapshot: async (id: string): Promise<unknown | null> => {
		try {
			const res = await fetch(`${API_BASE}/api/sources/${encodeURIComponent(id)}/snapshot`, {
				headers: authHeaders(),
			});
			if (!res.ok) return null;
			return await res.json();
		} catch {
			return null;
		}
	},

	// Home
	getHomeGreeting: () => getJSON<HomeGreeting>("/api/home/greeting"),
	getContinuityLatest: () => getJSON<{ scores: ContinuityScore[] }>("/api/analytics/continuity/latest"),

	// Secrets (the unlock gate maps to dashboard auth; names list is plaintext)
	getSecrets: () => getJSON<{ secrets?: string[]; provider?: string }>("/api/secrets"),

	// 1Password service-account integration (secrets vault panel)
	getOnePasswordStatus: async (): Promise<OnePasswordStatus> => {
		const data = await getJSON<Partial<OnePasswordStatus>>("/api/secrets/1password/status");
		return {
			configured: data?.configured === true,
			connected: data?.connected === true,
			vaultCount: typeof data?.vaultCount === "number" ? data.vaultCount : undefined,
			vaults: Array.isArray(data?.vaults) ? data.vaults : [],
			error: typeof data?.error === "string" ? data.error : undefined,
		};
	},
	connectOnePassword: async (token: string): Promise<OnePasswordResult> => {
		const { ok, data } = await mutateJSON<OnePasswordResult>("/api/secrets/1password/connect", "POST", {
			token,
		});
		if (!ok) return { success: false, error: data?.error ?? "Failed to connect 1Password" };
		return { ...data, success: true };
	},
	disconnectOnePassword: async (): Promise<OnePasswordResult> => {
		const { ok, data } = await mutateJSON<OnePasswordResult>("/api/secrets/1password/connect", "DELETE");
		if (!ok) return { success: false, error: data?.error ?? "Failed to disconnect 1Password" };
		return { ...data, success: true };
	},
	listOnePasswordVaults: async (): Promise<OnePasswordVault[]> => {
		const data = await getJSON<{ vaults?: OnePasswordVault[] }>("/api/secrets/1password/vaults");
		return Array.isArray(data?.vaults) ? data.vaults : [];
	},
	importOnePasswordSecrets: async (params: {
		vaults?: string[];
		prefix?: string;
		overwrite?: boolean;
	}): Promise<OnePasswordResult> => {
		const { ok, data } = await mutateJSON<OnePasswordResult>("/api/secrets/1password/import", "POST", params);
		if (!ok) return { success: false, error: data?.error ?? "Failed to import from 1Password" };
		return { ...data, success: true };
	},

	// Inference (settings modal) — the catalog drives the provider connect
	// wall and the backend/model pickers. Defensive defaults mirror the old
	// Svelte panel so a pre-#968 daemon just shows fewer cards.
	getInferenceCatalog: async (): Promise<InferenceCatalog | null> => {
		const c = await getJSON<Partial<InferenceCatalog>>("/api/inference/catalog");
		if (!c) return null;
		return {
			providers: c.providers ?? [],
			models: c.models ?? {},
			modelErrors: c.modelErrors ?? {},
			oauthProviders: c.oauthProviders ?? [],
			acpxAgents: c.acpxAgents ?? [],
		};
	},
	getInferenceStatus: (refresh = false) =>
		getJSON<InferenceStatus>(`/api/inference/status${refresh ? "?refresh=1" : ""}`),

	// Config files (settings: agent.yaml read/write)
	getConfigFiles: async (): Promise<ConfigFile[]> => {
		const data = await getJSON<{ files?: ConfigFile[] }>("/api/config");
		return data?.files ?? [];
	},
	saveConfigFile: async (file: string, content: string): Promise<SaveConfigResult> => {
		try {
			const res = await fetch(`${API_BASE}/api/config`, {
				method: "POST",
				headers: { "Content-Type": "application/json", ...authHeaders() },
				body: JSON.stringify({ file, content }),
			});
			if (res.ok) return { ok: true, status: res.status };
			const body = (await res.json().catch(() => null)) as { error?: string } | null;
			return { ok: false, status: res.status, error: body?.error };
		} catch {
			return { ok: false, status: 0, error: "daemon unreachable" };
		}
	},

	// Secrets vault (provider API keys — values are never read back)
	putSecret: async (name: string, value: string): Promise<{ ok: boolean; error?: string }> => {
		const { ok, data } = await mutateJSON<{ error?: string }>(`/api/secrets/${encodeURIComponent(name)}`, "POST", {
			value,
		});
		return { ok, error: ok ? undefined : (data?.error ?? "Failed to store secret") };
	},
	deleteSecret: async (name: string): Promise<{ ok: boolean; error?: string }> => {
		const { ok, data } = await mutateJSON<{ error?: string }>(`/api/secrets/${encodeURIComponent(name)}`, "DELETE");
		return { ok, error: ok ? undefined : (data?.error ?? "Failed to delete secret") };
	},

	// Daemon logs (settings → Logs section)
	getLogs: (limit = 200) => getJSON<{ logs: LogEntry[]; count: number }>(`/api/logs?limit=${limit}`),
};

// postJSON is exported for future mutation surfaces (review-queue apply/reject,
// ontology proposals, dream trigger). Not currently called from a built view.
export { postJSON };

/**
 * Start a daemon-side OAuth login and pump its SSE stream. Ported 1:1 from
 * the old Svelte client — the stream is consumed via fetch + reader (no
 * EventSource, since the login is a POST). The session id arrives either in
 * the X-Signet-OAuth-Session-Id response header or the first `session` event.
 */
export async function startOAuthLogin(providerId: string, onConnected?: () => void): Promise<OAuthLoginHandle> {
	const handlers: Array<(event: OAuthLoginEvent) => void> = [];
	const errorHandlers: Array<(message: string) => void> = [];
	const controller = new AbortController();
	let closed = false;
	let capturedSessionId: string | null = null;

	const emitError = (message: string) => {
		if (closed) return;
		for (const h of errorHandlers) h(message);
	};

	const pump = fetch(`${API_BASE}/api/inference/oauth/login/${encodeURIComponent(providerId)}`, {
		method: "POST",
		headers: { Accept: "text/event-stream", ...authHeaders() },
		signal: controller.signal,
	})
		.then(async (response) => {
			if (!response.ok || !response.body) {
				let message = `OAuth login failed (HTTP ${response.status})`;
				try {
					const body = (await response.json()) as { error?: string };
					if (body?.error) message = body.error;
				} catch {
					/* keep status message */
				}
				throw new Error(message);
			}
			capturedSessionId = response.headers.get("X-Signet-OAuth-Session-Id");
			const reader = response.body.getReader();
			const decoder = new TextDecoder();
			let buffer = "";
			for (;;) {
				const { done, value } = await reader.read();
				if (done) break;
				buffer += decoder.decode(value, { stream: true });
				const frames = buffer.split("\n\n");
				buffer = frames.pop() ?? "";
				for (const frame of frames) {
					const dataLine = frame.split("\n").find((l) => l.startsWith("data: "));
					if (!dataLine) continue;
					let event: OAuthLoginEvent;
					try {
						event = JSON.parse(dataLine.slice(6)) as OAuthLoginEvent;
					} catch {
						continue;
					}
					if (event.type === "session") capturedSessionId = event.sessionId;
					if (event.type === "connected") onConnected?.();
					for (const h of handlers) h(event);
				}
			}
		})
		.catch((error: unknown) => {
			if (closed) return;
			emitError(error instanceof Error ? error.message : "OAuth login stream failed");
		});
	void pump;

	return {
		get sessionId() {
			return capturedSessionId;
		},
		onEvent: (handler) => {
			handlers.push(handler);
		},
		onError: (handler) => {
			errorHandlers.push(handler);
		},
		close: () => {
			closed = true;
			controller.abort();
		},
	};
}

export async function completeOAuthInteraction(sessionId: string, responseId: string, value: string): Promise<boolean> {
	const res = await fetch(`${API_BASE}/api/inference/oauth/complete`, {
		method: "POST",
		headers: { "Content-Type": "application/json", ...authHeaders() },
		body: JSON.stringify({ sessionId, responseId, value }),
	});
	return res.ok;
}

export async function disconnectOAuthProvider(providerId: string): Promise<boolean> {
	const res = await fetch(`${API_BASE}/api/inference/oauth/disconnect/${encodeURIComponent(providerId)}`, {
		method: "POST",
		headers: authHeaders(),
	});
	return res.ok;
}

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

// ── Types (derived from real daemon responses) ──────────────────────────────

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
	source_type: string;
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
}

export interface SourcesResponse {
	version: number;
	sources: SignetSource[];
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
	getMemoryTimeline: (tzOffset = 0) =>
		getJSON<MemoryTimeline>(`/api/memory/timeline?tzOffset=${tzOffset}`),
	searchMemories: (q: string, limit = 20) =>
		getJSON<{ memories?: Memory[] }>(`/memory/search?q=${encodeURIComponent(q)}&limit=${limit}`),

	// Knowledge graph
	getKnowledgeStats: () => getJSON<KnowledgeStats>("/api/knowledge/stats"),

	// Sources
	getSources: () => getJSON<SourcesResponse>("/api/sources"),

	// Home
	getHomeGreeting: () => getJSON<HomeGreeting>("/api/home/greeting"),
	getContinuityLatest: () =>
		getJSON<{ scores: ContinuityScore[] }>("/api/analytics/continuity/latest"),

	// Secrets (the unlock gate maps to dashboard auth; names list is plaintext)
	getSecrets: () => getJSON<{ secrets?: string[] } | string[]>("/api/secrets"),

	// Inference (settings modal)
	getInferenceCatalog: () => getJSON<unknown>("/api/inference/catalog"),
	getInferenceStatus: () => getJSON<unknown>("/api/inference/status"),

	// Config (settings modal: network, identity, cloud sync)
	getConfigFiles: () => getJSON<unknown>("/api/config"),
};

// postJSON is exported for future mutation surfaces (review-queue apply/reject,
// ontology proposals, dream trigger). Not currently called from a built view.
export { postJSON };

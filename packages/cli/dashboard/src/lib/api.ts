/**
 * API client for Signet Dashboard
 * Handles communication with the Signet daemon
 */

// In production, the dashboard is served by the daemon, so use relative URLs
// In development, point to the daemon on port 3850
const isDev = import.meta.env.DEV;
const API_BASE = isDev ? "http://localhost:3850" : "";

export interface Memory {
	id: string;
	content: string;
	created_at: string;
	who: string;
	importance: number;
	tags?: string | string[] | null;
	source_type?: string;
	type?: string;
	pinned?: boolean;
	score?: number;
	source?: "hybrid" | "vector" | "keyword";
}

export interface MemoryStats {
	total: number;
	withEmbeddings: number;
	critical: number;
}

export interface ConfigFile {
	name: string;
	content: string;
	size: number;
}

export interface Harness {
	name: string;
	path: string;
	exists: boolean;
}

export interface Identity {
	name: string;
	creature: string;
	vibe: string;
}

export interface DaemonStatus {
	status: string;
	version: string;
	pid: number;
	uptime: number;
	startedAt: string;
	port: number;
	host: string;
	agentsDir: string;
	memoryDb: boolean;
}

export interface EmbeddingPoint {
	id: string;
	content: string;
	text?: string;
	who: string;
	importance: number;
	type?: string | null;
	tags: string[];
	sourceType?: string;
	sourceId?: string;
	createdAt?: string;
	vector?: number[];
}

export interface EmbeddingsResponse {
	embeddings: EmbeddingPoint[];
	count: number;
	total: number;
	limit: number;
	offset: number;
	hasMore: boolean;
	error?: string;
}

// ============================================================================
// API Functions
// ============================================================================

export async function getStatus(): Promise<DaemonStatus | null> {
	try {
		const response = await fetch(`${API_BASE}/api/status`);
		if (!response.ok) return null;
		return await response.json();
	} catch {
		return null;
	}
}

export async function getHealth(): Promise<boolean> {
	try {
		const response = await fetch(`${API_BASE}/health`);
		return response.ok;
	} catch {
		return false;
	}
}

export async function getIdentity(): Promise<Identity> {
	try {
		const response = await fetch(`${API_BASE}/api/identity`);
		if (!response.ok) throw new Error("Failed to fetch identity");
		return await response.json();
	} catch {
		return { name: "Unknown", creature: "", vibe: "" };
	}
}

export async function getConfigFiles(): Promise<ConfigFile[]> {
	try {
		const response = await fetch(`${API_BASE}/api/config`);
		if (!response.ok) throw new Error("Failed to fetch config");
		const data = await response.json();
		return data.files || [];
	} catch {
		return [];
	}
}

export async function saveConfigFile(
	file: string,
	content: string,
): Promise<boolean> {
	try {
		const response = await fetch(`${API_BASE}/api/config`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ file, content }),
		});
		return response.ok;
	} catch {
		return false;
	}
}

export async function getMemories(
	limit = 100,
	offset = 0,
): Promise<{ memories: Memory[]; stats: MemoryStats }> {
	try {
		const response = await fetch(
			`${API_BASE}/api/memories?limit=${limit}&offset=${offset}`,
		);
		if (!response.ok) throw new Error("Failed to fetch memories");
		return await response.json();
	} catch {
		return {
			memories: [],
			stats: { total: 0, withEmbeddings: 0, critical: 0 },
		};
	}
}

export async function searchMemories(
	query: string,
	filters: {
		type?: string;
		tags?: string;
		who?: string;
		pinned?: boolean;
		importance_min?: number;
		since?: string;
		limit?: number;
	} = {},
): Promise<Memory[]> {
	try {
		const params = new URLSearchParams();
		if (query) params.set("q", query);
		if (filters.type) params.set("type", filters.type);
		if (filters.tags) params.set("tags", filters.tags);
		if (filters.who) params.set("who", filters.who);
		if (filters.pinned) params.set("pinned", "1");
		if (filters.importance_min !== undefined)
			params.set("importance_min", filters.importance_min.toString());
		if (filters.since) params.set("since", filters.since);
		if (filters.limit) params.set("limit", filters.limit.toString());

		const response = await fetch(`${API_BASE}/memory/search?${params}`);
		if (!response.ok) throw new Error("Search failed");
		const data = await response.json();
		return data.results || [];
	} catch {
		return [];
	}
}

export async function recallMemories(
	query: string,
	filters: {
		type?: string;
		tags?: string;
		who?: string;
		pinned?: boolean;
		importance_min?: number;
		since?: string;
		limit?: number;
	} = {},
): Promise<Memory[]> {
	try {
		const response = await fetch(`${API_BASE}/api/memory/recall`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				query,
				limit: filters.limit,
				type: filters.type,
				tags: filters.tags,
				who: filters.who,
				pinned: filters.pinned,
				importance_min: filters.importance_min,
				since: filters.since,
			}),
		});

		if (!response.ok) throw new Error("Recall failed");
		const data = await response.json();
		return data.results || [];
	} catch {
		return [];
	}
}

export async function getDistinctWho(): Promise<string[]> {
	try {
		const response = await fetch(`${API_BASE}/memory/search?distinct=who`);
		if (!response.ok) throw new Error("Failed to fetch distinct who");
		const data = await response.json();
		return data.values || [];
	} catch {
		return [];
	}
}

export async function getSimilarMemories(
	id: string,
	k = 10,
	type?: string,
): Promise<Memory[]> {
	try {
		const params = new URLSearchParams({ id, k: k.toString() });
		if (type) params.set("type", type);

		const response = await fetch(`${API_BASE}/memory/similar?${params}`);
		if (!response.ok) throw new Error("Similarity search failed");
		const data = await response.json();
		return data.results || [];
	} catch {
		return [];
	}
}

export async function getEmbeddings(
	withVectors = false,
	options: { limit?: number; offset?: number } = {},
): Promise<EmbeddingsResponse> {
	try {
		const params = new URLSearchParams({
			vectors: withVectors ? "true" : "false",
		});
		if (typeof options.limit === "number") {
			params.set("limit", options.limit.toString());
		}
		if (typeof options.offset === "number") {
			params.set("offset", options.offset.toString());
		}

		const response = await fetch(`${API_BASE}/api/embeddings?${params}`);
		if (!response.ok) throw new Error("Failed to fetch embeddings");

		const data = (await response.json()) as Partial<EmbeddingsResponse>;
		const embeddings = Array.isArray(data.embeddings) ? data.embeddings : [];

		return {
			embeddings,
			count: typeof data.count === "number" ? data.count : embeddings.length,
			total: typeof data.total === "number" ? data.total : embeddings.length,
			limit:
				typeof data.limit === "number"
					? data.limit
					: (options.limit ?? embeddings.length),
			offset:
				typeof data.offset === "number" ? data.offset : (options.offset ?? 0),
			hasMore: Boolean(data.hasMore),
			error: typeof data.error === "string" ? data.error : undefined,
		};
	} catch (e) {
		return {
			embeddings: [],
			count: 0,
			total: 0,
			limit: options.limit ?? 0,
			offset: options.offset ?? 0,
			hasMore: false,
			error: String(e),
		};
	}
}

export async function getHarnesses(): Promise<Harness[]> {
	try {
		const response = await fetch(`${API_BASE}/api/harnesses`);
		if (!response.ok) throw new Error("Failed to fetch harnesses");
		const data = await response.json();
		return data.harnesses || [];
	} catch {
		return [];
	}
}

export async function regenerateHarnesses(): Promise<{
	success: boolean;
	message?: string;
	error?: string;
}> {
	try {
		const response = await fetch(`${API_BASE}/api/harnesses/regenerate`, {
			method: "POST",
		});
		return await response.json();
	} catch (e) {
		return { success: false, error: String(e) };
	}
}

// ============================================================================
// Secrets API
// ============================================================================

export interface SecretMeta {
	name: string;
	created?: string;
	updated?: string;
}

export async function getSecrets(): Promise<string[]> {
	try {
		const response = await fetch(`${API_BASE}/api/secrets`);
		if (!response.ok) throw new Error("Failed to fetch secrets");
		const data = await response.json();
		return data.secrets || [];
	} catch {
		return [];
	}
}

export async function putSecret(name: string, value: string): Promise<boolean> {
	try {
		const response = await fetch(
			`${API_BASE}/api/secrets/${encodeURIComponent(name)}`,
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ value }),
			},
		);
		return response.ok;
	} catch {
		return false;
	}
}

export async function deleteSecret(name: string): Promise<boolean> {
	try {
		const response = await fetch(
			`${API_BASE}/api/secrets/${encodeURIComponent(name)}`,
			{
				method: "DELETE",
			},
		);
		return response.ok;
	} catch {
		return false;
	}
}

// ============================================================================
// Skills API
// ============================================================================

export interface Skill {
	name: string;
	description: string;
	path?: string;
	builtin?: boolean;
	user_invocable?: boolean;
	arg_hint?: string;
}

export interface SkillSearchResult {
	name: string;
	description: string;
	installed: boolean;
}

export async function getSkills(): Promise<Skill[]> {
	try {
		const response = await fetch(`${API_BASE}/api/skills`);
		if (!response.ok) throw new Error("Failed to fetch skills");
		const data = await response.json();
		return data.skills || [];
	} catch {
		return [];
	}
}

export async function getSkill(name: string): Promise<Skill | null> {
	try {
		const response = await fetch(
			`${API_BASE}/api/skills/${encodeURIComponent(name)}`,
		);
		if (!response.ok) return null;
		return await response.json();
	} catch {
		return null;
	}
}

export async function searchSkills(
	query: string,
): Promise<SkillSearchResult[]> {
	try {
		const response = await fetch(
			`${API_BASE}/api/skills/search?q=${encodeURIComponent(query)}`,
		);
		if (!response.ok) throw new Error("Search failed");
		const data = await response.json();
		return data.results || [];
	} catch {
		return [];
	}
}

export async function installSkill(
	name: string,
): Promise<{ success: boolean; error?: string }> {
	try {
		const response = await fetch(`${API_BASE}/api/skills/install`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ name }),
		});
		return await response.json();
	} catch (e) {
		return { success: false, error: String(e) };
	}
}

export async function uninstallSkill(
	name: string,
): Promise<{ success: boolean; error?: string }> {
	try {
		const response = await fetch(
			`${API_BASE}/api/skills/${encodeURIComponent(name)}`,
			{
				method: "DELETE",
			},
		);
		return await response.json();
	} catch (e) {
		return { success: false, error: String(e) };
	}
}

/**
 * API client for Signet Dashboard
 * Handles communication with the Signet daemon
 */

import type { ModelRegistryEntry } from "@signet/core";
import { marked } from "marked";

// When served by the daemon (production) or Vite dev server (proxied), use relative URLs.
// Tauri needs an absolute URL since it serves from a different origin.
const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
const tauriHost = typeof window !== "undefined" ? window.location.hostname : "localhost";
export const API_BASE = isTauri ? `http://${tauriHost}:3850` : "";

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

export interface TimelineMetric {
	key: string;
	count: number;
}

export interface MemoryTimelineBucket {
	eraIndex: number;
	rangeKey: "today" | "last_week" | "one_month";
	label: string;
	start: string;
	end: string;
	memoriesAdded: number;
	trackedEvents: number;
	evolved: number;
	strengthened: number;
	recovered: number;
	avgImportance: number;
	pinned: number;
	typeBreakdown: TimelineMetric[];
	sourceBreakdown: TimelineMetric[];
	topTags: TimelineMetric[];
}

export interface MemoryTimelineResponse {
	generatedAt: string;
	generatedFor: string;
	rangePreset: "today-last_week-one_month";
	totalMemories: number;
	totalHistoryEvents: number;
	invalidMemoryTimestamps: number;
	invalidHistoryTimestamps: number;
	buckets: MemoryTimelineBucket[];
	error?: string;
}

export interface ConfigFile {
	name: string;
	content: string;
	size: number;
}

export interface Harness {
	name: string;
	id: string;
	path: string;
	exists: boolean;
	lastSeen: string | null;
}

export interface DocumentConnector {
	id: string;
	provider: string;
	display_name: string | null;
	status: string;
	last_sync_at: string | null;
	last_error: string | null;
	created_at: string;
	updated_at: string;
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
	bindHost: string;
	networkMode: "localhost" | "tailscale";
	agentsDir: string;
	memoryDb: boolean;
	activeSessions?: number;
	agentCreatedAt?: string | null;
	update?: {
		currentVersion: string;
		latestVersion: string | null;
		updateAvailable: boolean;
		pendingRestart: string | null;
		autoInstall: boolean;
		checkInterval: number;
		lastCheckAt: string | null;
		lastError: string | null;
		timerActive: boolean;
	};
}

export interface EmbeddingPoint {
	id: string;
	content: string;
	text?: string;
	who: string;
	importance: number;
	type?: string | null;
	tags: string[];
	pinned?: boolean;
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
// Session Types
// ============================================================================

export interface SessionInfo {
	readonly key: string;
	readonly runtimePath: string;
	readonly claimedAt: string;
	readonly bypassed: boolean;
}

export interface SessionListResponse {
	readonly sessions: readonly SessionInfo[];
	readonly count: number;
}

export interface SessionBypassResponse {
	readonly key: string;
	readonly bypassed: boolean;
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

export async function fetchSessions(): Promise<SessionListResponse> {
	try {
		const response = await fetch(`${API_BASE}/api/sessions`);
		if (!response.ok) return { sessions: [], count: 0 };
		return await response.json();
	} catch {
		return { sessions: [], count: 0 };
	}
}

export async function toggleSessionBypass(key: string, enabled: boolean): Promise<SessionBypassResponse | null> {
	try {
		const response = await fetch(`${API_BASE}/api/sessions/${encodeURIComponent(key)}/bypass`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ enabled }),
		});
		if (!response.ok) return null;
		return await response.json();
	} catch {
		return null;
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

export async function saveConfigFile(file: string, content: string): Promise<boolean> {
	const result = await saveConfigFileResult(file, content);
	return result.ok;
}

export interface SaveConfigResult {
	readonly ok: boolean;
	readonly status: number;
	readonly error?: string;
}

export async function saveConfigFileResult(file: string, content: string): Promise<SaveConfigResult> {
	try {
		const response = await fetch(`${API_BASE}/api/config`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ file, content }),
		});

		if (response.ok) {
			return { ok: true, status: response.status };
		}

		const payload = (await response.json().catch(() => null)) as { error?: unknown } | null;
		const message = typeof payload?.error === "string" ? payload.error : `HTTP ${response.status}`;
		return { ok: false, status: response.status, error: message };
	} catch (error) {
		return {
			ok: false,
			status: 0,
			error: error instanceof Error ? error.message : String(error),
		};
	}
}

export async function getMemories(limit = 100, offset = 0, agentId?: string): Promise<{ memories: Memory[]; stats: MemoryStats }> {
	try {
		const params = new URLSearchParams({ limit: String(limit), offset: String(offset) });
		if (agentId) params.set("agent_id", agentId);
		const response = await fetch(`${API_BASE}/api/memories?${params}`);
		if (!response.ok) throw new Error("Failed to fetch memories");
		return await response.json();
	} catch {
		return {
			memories: [],
			stats: { total: 0, withEmbeddings: 0, critical: 0 },
		};
	}
}

function buildTimelineFallback(memories: readonly Memory[]): MemoryTimelineResponse {
	const MS_PER_DAY = 24 * 60 * 60 * 1000;
	const now = new Date();
	const nowStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();

	const ranges = [
		{ eraIndex: 0 as const, rangeKey: "today" as const, label: "Today" as const, lookbackDays: 1 },
		{ eraIndex: 1 as const, rangeKey: "last_week" as const, label: "Last week" as const, lookbackDays: 7 },
		{ eraIndex: 2 as const, rangeKey: "one_month" as const, label: "One month" as const, lookbackDays: 30 },
	];

	const buckets = ranges.map((range) => {
		const start = nowStart - (range.lookbackDays - 1) * MS_PER_DAY;
		const end = nowStart + MS_PER_DAY - 1;
		return {
			range,
			start,
			end,
			memoriesAdded: 0,
			importanceSum: 0,
			importanceCount: 0,
			pinned: 0,
			typeMap: new Map<string, number>(),
			sourceMap: new Map<string, number>(),
			tagMap: new Map<string, number>(),
		};
	});

	for (const memory of memories) {
		const ts = Date.parse(memory.created_at);
		if (!Number.isFinite(ts)) continue;
		const matchingBuckets = buckets.filter((entry) => ts >= entry.start && ts <= entry.end);
		if (matchingBuckets.length === 0) continue;

		for (const bucket of matchingBuckets) {
			bucket.memoriesAdded += 1;
			if (memory.pinned) bucket.pinned += 1;
			if (typeof memory.importance === "number" && Number.isFinite(memory.importance)) {
				bucket.importanceSum += memory.importance;
				bucket.importanceCount += 1;
			}

			const typeKey = memory.type?.trim() || "unknown";
			bucket.typeMap.set(typeKey, (bucket.typeMap.get(typeKey) ?? 0) + 1);

			const whoKey = memory.who?.trim() || "unknown";
			bucket.sourceMap.set(whoKey, (bucket.sourceMap.get(whoKey) ?? 0) + 1);
		}

		let tags: string[] = [];
		if (Array.isArray(memory.tags)) {
			tags = memory.tags
				.filter((tag): tag is string => typeof tag === "string")
				.map((tag) => tag.trim())
				.filter((tag) => tag.length > 0);
		} else if (typeof memory.tags === "string") {
			const trimmed = memory.tags.trim();
			if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
				try {
					const parsed = JSON.parse(trimmed);
					if (Array.isArray(parsed)) {
						tags = parsed
							.filter((tag) => typeof tag === "string")
							.map((tag) => tag.trim())
							.filter((tag) => tag.length > 0);
					} else {
						// JSON parsed but not an array — fall through to CSV
						tags = trimmed
							.split(",")
							.map((tag) => tag.trim())
							.filter((tag) => tag.length > 0);
					}
				} catch {
					// Fall through to CSV parsing on JSON parse error
					tags = trimmed
						.split(",")
						.map((tag) => tag.trim())
						.filter((tag) => tag.length > 0);
				}
			} else {
				tags = trimmed
					.split(",")
					.map((tag) => tag.trim())
					.filter((tag) => tag.length > 0);
			}
		}
		for (const bucket of matchingBuckets) {
			for (const tag of tags) {
				bucket.tagMap.set(tag, (bucket.tagMap.get(tag) ?? 0) + 1);
			}
		}
	}

	const toMetrics = (map: Map<string, number>): TimelineMetric[] =>
		[...map.entries()]
			.sort((a, b) => {
				if (b[1] !== a[1]) return b[1] - a[1];
				return a[0].localeCompare(b[0]);
			})
			.slice(0, 5)
			.map(([key, count]) => ({ key, count }));

	// Use the widest bucket (30-day) count to match daemon semantics
	const widestBucket = buckets[buckets.length - 1];
	const totalInWindow = widestBucket?.memoriesAdded ?? 0;

	return {
		generatedAt: new Date().toISOString(),
		generatedFor: new Date(nowStart).toISOString(),
		rangePreset: "today-last_week-one_month",
		totalMemories: totalInWindow,
		totalHistoryEvents: 0,
		invalidMemoryTimestamps: 0,
		invalidHistoryTimestamps: 0,
		buckets: buckets.map((bucket) => ({
			eraIndex: bucket.range.eraIndex,
			rangeKey: bucket.range.rangeKey,
			label: bucket.range.label,
			start: new Date(bucket.start).toISOString(),
			end: new Date(bucket.end).toISOString(),
			memoriesAdded: bucket.memoriesAdded,
			trackedEvents: 0,
			evolved: 0,
			strengthened: 0,
			recovered: 0,
			avgImportance:
				bucket.importanceCount > 0
					? Number(Math.min(1, Math.max(0, bucket.importanceSum / bucket.importanceCount)).toFixed(3))
					: 0,
			pinned: bucket.pinned,
			typeBreakdown: toMetrics(bucket.typeMap),
			sourceBreakdown: toMetrics(bucket.sourceMap),
			topTags: toMetrics(bucket.tagMap),
		})),
	};
}

export async function getMemoryTimeline(options?: {
	readonly fallbackMemories?: readonly Memory[] | Promise<readonly Memory[]>;
}): Promise<MemoryTimelineResponse> {
	try {
		const controller = new AbortController();
		const timeoutId = setTimeout(() => controller.abort(), 10_000);
		let response: Response;
		try {
			const tz = new Date().getTimezoneOffset();
			response = await fetch(`${API_BASE}/api/memory/timeline?tzOffset=${tz}`, {
				signal: controller.signal,
			});
		} finally {
			clearTimeout(timeoutId);
		}
		if (!response.ok) throw new Error("Failed to fetch memory timeline");
		return await response.json();
	} catch {
		let fallbackMemories: readonly Memory[];
		try {
			fallbackMemories = options?.fallbackMemories
				? await options.fallbackMemories
				: (await getMemories(5000, 0)).memories;
		} catch {
			// If fallback also fails, return an empty timeline
			fallbackMemories = [];
		}
		return {
			...buildTimelineFallback(fallbackMemories),
			error: "Timeline API unavailable. Showing memory-index fallback.",
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
		if (filters.importance_min !== undefined) params.set("importance_min", filters.importance_min.toString());
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

export async function getSimilarMemories(id: string, k = 10, type?: string): Promise<Memory[]> {
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

export async function setMemoryPinned(id: string, pinned: boolean): Promise<{ success: boolean; error?: string }> {
	try {
		const response = await fetch(`${API_BASE}/api/memory/${encodeURIComponent(id)}`, {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				pinned,
				reason: "dashboard: embeddings pin toggle",
				changed_by: "dashboard",
			}),
		});
		if (!response.ok) {
			const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
			const error = typeof body.error === "string" ? body.error : `Request failed (${response.status})`;
			return { success: false, error };
		}
		return { success: true };
	} catch (error) {
		return { success: false, error: String(error) };
	}
}

export async function updateMemory(
	id: string,
	updates: {
		content?: string;
		type?: string;
		importance?: number;
		tags?: string;
		pinned?: boolean;
	},
	reason: string,
): Promise<{ success: boolean; error?: string }> {
	try {
		const response = await fetch(`${API_BASE}/api/memory/${encodeURIComponent(id)}`, {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				...updates,
				reason,
				changed_by: "dashboard",
			}),
		});
		if (!response.ok) {
			const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
			const error = typeof body.error === "string" ? body.error : `Request failed (${response.status})`;
			return { success: false, error };
		}
		return { success: true };
	} catch (error) {
		return { success: false, error: String(error) };
	}
}

export async function deleteMemory(
	id: string,
	reason: string,
	force = false,
): Promise<{ success: boolean; error?: string }> {
	try {
		const response = await fetch(`${API_BASE}/api/memory/${encodeURIComponent(id)}`, {
			method: "DELETE",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				reason,
				force,
			}),
		});
		if (!response.ok) {
			const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
			const rawError = typeof body.error === "string" ? body.error : `Request failed (${response.status})`;
			// Handle 409 "already deleted" as success (memory is already gone)
			const status = typeof body.status === "string" ? body.status : "";
			if (response.status === 409 && status === "already_deleted") {
				return { success: true };
			}
			return { success: false, error: rawError };
		}
		return { success: true };
	} catch (error) {
		return { success: false, error: String(error) };
	}
}

export async function getEmbeddings(
	withVectors = false,
	options: { limit?: number; offset?: number; agentId?: string } = {},
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
		if (typeof options.agentId === "string" && options.agentId.length > 0) {
			params.set("agent_id", options.agentId);
		}

		const response = await fetch(`${API_BASE}/api/embeddings?${params}`);
		if (!response.ok) throw new Error("Failed to fetch embeddings");

		const data = (await response.json()) as Partial<EmbeddingsResponse>;
		const embeddings = Array.isArray(data.embeddings) ? data.embeddings : [];

		return {
			embeddings,
			count: typeof data.count === "number" ? data.count : embeddings.length,
			total: typeof data.total === "number" ? data.total : embeddings.length,
			limit: typeof data.limit === "number" ? data.limit : (options.limit ?? embeddings.length),
			offset: typeof data.offset === "number" ? data.offset : (options.offset ?? 0),
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

export interface ProjectionNode {
	id: string;
	x: number;
	y: number;
	z?: number;
	content: string;
	who: string;
	importance: number;
	type: string | null;
	tags: string[];
	pinned?: boolean;
	sourceType?: string;
	sourceId?: string;
	createdAt: string;
}

export interface ProjectionResponse {
	status: "ready" | "computing" | "error";
	message?: string;
	dimensions?: number;
	count?: number;
	total?: number;
	limit?: number;
	offset?: number;
	hasMore?: boolean;
	nodes?: ProjectionNode[];
	edges?: [number, number][];
	cachedAt?: string;
}

export interface ProjectionQueryOptions {
	limit?: number;
	offset?: number;
	q?: string;
	who?: string[];
	types?: string[];
	sourceTypes?: string[];
	tags?: string[];
	pinned?: boolean;
	since?: string;
	until?: string;
	importanceMin?: number;
	importanceMax?: number;
	agentId?: string;
}

export async function getProjection(
	dimensions: 2 | 3 = 2,
	options: ProjectionQueryOptions = {},
): Promise<ProjectionResponse> {
	try {
		const params = new URLSearchParams({ dimensions: String(dimensions) });
		if (typeof options.limit === "number") params.set("limit", String(options.limit));
		if (typeof options.offset === "number") params.set("offset", String(options.offset));
		if (typeof options.q === "string" && options.q.trim().length > 0) params.set("q", options.q.trim());
		if (Array.isArray(options.who) && options.who.length > 0) params.set("who", options.who.join(","));
		if (Array.isArray(options.types) && options.types.length > 0) params.set("types", options.types.join(","));
		if (Array.isArray(options.sourceTypes) && options.sourceTypes.length > 0) {
			params.set("sourceTypes", options.sourceTypes.join(","));
		}
		if (Array.isArray(options.tags) && options.tags.length > 0) params.set("tags", options.tags.join(","));
		if (typeof options.pinned === "boolean") params.set("pinned", options.pinned ? "1" : "0");
		if (typeof options.since === "string" && options.since.length > 0) params.set("since", options.since);
		if (typeof options.until === "string" && options.until.length > 0) params.set("until", options.until);
		if (typeof options.importanceMin === "number") params.set("importanceMin", String(options.importanceMin));
		if (typeof options.importanceMax === "number") params.set("importanceMax", String(options.importanceMax));
		if (typeof options.agentId === "string" && options.agentId.length > 0) params.set("agent_id", options.agentId);

		const response = await fetch(`${API_BASE}/api/embeddings/projection?${params}`);
		if (response.status === 202) return { status: "computing" };
		if (!response.ok) {
			const body = await response.json().catch(() => ({}));
			const msg = (body as Record<string, unknown>).message ?? `HTTP ${response.status}`;
			return { status: "error", message: String(msg) };
		}
		return await response.json();
	} catch (err) {
		return {
			status: "error",
			message: err instanceof Error ? err.message : "Network error",
		};
	}
}

// ============================================================================
// Embedding Health API
// ============================================================================

export interface EmbeddingCheckResult {
	name: string;
	status: "ok" | "warn" | "fail";
	message: string;
	detail?: Record<string, unknown>;
	fix?: string;
}

export interface EmbeddingHealthReport {
	status: "healthy" | "degraded" | "unhealthy";
	score: number;
	checkedAt: string;
	config: {
		provider: string;
		model: string;
		dimensions: number;
	};
	checks: EmbeddingCheckResult[];
}

export async function getEmbeddingHealth(): Promise<EmbeddingHealthReport | null> {
	try {
		const response = await fetch(`${API_BASE}/api/embeddings/health`);
		if (!response.ok) return null;
		return await response.json();
	} catch {
		return null;
	}
}

export interface RepairActionResult {
	success: boolean;
	affected: number;
	message: string;
	action?: string;
	status: number;
}

export interface EmbeddingGapStats {
	unembedded: number;
	total: number;
	coverage: string;
}

async function runRepairAction(path: string, payload: Record<string, unknown>): Promise<RepairActionResult> {
	try {
		const response = await fetch(`${API_BASE}${path}`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(payload),
		});
		const body = (await response.json().catch(() => null)) as {
			success?: unknown;
			affected?: unknown;
			message?: unknown;
			error?: unknown;
			action?: unknown;
		} | null;

		const affected = typeof body?.affected === "number" ? body.affected : 0;
		const action = typeof body?.action === "string" ? body.action : undefined;
		const responseMessage =
			typeof body?.message === "string"
				? body.message
				: typeof body?.error === "string"
					? body.error
					: `HTTP ${response.status}`;

		if (response.ok) {
			const success = typeof body?.success === "boolean" ? body.success : true;
			return {
				success,
				affected,
				message: responseMessage,
				action,
				status: response.status,
			};
		}

		return {
			success: false,
			affected,
			message: responseMessage,
			action,
			status: response.status,
		};
	} catch (error) {
		return {
			success: false,
			affected: 0,
			message: error instanceof Error ? error.message : String(error),
			status: 0,
		};
	}
}

const DASHBOARD_REPAIR_PAYLOAD = {
	reason: "dashboard: embedding health",
	actor: "dashboard",
};

export async function repairCleanOrphans(): Promise<RepairActionResult> {
	return runRepairAction("/api/repair/clean-orphans", DASHBOARD_REPAIR_PAYLOAD);
}

export async function repairReEmbed(batchSize = 250, fullSweep = true): Promise<RepairActionResult> {
	return runRepairAction("/api/repair/re-embed", {
		...DASHBOARD_REPAIR_PAYLOAD,
		batchSize,
		fullSweep,
	});
}

export async function repairResyncVectorIndex(): Promise<RepairActionResult> {
	return runRepairAction("/api/repair/resync-vec", DASHBOARD_REPAIR_PAYLOAD);
}

export async function getEmbeddingGapStats(): Promise<EmbeddingGapStats | null> {
	try {
		const response = await fetch(`${API_BASE}/api/repair/embedding-gaps`);
		if (!response.ok) return null;
		const body = (await response.json()) as Partial<EmbeddingGapStats>;
		if (typeof body.unembedded !== "number" || typeof body.total !== "number" || typeof body.coverage !== "string") {
			return null;
		}
		return {
			unembedded: body.unembedded,
			total: body.total,
			coverage: body.coverage,
		};
	} catch {
		return null;
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

export async function getConnectors(): Promise<DocumentConnector[]> {
	try {
		const response = await fetch(`${API_BASE}/api/connectors`);
		if (!response.ok) return [];
		const data = await response.json();
		return data.connectors ?? [];
	} catch {
		return [];
	}
}

export interface SyncResult {
	status: string;
	error?: string;
	message?: string;
}

export interface BulkConnectorSyncResult {
	status: string;
	total: number;
	started: number;
	alreadySyncing: number;
	unsupported: number;
	failed: number;
	error?: string;
}

export async function syncConnector(id: string): Promise<SyncResult> {
	try {
		const response = await fetch(`${API_BASE}/api/connectors/${encodeURIComponent(id)}/sync`, { method: "POST" });
		return await response.json();
	} catch (e) {
		return { status: "error", error: e instanceof Error ? e.message : String(e) };
	}
}

export async function syncConnectorFull(id: string): Promise<SyncResult> {
	try {
		const response = await fetch(`${API_BASE}/api/connectors/${encodeURIComponent(id)}/sync/full?confirm=true`, {
			method: "POST",
		});
		return await response.json();
	} catch (e) {
		return { status: "error", error: e instanceof Error ? e.message : String(e) };
	}
}

export async function resyncConnectors(): Promise<BulkConnectorSyncResult> {
	try {
		const response = await fetch(`${API_BASE}/api/connectors/resync`, { method: "POST" });
		const body = (await response.json().catch(() => null)) as {
			status?: unknown;
			total?: unknown;
			started?: unknown;
			alreadySyncing?: unknown;
			unsupported?: unknown;
			failed?: unknown;
			error?: unknown;
		} | null;

		const status = typeof body?.status === "string" ? body.status : response.ok ? "ok" : "error";
		const total = typeof body?.total === "number" ? body.total : 0;
		const started = typeof body?.started === "number" ? body.started : 0;
		const alreadySyncing = typeof body?.alreadySyncing === "number" ? body.alreadySyncing : 0;
		const unsupported = typeof body?.unsupported === "number" ? body.unsupported : 0;
		const failed = typeof body?.failed === "number" ? body.failed : 0;
		const error = typeof body?.error === "string" ? body.error : response.ok ? undefined : `HTTP ${response.status}`;

		return {
			status,
			total,
			started,
			alreadySyncing,
			unsupported,
			failed,
			error,
		};
	} catch (e) {
		return {
			status: "error",
			total: 0,
			started: 0,
			alreadySyncing: 0,
			unsupported: 0,
			failed: 0,
			error: e instanceof Error ? e.message : String(e),
		};
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
		const response = await fetch(`${API_BASE}/api/secrets/${encodeURIComponent(name)}`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ value }),
		});
		return response.ok;
	} catch {
		return false;
	}
}

export async function deleteSecret(name: string): Promise<boolean> {
	try {
		const response = await fetch(`${API_BASE}/api/secrets/${encodeURIComponent(name)}`, {
			method: "DELETE",
		});
		return response.ok;
	} catch {
		return false;
	}
}

export interface OnePasswordVault {
	readonly id: string;
	readonly name: string;
}

export interface OnePasswordStatus {
	readonly configured: boolean;
	readonly connected: boolean;
	readonly vaultCount?: number;
	readonly vaults: readonly OnePasswordVault[];
	readonly error?: string;
}

export interface OnePasswordImportResult {
	readonly success: boolean;
	readonly importedCount?: number;
	readonly skippedCount?: number;
	readonly errorCount?: number;
	readonly itemsScanned?: number;
	readonly vaultsScanned?: number;
	readonly error?: string;
}

export async function getOnePasswordStatus(): Promise<OnePasswordStatus> {
	try {
		const response = await fetch(`${API_BASE}/api/secrets/1password/status`);
		if (!response.ok) {
			return {
				configured: false,
				connected: false,
				vaults: [],
			};
		}
		const data = await response.json();
		return {
			configured: data.configured === true,
			connected: data.connected === true,
			vaultCount: typeof data.vaultCount === "number" ? data.vaultCount : undefined,
			vaults: Array.isArray(data.vaults) ? data.vaults : [],
			error: typeof data.error === "string" ? data.error : undefined,
		};
	} catch {
		return {
			configured: false,
			connected: false,
			vaults: [],
		};
	}
}

export async function connectOnePassword(token: string): Promise<{
	readonly success: boolean;
	readonly error?: string;
	readonly vaultCount?: number;
	readonly vaults?: readonly OnePasswordVault[];
}> {
	try {
		const response = await fetch(`${API_BASE}/api/secrets/1password/connect`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ token }),
		});
		const data = await response.json();
		if (!response.ok) {
			return {
				success: false,
				error: typeof data.error === "string" ? data.error : "Failed to connect 1Password",
			};
		}

		return {
			success: true,
			vaultCount: typeof data.vaultCount === "number" ? data.vaultCount : undefined,
			vaults: Array.isArray(data.vaults) ? data.vaults : [],
		};
	} catch {
		return { success: false, error: "Failed to connect 1Password" };
	}
}

export async function disconnectOnePassword(): Promise<{
	readonly success: boolean;
	readonly error?: string;
}> {
	try {
		const response = await fetch(`${API_BASE}/api/secrets/1password/connect`, {
			method: "DELETE",
		});
		const data = await response.json();
		if (!response.ok) {
			return {
				success: false,
				error: typeof data.error === "string" ? data.error : "Failed to disconnect 1Password",
			};
		}
		return { success: true };
	} catch {
		return { success: false, error: "Failed to disconnect 1Password" };
	}
}

export async function listOnePasswordVaults(): Promise<readonly OnePasswordVault[]> {
	try {
		const response = await fetch(`${API_BASE}/api/secrets/1password/vaults`);
		if (!response.ok) return [];
		const data = await response.json();
		return Array.isArray(data.vaults) ? data.vaults : [];
	} catch {
		return [];
	}
}

export async function importOnePasswordSecrets(params: {
	readonly token?: string;
	readonly vaults?: readonly string[];
	readonly prefix?: string;
	readonly overwrite?: boolean;
}): Promise<OnePasswordImportResult> {
	try {
		const response = await fetch(`${API_BASE}/api/secrets/1password/import`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				token: params.token,
				vaults: params.vaults,
				prefix: params.prefix,
				overwrite: params.overwrite,
			}),
		});

		const data = await response.json();
		if (!response.ok) {
			return {
				success: false,
				error: typeof data.error === "string" ? data.error : "Failed to import from 1Password",
			};
		}

		return {
			success: true,
			importedCount: typeof data.importedCount === "number" ? data.importedCount : undefined,
			skippedCount: typeof data.skippedCount === "number" ? data.skippedCount : undefined,
			errorCount: typeof data.errorCount === "number" ? data.errorCount : undefined,
			itemsScanned: typeof data.itemsScanned === "number" ? data.itemsScanned : undefined,
			vaultsScanned: typeof data.vaultsScanned === "number" ? data.vaultsScanned : undefined,
		};
	} catch {
		return { success: false, error: "Failed to import from 1Password" };
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
	author?: string;
	maintainer?: string;
	verified?: boolean;
	permissions?: string[];
}

export interface SkillSearchResult {
	name: string;
	fullName: string;
	installs: string;
	installsRaw?: number;
	popularityScore?: number;
	description: string;
	installed: boolean;
	provider?: "skills.sh" | "clawhub";
	category?: string;
	stars?: number;
	downloads?: number;
	versions?: number;
	author?: string;
	maintainer?: string;
	verified?: boolean;
	permissions?: string[];
}

export interface SkillDetail extends Skill {
	content: string;
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

export async function getSkill(name: string, source?: string): Promise<Skill | null> {
	try {
		const params = source ? `?source=${encodeURIComponent(source)}` : "";
		const response = await fetch(`${API_BASE}/api/skills/${encodeURIComponent(name)}${params}`);
		if (!response.ok) return null;
		return await response.json();
	} catch {
		return null;
	}
}

export async function searchSkills(query: string): Promise<SkillSearchResult[]> {
	try {
		const response = await fetch(`${API_BASE}/api/skills/search?q=${encodeURIComponent(query)}`);
		if (!response.ok) throw new Error("Search failed");
		const data = await response.json();
		return data.results || [];
	} catch {
		return [];
	}
}

export async function browseSkills(): Promise<{
	results: SkillSearchResult[];
	total: number;
}> {
	try {
		const response = await fetch(`${API_BASE}/api/skills/browse`);
		if (!response.ok) throw new Error("Browse failed");
		return await response.json();
	} catch {
		return { results: [], total: 0 };
	}
}

export async function installSkill(name: string, source?: string): Promise<{ success: boolean; error?: string }> {
	try {
		const response = await fetch(`${API_BASE}/api/skills/install`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ name, source }),
		});
		return await response.json();
	} catch (e) {
		return { success: false, error: String(e) };
	}
}

export async function uninstallSkill(name: string): Promise<{ success: boolean; error?: string }> {
	try {
		const response = await fetch(`${API_BASE}/api/skills/${encodeURIComponent(name)}`, {
			method: "DELETE",
		});
		return await response.json();
	} catch (e) {
		return { success: false, error: String(e) };
	}
}

// ============================================================================
// Marketplace MCP API
// ============================================================================

export type MarketplaceMcpTransport = "stdio" | "http";

export interface MarketplaceMcpConfigStdio {
	transport: "stdio";
	command: string;
	args: string[];
	env: Record<string, string>;
	cwd?: string;
	timeoutMs: number;
}

export interface MarketplaceMcpConfigHttp {
	transport: "http";
	url: string;
	headers: Record<string, string>;
	timeoutMs: number;
}

export type MarketplaceMcpConfig = MarketplaceMcpConfigStdio | MarketplaceMcpConfigHttp;

export interface MarketplaceMcpServer {
	id: string;
	source: "mcpservers.org" | "modelcontextprotocol/servers" | "manual";
	catalogId?: string;
	name: string;
	description: string;
	category: string;
	homepage?: string;
	official: boolean;
	enabled: boolean;
	config: MarketplaceMcpConfig;
	installedAt: string;
	updatedAt: string;
}

export interface MarketplaceMcpCatalogEntry {
	id: string;
	source: "mcpservers.org" | "modelcontextprotocol/servers";
	catalogId: string;
	name: string;
	description: string;
	category: string;
	official: boolean;
	sponsor: boolean;
	popularityRank: number;
	sourceUrl: string;
	installed: boolean;
}

export interface MarketplaceMcpTool {
	id: string;
	serverId: string;
	serverName: string;
	toolName: string;
	description: string;
	readOnly: boolean;
	inputSchema: unknown;
}

export interface MarketplaceMcpServerHealth {
	serverId: string;
	serverName: string;
	ok: boolean;
	toolCount: number;
	error?: string;
}

export async function getMarketplaceMcpServers(): Promise<{
	servers: MarketplaceMcpServer[];
	count: number;
}> {
	try {
		const response = await fetch(`${API_BASE}/api/marketplace/mcp`);
		if (!response.ok) throw new Error("Failed to fetch MCP servers");
		return await response.json();
	} catch {
		return { servers: [], count: 0 };
	}
}

export async function browseMarketplaceMcpServers(pages = 5): Promise<{
	total: number;
	shown: number;
	pageSize: number;
	pages: number;
	results: MarketplaceMcpCatalogEntry[];
}> {
	try {
		const response = await fetch(`${API_BASE}/api/marketplace/mcp/browse?pages=${encodeURIComponent(String(pages))}`);
		if (!response.ok) throw new Error("Failed to browse MCP catalog");
		return await response.json();
	} catch {
		return { total: 0, shown: 0, pageSize: 30, pages: 0, results: [] };
	}
}

export async function getMarketplaceMcpDetail(
	id: string,
	source?: "mcpservers.org" | "modelcontextprotocol/servers",
): Promise<{
	id: string;
	source: "mcpservers.org" | "modelcontextprotocol/servers";
	name: string;
	description: string;
	githubUrl?: string;
	defaultConfig: MarketplaceMcpConfig | null;
} | null> {
	try {
		const params = new URLSearchParams({ id });
		if (source) params.set("source", source);
		const response = await fetch(`${API_BASE}/api/marketplace/mcp/detail?${params}`);
		if (!response.ok) return null;
		return await response.json();
	} catch {
		return null;
	}
}

export async function installMarketplaceMcpServer(input: {
	id: string;
	source?: "mcpservers.org" | "modelcontextprotocol/servers";
	alias?: string;
	config?: MarketplaceMcpConfig;
}): Promise<{ success: boolean; server?: MarketplaceMcpServer; error?: string }> {
	try {
		const response = await fetch(`${API_BASE}/api/marketplace/mcp/install`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(input),
		});
		return await response.json();
	} catch (e) {
		return { success: false, error: String(e) };
	}
}

export async function registerMarketplaceMcpServer(input: {
	name: string;
	description?: string;
	category?: string;
	config: MarketplaceMcpConfig;
}): Promise<{ success: boolean; server?: MarketplaceMcpServer; error?: string }> {
	try {
		const response = await fetch(`${API_BASE}/api/marketplace/mcp/register`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(input),
		});
		return await response.json();
	} catch (e) {
		return { success: false, error: String(e) };
	}
}

export async function updateMarketplaceMcpServer(
	id: string,
	input: Partial<{
		enabled: boolean;
		name: string;
		description: string;
		config: MarketplaceMcpConfig;
	}>,
): Promise<{ success: boolean; server?: MarketplaceMcpServer; error?: string }> {
	try {
		const response = await fetch(`${API_BASE}/api/marketplace/mcp/${encodeURIComponent(id)}`, {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(input),
		});
		return await response.json();
	} catch (e) {
		return { success: false, error: String(e) };
	}
}

export async function deleteMarketplaceMcpServer(
	id: string,
): Promise<{ success: boolean; id?: string; error?: string }> {
	try {
		const response = await fetch(`${API_BASE}/api/marketplace/mcp/${encodeURIComponent(id)}`, { method: "DELETE" });
		return await response.json();
	} catch (e) {
		return { success: false, error: String(e) };
	}
}

export async function getMarketplaceMcpTools(refresh = false): Promise<{
	count: number;
	tools: MarketplaceMcpTool[];
	servers: MarketplaceMcpServerHealth[];
}> {
	try {
		const qs = refresh ? "?refresh=1" : "";
		const response = await fetch(`${API_BASE}/api/marketplace/mcp/tools${qs}`);
		if (!response.ok) throw new Error("Failed to fetch tool catalog");
		return await response.json();
	} catch {
		return { count: 0, tools: [], servers: [] };
	}
}

export async function testMarketplaceMcpConfig(input: {
	config: MarketplaceMcpConfig;
}): Promise<{
	success: boolean;
	toolCount?: number;
	tools?: string[];
	latencyMs?: number;
	error?: string;
}> {
	try {
		const response = await fetch(`${API_BASE}/api/marketplace/mcp/test`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(input),
		});
		return await response.json();
	} catch (e) {
		return { success: false, error: String(e) };
	}
}

export type MarketplaceReviewTargetType = "skill" | "mcp";

export interface MarketplaceReview {
	id: string;
	targetType: MarketplaceReviewTargetType;
	targetId: string;
	displayName: string;
	rating: number;
	title: string;
	body: string;
	source: "local" | "synced";
	createdAt: string;
	updatedAt: string;
	syncedAt: string | null;
}

export interface MarketplaceReviewConfig {
	enabled: boolean;
	endpointUrl: string;
	lastSyncAt: string | null;
	lastSyncError: string | null;
	pending: number;
}

export async function getMarketplaceReviews(params: {
	targetType?: MarketplaceReviewTargetType;
	targetId?: string;
	limit?: number;
	offset?: number;
}): Promise<{
	reviews: MarketplaceReview[];
	total: number;
	limit: number;
	offset: number;
	summary: { count: number; avgRating: number };
}> {
	try {
		const search = new URLSearchParams();
		if (params.targetType) search.set("type", params.targetType);
		if (params.targetId) search.set("id", params.targetId);
		if (typeof params.limit === "number") search.set("limit", String(params.limit));
		if (typeof params.offset === "number") search.set("offset", String(params.offset));
		const query = search.toString();
		const response = await fetch(`${API_BASE}/api/marketplace/reviews${query ? `?${query}` : ""}`);
		if (!response.ok) throw new Error("Failed to fetch marketplace reviews");
		return await response.json();
	} catch {
		return {
			reviews: [],
			total: 0,
			limit: params.limit ?? 20,
			offset: params.offset ?? 0,
			summary: { count: 0, avgRating: 0 },
		};
	}
}

export async function createMarketplaceReview(input: {
	targetType: MarketplaceReviewTargetType;
	targetId: string;
	displayName: string;
	rating: number;
	title: string;
	body: string;
}): Promise<{ success: boolean; review?: MarketplaceReview; error?: string }> {
	try {
		const response = await fetch(`${API_BASE}/api/marketplace/reviews`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(input),
		});
		return await response.json();
	} catch (e) {
		return { success: false, error: String(e) };
	}
}

export async function deleteMarketplaceReview(id: string): Promise<{ success: boolean; id?: string; error?: string }> {
	try {
		const response = await fetch(`${API_BASE}/api/marketplace/reviews/${encodeURIComponent(id)}`, {
			method: "DELETE",
		});
		return await response.json();
	} catch (e) {
		return { success: false, error: String(e) };
	}
}

export async function getMarketplaceReviewConfig(): Promise<MarketplaceReviewConfig> {
	try {
		const response = await fetch(`${API_BASE}/api/marketplace/reviews/config`);
		if (!response.ok) throw new Error("Failed to fetch review config");
		return await response.json();
	} catch {
		return {
			enabled: false,
			endpointUrl: "",
			lastSyncAt: null,
			lastSyncError: null,
			pending: 0,
		};
	}
}

export async function updateMarketplaceReviewConfig(input: {
	enabled?: boolean;
	endpointUrl?: string;
}): Promise<{ success: boolean; config?: MarketplaceReviewConfig; error?: string }> {
	try {
		const response = await fetch(`${API_BASE}/api/marketplace/reviews/config`, {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(input),
		});
		return await response.json();
	} catch (e) {
		return { success: false, error: String(e) };
	}
}

export async function syncMarketplaceReviews(): Promise<{
	success: boolean;
	error?: string;
	sent?: number;
	synced?: number;
	message?: string;
}> {
	try {
		const response = await fetch(`${API_BASE}/api/marketplace/reviews/sync`, { method: "POST" });
		return await response.json();
	} catch (e) {
		return { success: false, error: String(e) };
	}
}

// ============================================================================
// Scheduled Tasks API
// ============================================================================

export interface ScheduledTask {
	id: string;
	name: string;
	prompt: string;
	cron_expression: string;
	harness: "claude-code" | "opencode" | "codex";
	working_directory: string | null;
	enabled: number;
	last_run_at: string | null;
	next_run_at: string | null;
	created_at: string;
	updated_at: string;
	last_run_status?: string | null;
	last_run_exit_code?: number | null;
	skill_name: string | null;
	skill_mode: "inject" | "slash" | null;
}

export interface TaskRun {
	id: string;
	task_id: string;
	status: "pending" | "running" | "completed" | "failed";
	started_at: string;
	completed_at: string | null;
	exit_code: number | null;
	stdout: string | null;
	stderr: string | null;
	error: string | null;
}

export interface CronPreset {
	label: string;
	expression: string;
}

export async function getTasks(): Promise<{
	tasks: ScheduledTask[];
	presets: CronPreset[];
}> {
	try {
		const response = await fetch(`${API_BASE}/api/tasks`);
		if (!response.ok) throw new Error("Failed to fetch tasks");
		return await response.json();
	} catch {
		return { tasks: [], presets: [] };
	}
}

export async function getTask(id: string): Promise<{ task: ScheduledTask; runs: TaskRun[] } | null> {
	try {
		const response = await fetch(`${API_BASE}/api/tasks/${encodeURIComponent(id)}`);
		if (!response.ok) return null;
		return await response.json();
	} catch {
		return null;
	}
}

export async function createTask(data: {
	name: string;
	prompt: string;
	cronExpression: string;
	harness: string;
	workingDirectory?: string;
	skillName?: string;
	skillMode?: string;
}): Promise<{ id?: string; error?: string }> {
	try {
		const response = await fetch(`${API_BASE}/api/tasks`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(data),
		});
		return await response.json();
	} catch (e) {
		return { error: String(e) };
	}
}

export async function updateTask(
	id: string,
	data: Partial<{
		name: string;
		prompt: string;
		cronExpression: string;
		harness: string;
		workingDirectory: string | null;
		enabled: boolean;
		skillName: string | null;
		skillMode: string | null;
	}>,
): Promise<{ success?: boolean; error?: string }> {
	try {
		const response = await fetch(`${API_BASE}/api/tasks/${encodeURIComponent(id)}`, {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(data),
		});
		return await response.json();
	} catch (e) {
		return { error: String(e) };
	}
}

export async function deleteTask(id: string): Promise<{ success?: boolean; error?: string }> {
	try {
		const response = await fetch(`${API_BASE}/api/tasks/${encodeURIComponent(id)}`, {
			method: "DELETE",
		});
		return await response.json();
	} catch (e) {
		return { error: String(e) };
	}
}

export async function triggerTaskRun(id: string): Promise<{ runId?: string; error?: string }> {
	try {
		const response = await fetch(`${API_BASE}/api/tasks/${encodeURIComponent(id)}/run`, {
			method: "POST",
		});
		return await response.json();
	} catch (e) {
		return { error: String(e) };
	}
}

export async function getTaskRuns(
	id: string,
	limit = 20,
	offset = 0,
): Promise<{ runs: TaskRun[]; total: number; hasMore: boolean }> {
	try {
		const response = await fetch(
			`${API_BASE}/api/tasks/${encodeURIComponent(id)}/runs?limit=${limit}&offset=${offset}`,
		);
		if (!response.ok) throw new Error("Failed to fetch runs");
		return await response.json();
	} catch {
		return { runs: [], total: 0, hasMore: false };
	}
}

// ---------------------------------------------------------------------------
// Pipeline status
// ---------------------------------------------------------------------------

export interface PipelineStatus {
	workers: Record<string, { running: boolean }>;
	queues: {
		memory: {
			pending: number;
			leased: number;
			completed: number;
			failed: number;
			dead: number;
		};
		summary: {
			pending: number;
			leased: number;
			completed: number;
			failed: number;
			dead: number;
		};
	};
	diagnostics: Record<string, unknown>;
	latency: Record<string, unknown>;
	errorSummary: Record<string, number>;
	mode: string;
	feedback?: {
		lastRunAt: string | null;
		feedbackAspectsUpdated: number;
		feedbackFtsConfirmations: number;
		feedbackDecayedAspects: number;
		feedbackPropagatedAttributes: number;
	};
}

export interface PipelinePauseResult {
	success: boolean;
	changed?: boolean;
	paused?: boolean;
	file?: string;
	mode?: string;
	error?: string;
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function readPipelinePauseResult(
	body: unknown,
	fallback: string,
): PipelinePauseResult {
	if (!isObject(body)) return { success: false, error: fallback };
	if (body.success !== true) {
		return {
			success: false,
			error: typeof body.error === "string" ? body.error : fallback,
		};
	}

	return {
		success: true,
		changed: typeof body.changed === "boolean" ? body.changed : undefined,
		paused: typeof body.paused === "boolean" ? body.paused : undefined,
		file: typeof body.file === "string" ? body.file : undefined,
		mode: typeof body.mode === "string" ? body.mode : undefined,
	};
}

async function updatePipelineMode(
	mode: "pause" | "resume",
): Promise<PipelinePauseResult> {
	try {
		const res = await fetch(`${API_BASE}/api/pipeline/${mode}`, {
			method: "POST",
		});
		const body = await res.json().catch(() => null);
		const fallback = `Request failed (${res.status})`;
		if (!res.ok) return readPipelinePauseResult(body, fallback);
		return readPipelinePauseResult(body, "Malformed pipeline response");
	} catch (e) {
		return { success: false, error: String(e) };
	}
}

export async function getPipelineStatus(): Promise<PipelineStatus | null> {
	try {
		const res = await fetch(`${API_BASE}/api/pipeline/status`);
		if (!res.ok) return null;
		return await res.json();
	} catch {
		return null;
	}
}

export async function pausePipeline(): Promise<PipelinePauseResult> {
	return updatePipelineMode("pause");
}

export async function resumePipeline(): Promise<PipelinePauseResult> {
	return updatePipelineMode("resume");
}

export interface KnowledgeEntityListItem {
	entity: {
		id: string;
		name: string;
		canonicalName?: string;
		entityType: string;
		description?: string;
		mentions?: number;
		pinned?: boolean;
		pinnedAt?: string | null;
		createdAt: string;
		updatedAt: string;
	};
	aspectCount: number;
	attributeCount: number;
	constraintCount: number;
	dependencyCount: number;
}

export interface KnowledgeEntityDetail extends KnowledgeEntityListItem {
	structuralDensity: {
		aspectCount: number;
		attributeCount: number;
		constraintCount: number;
		dependencyCount: number;
	};
	incomingDependencyCount: number;
	outgoingDependencyCount: number;
}

export interface KnowledgeAspectWithCounts {
	aspect: {
		id: string;
		entityId: string;
		agentId: string;
		name: string;
		canonicalName: string;
		weight: number;
		createdAt: string;
		updatedAt: string;
	};
	attributeCount: number;
	constraintCount: number;
}

export interface KnowledgeAttribute {
	id: string;
	aspectId: string;
	agentId: string;
	memoryId: string | null;
	kind: "attribute" | "constraint";
	content: string;
	normalizedContent: string;
	confidence: number;
	importance: number;
	status: "active" | "superseded" | "deleted";
	supersededBy: string | null;
	createdAt: string;
	updatedAt: string;
}

export interface KnowledgeDependencyEdge {
	id: string;
	direction: "incoming" | "outgoing";
	dependencyType: string;
	strength: number;
	aspectId: string | null;
	reason: string | null;
	sourceEntityId: string;
	sourceEntityName: string;
	targetEntityId: string;
	targetEntityName: string;
	createdAt: string;
	updatedAt: string;
}

export interface KnowledgeStats {
	entityCount: number;
	aspectCount: number;
	attributeCount: number;
	constraintCount: number;
	dependencyCount: number;
	unassignedMemoryCount: number;
	coveragePercent: number;
	feedbackUpdatedAspectCount: number;
	averageAspectWeight: number;
	maxWeightAspectCount: number;
	minWeightAspectCount: number;
}

export interface TraversalStatusSnapshot {
	phase: "session_start" | "recall";
	at: string;
	source: "project" | "checkpoint" | "query" | "session_key" | null;
	focalEntityNames: string[];
	focalEntities: number;
	traversedEntities: number;
	memoryCount: number;
	constraintCount: number;
	timedOut: boolean;
}

export interface PredictorEntitySlice {
	entityId: string;
	entityName: string;
	wins: number;
	losses: number;
	winRate: number;
	avgMargin: number;
}

export interface PredictorProjectSlice {
	project: string;
	wins: number;
	losses: number;
	winRate: number;
	avgMargin: number;
}

export interface PredictorTrainingRun {
	id: string;
	agentId: string;
	modelVersion: number;
	loss: number;
	sampleCount: number;
	durationMs: number;
	canaryNdcg: number | null;
	canaryNdcgDelta: number | null;
	canaryScoreVariance: number | null;
	canaryTopkChurn: number | null;
	createdAt: string;
}

export interface PinnedEntity {
	id: string;
	name: string;
	pinnedAt: string;
}

export interface EntityHealth {
	entityId: string;
	entityName: string;
	comparisonCount: number;
	winRate: number;
	avgMargin: number;
	trend: "improving" | "stable" | "declining";
}

export async function getKnowledgeEntities(
	filters: {
		type?: string;
		query?: string;
		limit?: number;
		offset?: number;
		agentId?: string;
	} = {},
): Promise<{ items: KnowledgeEntityListItem[]; limit: number; offset: number }> {
	try {
		const params = new URLSearchParams();
		if (filters.type) params.set("type", filters.type);
		if (filters.query) params.set("q", filters.query);
		if (typeof filters.limit === "number") params.set("limit", String(filters.limit));
		if (typeof filters.offset === "number") params.set("offset", String(filters.offset));
		if (filters.agentId) params.set("agent_id", filters.agentId);
		const res = await fetch(`${API_BASE}/api/knowledge/entities?${params.toString()}`);
		if (!res.ok) throw new Error("Failed to fetch knowledge entities");
		return await res.json();
	} catch {
		return { items: [], limit: filters.limit ?? 50, offset: filters.offset ?? 0 };
	}
}

export async function getKnowledgeEntity(id: string, agentId = "default"): Promise<KnowledgeEntityDetail | null> {
	try {
		const res = await fetch(
			`${API_BASE}/api/knowledge/entities/${encodeURIComponent(id)}?agent_id=${encodeURIComponent(agentId)}`,
		);
		if (!res.ok) return null;
		return await res.json();
	} catch {
		return null;
	}
}

export async function getKnowledgeAspects(entityId: string, agentId = "default"): Promise<KnowledgeAspectWithCounts[]> {
	try {
		const res = await fetch(
			`${API_BASE}/api/knowledge/entities/${encodeURIComponent(entityId)}/aspects?agent_id=${encodeURIComponent(agentId)}`,
		);
		if (!res.ok) throw new Error("Failed to fetch aspects");
		const data = (await res.json()) as { items?: KnowledgeAspectWithCounts[] };
		return data.items ?? [];
	} catch {
		return [];
	}
}

export async function getKnowledgeAttributes(
	entityId: string,
	aspectId: string,
	filters: {
		kind?: string;
		status?: string;
		limit?: number;
		offset?: number;
		agentId?: string;
	} = {},
): Promise<KnowledgeAttribute[]> {
	try {
		const params = new URLSearchParams();
		if (filters.kind) params.set("kind", filters.kind);
		if (filters.status) params.set("status", filters.status);
		if (typeof filters.limit === "number") params.set("limit", String(filters.limit));
		if (typeof filters.offset === "number") params.set("offset", String(filters.offset));
		if (filters.agentId) params.set("agent_id", filters.agentId);
		const res = await fetch(
			`${API_BASE}/api/knowledge/entities/${encodeURIComponent(entityId)}/aspects/${encodeURIComponent(aspectId)}/attributes?${params.toString()}`,
		);
		if (!res.ok) throw new Error("Failed to fetch attributes");
		const data = (await res.json()) as { items?: KnowledgeAttribute[] };
		return data.items ?? [];
	} catch {
		return [];
	}
}

export async function getKnowledgeDependencies(
	entityId: string,
	direction = "both",
	agentId = "default",
): Promise<KnowledgeDependencyEdge[]> {
	try {
		const res = await fetch(
			`${API_BASE}/api/knowledge/entities/${encodeURIComponent(entityId)}/dependencies?direction=${encodeURIComponent(direction)}&agent_id=${encodeURIComponent(agentId)}`,
		);
		if (!res.ok) throw new Error("Failed to fetch dependencies");
		const data = (await res.json()) as { items?: KnowledgeDependencyEdge[] };
		return data.items ?? [];
	} catch {
		return [];
	}
}

export async function getKnowledgeStats(agentId?: string): Promise<KnowledgeStats | null> {
	try {
		const url = agentId
			? `${API_BASE}/api/knowledge/stats?agent_id=${encodeURIComponent(agentId)}`
			: `${API_BASE}/api/knowledge/stats`;
		const res = await fetch(url);
		if (!res.ok) return null;
		return await res.json();
	} catch {
		return null;
	}
}

export async function getKnowledgeTraversalStatus(): Promise<TraversalStatusSnapshot | null> {
	try {
		const res = await fetch(`${API_BASE}/api/knowledge/traversal/status`);
		if (!res.ok) return null;
		const data = (await res.json()) as { status?: TraversalStatusSnapshot | null };
		return data.status ?? null;
	} catch {
		return null;
	}
}

export async function getPinnedKnowledgeEntities(agentId = "default"): Promise<PinnedEntity[]> {
	try {
		const res = await fetch(`${API_BASE}/api/knowledge/entities/pinned?agent_id=${encodeURIComponent(agentId)}`);
		if (!res.ok) throw new Error("Failed to fetch pinned entities");
		return await res.json();
	} catch {
		return [];
	}
}

export async function pinKnowledgeEntity(
	id: string,
	agentId = "default",
): Promise<{ pinned: true; pinnedAt: string } | null> {
	try {
		const res = await fetch(
			`${API_BASE}/api/knowledge/entities/${encodeURIComponent(id)}/pin?agent_id=${encodeURIComponent(agentId)}`,
			{ method: "POST" },
		);
		if (!res.ok) return null;
		return await res.json();
	} catch {
		return null;
	}
}

export async function unpinKnowledgeEntity(id: string, agentId = "default"): Promise<boolean> {
	try {
		const res = await fetch(
			`${API_BASE}/api/knowledge/entities/${encodeURIComponent(id)}/pin?agent_id=${encodeURIComponent(agentId)}`,
			{ method: "DELETE" },
		);
		return res.ok;
	} catch {
		return false;
	}
}

export async function getKnowledgeEntityHealth(
	filters: {
		agentId?: string;
		since?: string;
		minComparisons?: number;
	} = {},
): Promise<EntityHealth[]> {
	try {
		const params = new URLSearchParams();
		if (filters.agentId) params.set("agent_id", filters.agentId);
		if (filters.since) params.set("since", filters.since);
		if (typeof filters.minComparisons === "number") {
			params.set("min_comparisons", String(filters.minComparisons));
		}
		const res = await fetch(`${API_BASE}/api/knowledge/entities/health?${params.toString()}`);
		if (!res.ok) throw new Error("Failed to fetch entity health");
		return await res.json();
	} catch {
		return [];
	}
}

export async function getPredictorEntitySlices(since?: string): Promise<PredictorEntitySlice[]> {
	try {
		const params = new URLSearchParams();
		if (since) params.set("since", since);
		const res = await fetch(`${API_BASE}/api/predictor/comparisons/by-entity?${params.toString()}`);
		if (!res.ok) throw new Error("Failed to fetch predictor entity slices");
		const data = (await res.json()) as { items?: PredictorEntitySlice[] };
		return data.items ?? [];
	} catch {
		return [];
	}
}

export async function getPredictorProjectSlices(since?: string): Promise<PredictorProjectSlice[]> {
	try {
		const params = new URLSearchParams();
		if (since) params.set("since", since);
		const res = await fetch(`${API_BASE}/api/predictor/comparisons/by-project?${params.toString()}`);
		if (!res.ok) throw new Error("Failed to fetch predictor project slices");
		const data = (await res.json()) as { items?: PredictorProjectSlice[] };
		return data.items ?? [];
	} catch {
		return [];
	}
}

export async function getPredictorTrainingRuns(limit = 20): Promise<PredictorTrainingRun[]> {
	try {
		const res = await fetch(`${API_BASE}/api/predictor/training?limit=${limit}`);
		if (!res.ok) throw new Error("Failed to fetch predictor training runs");
		const data = (await res.json()) as { items?: PredictorTrainingRun[] };
		return data.items ?? [];
	} catch {
		return [];
	}
}

// ---------------------------------------------------------------------------
// Knowledge Graph Constellation Overlay
// ---------------------------------------------------------------------------

export interface ConstellationAttribute {
	id: string;
	content: string;
	kind: "attribute" | "constraint";
	importance: number;
	memoryId: string | null;
}

export interface ConstellationAspect {
	id: string;
	name: string;
	weight: number;
	attributes: ConstellationAttribute[];
}

export interface ConstellationEntity {
	id: string;
	name: string;
	entityType: string;
	mentions: number;
	pinned: boolean;
	aspects: ConstellationAspect[];
}

export interface ConstellationDependency {
	sourceEntityId: string;
	targetEntityId: string;
	dependencyType: string;
	strength: number;
}

export interface ConstellationGraph {
	entities: ConstellationEntity[];
	dependencies: ConstellationDependency[];
}

export async function getConstellationOverlay(agentId: string): Promise<ConstellationGraph | null> {
	try {
		const path = `${API_BASE}/api/knowledge/constellation?agent_id=${encodeURIComponent(agentId)}`;
		const res = await fetch(path);
		if (!res.ok) return null;
		return (await res.json()) as ConstellationGraph;
	} catch {
		return null;
	}
}

export interface MarkdownDoc {
	html: string;
	source: "github" | "local";
	cachedAt: number;
}

function extractReadmeOverview(content: string): string {
	const localFirstMatch = content.match(/Signet is a local-first[\s\S]*?without ever reading their values\./);
	const whyMatch = content.match(/Most AI tools build memory silos\.[\s\S]*?unless you configure it to\./);

	const normalizeParagraph = (text: string): string =>
		text
			.replace(/<\/?[^>]+>/g, " ")
			.replace(/\s+/g, " ")
			.trim();

	if (localFirstMatch && whyMatch) {
		return [
			"# Signet",
			"## Own your agent. Bring it anywhere.",
			normalizeParagraph(localFirstMatch[0]),
			"## Why Signet",
			normalizeParagraph(whyMatch[0]),
		].join("\n\n");
	}

	return content;
}

async function fetchRawGithubMarkdown(
	filename: string,
	transform?: (content: string) => string,
): Promise<MarkdownDoc | null> {
	try {
		const res = await fetch(`https://raw.githubusercontent.com/Signet-AI/signetai/main/${filename}`);
		if (!res.ok) return null;
		const raw = await res.text();
		const content = transform ? transform(raw) : raw;
		return {
			html: marked.parse(content, { async: false }) as string,
			source: "github",
			cachedAt: Date.now(),
		};
	} catch {
		return null;
	}
}

export async function fetchChangelog(): Promise<MarkdownDoc | null> {
	try {
		const res = await fetch(`${API_BASE}/api/changelog`);
		if (!res.ok) return null;
		return (await res.json()) as MarkdownDoc;
	} catch {
		return null;
	}
}

export async function fetchRoadmap(): Promise<MarkdownDoc | null> {
	try {
		const res = await fetch(`${API_BASE}/api/roadmap`);
		if (!res.ok) return null;
		return (await res.json()) as MarkdownDoc;
	} catch {
		return null;
	}
}

export async function fetchReadme(): Promise<MarkdownDoc | null> {
	try {
		const res = await fetch(`${API_BASE}/api/readme`);
		if (!res.ok) {
			return fetchRawGithubMarkdown("README.md", extractReadmeOverview);
		}
		return (await res.json()) as MarkdownDoc;
	} catch {
		return fetchRawGithubMarkdown("README.md", extractReadmeOverview);
	}
}

// ---------------------------------------------------------------------------
// Diagnostics
// ---------------------------------------------------------------------------

export interface DiagnosticsDomain {
	score: number;
	status: string;
	[key: string]: unknown;
}

export interface DiagnosticsReport {
	timestamp: string;
	composite: { score: number; status: string };
	queue: DiagnosticsDomain;
	storage: DiagnosticsDomain & { totalMemories?: number; dbSizeBytes?: number };
	index: DiagnosticsDomain & { embeddingCoverage?: number; ftsMismatch?: boolean };
	provider: DiagnosticsDomain & { availabilityRate?: number };
	connector: DiagnosticsDomain & { count?: number; errorCount?: number };
	predictor: DiagnosticsDomain & { alpha?: number; successRate?: number };
	mutation: DiagnosticsDomain;
	[key: string]: unknown;
}

export async function getDiagnostics(): Promise<DiagnosticsReport | null> {
	try {
		const res = await fetch(`${API_BASE}/api/diagnostics`);
		if (!res.ok) return null;
		return (await res.json()) as DiagnosticsReport;
	} catch {
		return null;
	}
}

// ---------------------------------------------------------------------------
// Home greeting (falls back gracefully)
// ---------------------------------------------------------------------------

export async function getHomeGreeting(): Promise<{ greeting: string } | null> {
	try {
		const res = await fetch(`${API_BASE}/api/home/greeting`);
		if (!res.ok) return null;
		return (await res.json()) as { greeting: string };
	} catch {
		return null;
	}
}

// ---------------------------------------------------------------------------
// Continuity scores
// ---------------------------------------------------------------------------

export interface ContinuityEntry {
	project: string;
	score: number;
	created_at: string;
}

export async function getContinuityLatest(): Promise<ContinuityEntry[]> {
	try {
		const res = await fetch(`${API_BASE}/api/analytics/continuity/latest`);
		if (!res.ok) return [];
		const body = (await res.json()) as { entries?: ContinuityEntry[] };
		return body.entries ?? [];
	} catch {
		return [];
	}
}

// ---------------------------------------------------------------------------
// Model Registry
// ---------------------------------------------------------------------------

export type { ModelRegistryEntry };

export async function getModelsByProvider(): Promise<Record<string, ModelRegistryEntry[]>> {
	try {
		const res = await fetch(`${API_BASE}/api/pipeline/models/by-provider`);
		if (!res.ok) return {};
		return (await res.json()) as Record<string, ModelRegistryEntry[]>;
	} catch {
		return {};
	}
}

// ============================================================================
// Signet OS Install API (Phase 7)
// ============================================================================

export interface InstallMcpOptions {
	url: string;
	name?: string;
	autoPlace?: boolean;
}

export interface InstallMcpResult {
	ok: boolean;
	widgetId: string;
	manifest: {
		name: string;
		icon?: string;
		ui?: string;
		defaultSize?: { w: number; h: number };
		dock?: boolean;
	} | null;
	error?: string;
}

export async function installMcp(options: InstallMcpOptions): Promise<InstallMcpResult> {
	// Validate URL scheme before making the request (SSRF prevention)
	try {
		const parsed = new URL(options.url);
		if (!["https:", "http:"].includes(parsed.protocol)) {
			return { ok: false, widgetId: "", manifest: null, error: "Only HTTP/HTTPS URLs are supported" };
		}
	} catch {
		return { ok: false, widgetId: "", manifest: null, error: "Invalid URL format" };
	}

	try {
		const response = await fetch(`${API_BASE}/api/os/install`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(options),
		});
		if (!response.ok) {
			const body = await response.json().catch(() => ({}));
			const error =
				typeof (body as Record<string, unknown>).error === "string"
					? ((body as Record<string, unknown>).error as string)
					: `Install failed (HTTP ${response.status})`;
			return { ok: false, widgetId: "", manifest: null, error };
		}
		return await response.json();
	} catch (e) {
		return {
			ok: false,
			widgetId: "",
			manifest: null,
			error: e instanceof Error ? e.message : String(e),
		};
	}
}

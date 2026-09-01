import { createHash } from "node:crypto";

export const PROJECTION_MAX_ROWS = 1_000;
export const PROJECTION_MAX_OFFSET = 100_000;
export const PROJECTION_VECTOR_DIMENSIONS = 64;
export const PROJECTION_CONTENT_MAX_CHARS = 256;
export const PROJECTION_SNAPSHOT_MAX_BYTES = 4 * 1024 * 1024;
export const PROJECTION_MAX_IN_FLIGHT = 2;
export const PROJECTION_JOB_DEADLINE_MS = 10_000;
export const PROJECTION_TERMINATION_GRACE_MS = 250;
export const PROJECTION_READY_CACHE_TTL_MS = 60_000;
export const PROJECTION_READY_CACHE_MAX_ENTRIES = 8;
export const PROJECTION_JOB_STATUS_TTL_MS = 60_000;
export const PROJECTION_JOB_STATUS_MAX_ENTRIES = 128;
export const PROJECTION_SELECTION_VERSION = "recency-v1" as const;
export const PROJECTION_ALGORITHM_VERSION = "umap-knn-v1" as const;

export interface ProjectionFilters {
	readonly query?: string;
	readonly who?: readonly string[];
	readonly types?: readonly string[];
	readonly sourceTypes?: readonly string[];
	readonly tags?: readonly string[];
	readonly pinned?: boolean;
	readonly since?: string;
	readonly until?: string;
	readonly importanceMin?: number;
	readonly importanceMax?: number;
}

export interface ProjectionPrincipal {
	readonly agentId: string;
	readonly project: string | null;
}

export interface ProjectionRequest {
	readonly dimensions: 2 | 3;
	readonly limit: number;
	readonly offset: number;
	readonly filters: ProjectionFilters;
}

export interface ProjectionRequestIdentity {
	readonly version: "projection-request-v1";
	readonly principal: ProjectionPrincipal;
	readonly request: ProjectionRequest;
	readonly selectionVersion: typeof PROJECTION_SELECTION_VERSION;
	readonly algorithmVersion: typeof PROJECTION_ALGORITHM_VERSION;
}

export interface ProjectionSnapshotDescriptor {
	readonly version: 1;
	readonly snapshotId: string;
	readonly path: string;
	readonly outputDirectory: string;
	readonly sizeBytes: number;
	readonly total: number;
	readonly count: number;
	readonly limit: number;
	readonly offset: number;
	readonly hasMore: boolean;
	readonly sampled: boolean;
	readonly selection: typeof PROJECTION_SELECTION_VERSION;
}

export interface ProjectionSnapshotWire {
	readonly version: 1;
	readonly principal: ProjectionPrincipal;
	readonly request: ProjectionRequest;
	readonly rows: readonly Record<string, unknown>[];
}

function stable(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
	if (typeof value !== "object" || value === null) return JSON.stringify(value);
	return `{${Object.entries(value as Record<string, unknown>)
		.sort(([left], [right]) => left.localeCompare(right))
		.map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`)
		.join(",")}}`;
}

function normalizedStrings(values: readonly string[] | undefined): readonly string[] {
	return [...new Set((values ?? []).map((value) => value.trim()).filter(Boolean))].sort();
}

export function normalizeProjectionFilters(filters: ProjectionFilters | undefined): ProjectionFilters {
	const normalized: ProjectionFilters = {
		...(filters?.query?.trim() ? { query: filters.query.trim() } : {}),
		...(normalizedStrings(filters?.who).length > 0 ? { who: normalizedStrings(filters?.who) } : {}),
		...(normalizedStrings(filters?.types).length > 0 ? { types: normalizedStrings(filters?.types) } : {}),
		...(normalizedStrings(filters?.sourceTypes).length > 0
			? { sourceTypes: normalizedStrings(filters?.sourceTypes) }
			: {}),
		...(normalizedStrings(filters?.tags).length > 0 ? { tags: normalizedStrings(filters?.tags) } : {}),
		...(typeof filters?.pinned === "boolean" ? { pinned: filters.pinned } : {}),
		...(filters?.since ? { since: filters.since } : {}),
		...(filters?.until ? { until: filters.until } : {}),
		...(typeof filters?.importanceMin === "number" ? { importanceMin: filters.importanceMin } : {}),
		...(typeof filters?.importanceMax === "number" ? { importanceMax: filters.importanceMax } : {}),
	};
	return normalized;
}

export function projectionRequestKey(principal: ProjectionPrincipal, request: ProjectionRequest): string {
	const identity: ProjectionRequestIdentity = {
		version: "projection-request-v1",
		principal,
		request: { ...request, filters: normalizeProjectionFilters(request.filters) },
		selectionVersion: PROJECTION_SELECTION_VERSION,
		algorithmVersion: PROJECTION_ALGORITHM_VERSION,
	};
	return `projection:v1:${createHash("sha256").update(stable(identity)).digest("hex")}`;
}

export function projectionScopeClause(principal: ProjectionPrincipal): { clause: string; params: (string | null)[] } {
	return {
		clause:
			" AND COALESCE(NULLIF(m.agent_id, ''), 'default') = ? AND (? IS NULL OR m.project = ?) AND COALESCE(m.is_deleted, 0) = 0 AND (m.superseded_by IS NULL OR m.superseded_by = '') AND m.visibility != 'archived' AND m.stale_at IS NULL",
		params: [principal.agentId, principal.project, principal.project],
	};
}

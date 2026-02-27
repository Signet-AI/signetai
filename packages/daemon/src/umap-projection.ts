/**
 * Server-side UMAP projection — loads embeddings from the DB, runs
 * dimensionality reduction, builds KNN edges, normalises coordinates
 * to [-210, 210], and caches the result in the umap_cache table.
 */

import { UMAP } from "umap-js";
import type { ReadDb, WriteDb } from "./db-accessor";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface ProjectionNode {
	readonly id: string;
	readonly x: number;
	readonly y: number;
	readonly z?: number;
	readonly content: string;
	readonly who: string;
	readonly importance: number;
	readonly type: string;
	readonly tags: readonly string[];
	readonly pinned: boolean;
	readonly sourceType: string;
	readonly sourceId: string;
	readonly createdAt: string;
}

export interface ProjectionResult {
	readonly nodes: readonly ProjectionNode[];
	readonly edges: readonly [number, number][];
}

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

export interface ProjectionQuery {
	readonly limit?: number;
	readonly offset?: number;
	readonly filters?: ProjectionFilters;
}

export interface ProjectionQueryResult {
	readonly result: ProjectionResult;
	readonly total: number;
	readonly count: number;
	readonly limit: number;
	readonly offset: number;
	readonly hasMore: boolean;
}

export interface CachedProjection {
	readonly result: ProjectionResult;
	readonly embeddingCount: number;
	readonly cachedAt: string;
}

// ---------------------------------------------------------------------------
// Internal constants
// ---------------------------------------------------------------------------

const SCALE = 420;
const KNN_K = 4;
const KNN_EXACT_THRESHOLD = 450;

// ---------------------------------------------------------------------------
// Vector helpers
// ---------------------------------------------------------------------------

function blobToVector(buf: Uint8Array, dimensions: number | null): number[] {
	const raw = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
	const f32 = new Float32Array(raw);
	const size =
		typeof dimensions === "number" && dimensions > 0 && dimensions <= f32.length
			? dimensions
			: f32.length;
	return Array.from(f32.slice(0, size));
}

function parseTags(raw: unknown): string[] {
	if (typeof raw !== "string" || !raw) return [];
	return raw
		.split(",")
		.map((t) => t.trim())
		.filter(Boolean);
}

function normaliseAxis(values: readonly number[]): number[] {
	let min = Infinity;
	let max = -Infinity;
	for (const v of values) {
		if (v < min) min = v;
		if (v > max) max = v;
	}
	const range = max - min || 1;
	return values.map((v) => ((v - min) / range - 0.5) * SCALE);
}

// ---------------------------------------------------------------------------
// KNN edge builders (ported from embedding-graph.ts)
// ---------------------------------------------------------------------------

function buildExactKnnEdges(
	projected: readonly number[][],
	k: number,
): [number, number][] {
	const edgeSet = new Set<string>();
	const result: [number, number][] = [];
	for (let i = 0; i < projected.length; i++) {
		const dists: { j: number; d: number }[] = [];
		for (let j = 0; j < projected.length; j++) {
			if (i === j) continue;
			let d = 0;
			for (let c = 0; c < projected[i].length; c++) {
				const diff = projected[i][c] - projected[j][c];
				d += diff * diff;
			}
			dists.push({ j, d });
		}
		dists.sort((a, b) => a.d - b.d);
		for (let n = 0; n < Math.min(k, dists.length); n++) {
			const a = Math.min(i, dists[n].j);
			const b = Math.max(i, dists[n].j);
			const key = `${a}-${b}`;
			if (!edgeSet.has(key)) {
				edgeSet.add(key);
				result.push([a, b]);
			}
		}
	}
	return result;
}

function buildApproximateKnnEdges(
	projected: readonly number[][],
	k: number,
): [number, number][] {
	const edgeSet = new Set<string>();
	const result: [number, number][] = [];
	const ids = projected.map((_, i) => i);
	const byX = [...ids].sort((a, b) => projected[a][0] - projected[b][0]);
	const byY = [...ids].sort((a, b) => projected[a][1] - projected[b][1]);
	const windowSize = Math.max(2, k * 3);

	const addEdge = (a: number, b: number): void => {
		if (a === b) return;
		const left = Math.min(a, b);
		const right = Math.max(a, b);
		const key = `${left}-${right}`;
		if (edgeSet.has(key)) return;
		edgeSet.add(key);
		result.push([left, right]);
	};

	const addFromOrdering = (ordering: number[]): void => {
		for (let idx = 0; idx < ordering.length; idx++) {
			const source = ordering[idx];
			for (let offset = 1; offset <= windowSize; offset++) {
				const left = idx - offset;
				const right = idx + offset;
				if (left >= 0) addEdge(source, ordering[left]);
				if (right < ordering.length) addEdge(source, ordering[right]);
			}
		}
	};

	addFromOrdering(byX);
	addFromOrdering(byY);
	return result;
}

function buildKnnEdges(
	projected: readonly number[][],
	k: number,
): [number, number][] {
	if (projected.length <= KNN_EXACT_THRESHOLD)
		return buildExactKnnEdges(projected, k);
	return buildApproximateKnnEdges(projected, k);
}

// ---------------------------------------------------------------------------
// Row type + validation
// ---------------------------------------------------------------------------

interface EmbeddingRow {
	id: string;
	content: string;
	who: string | null;
	importance: number | null;
	type: string | null;
	tags: string | null;
	pinned: number | null;
	source_type: string | null;
	source_id: string | null;
	created_at: string;
	vector: Uint8Array;
	dimensions: number | null;
}

function isBlob(v: unknown): v is Uint8Array {
	return v instanceof Uint8Array || Buffer.isBuffer(v);
}

function toEmbeddingRow(raw: Record<string, unknown>): EmbeddingRow | null {
	const { id, content, created_at, vector } = raw;
	if (
		typeof id !== "string" ||
		typeof content !== "string" ||
		typeof created_at !== "string" ||
		!isBlob(vector)
	) {
		return null;
	}
	return {
		id,
		content,
		who: typeof raw.who === "string" ? raw.who : null,
		importance: typeof raw.importance === "number" ? raw.importance : null,
		type: typeof raw.type === "string" ? raw.type : null,
		tags: typeof raw.tags === "string" ? raw.tags : null,
		pinned: typeof raw.pinned === "number" ? raw.pinned : null,
		source_type:
			typeof raw.source_type === "string" ? raw.source_type : null,
		source_id: typeof raw.source_id === "string" ? raw.source_id : null,
		created_at,
		vector,
		dimensions: typeof raw.dimensions === "number" ? raw.dimensions : null,
	};
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

const EMBEDDINGS_SELECT_SQL = `
	SELECT m.id, m.content, m.who, m.importance, m.type, m.tags, m.pinned,
	       m.source_type, m.source_id, m.created_at,
	       e.vector, e.dimensions
`;

const EMBEDDINGS_FROM_SQL = `
	FROM embeddings e
	INNER JOIN memories m ON m.id = e.source_id
	WHERE e.source_type = 'memory'
`;

function normalizeFilterValues(values: readonly string[] | undefined): string[] {
	if (!values) return [];
	const normalized = values
		.map((value) => value.trim())
		.filter((value) => value.length > 0);
	return [...new Set(normalized)];
}

function buildProjectionWhere(filters: ProjectionFilters | undefined): {
	clause: string;
	params: unknown[];
} {
	if (!filters) return { clause: "", params: [] };

	const parts: string[] = [];
	const params: unknown[] = [];

	const query = filters.query?.trim();
	if (query && query.length > 0) {
		const pattern = `%${query}%`;
		parts.push(
			"(m.content LIKE ? OR m.tags LIKE ? OR m.who LIKE ? OR m.type LIKE ? OR m.source_type LIKE ? OR m.source_id LIKE ?)",
		);
		params.push(pattern, pattern, pattern, pattern, pattern, pattern);
	}

	const whoValues = normalizeFilterValues(filters.who);
	if (whoValues.length > 0) {
		parts.push(`m.who IN (${whoValues.map(() => "?").join(", ")})`);
		params.push(...whoValues);
	}

	const typeValues = normalizeFilterValues(filters.types);
	if (typeValues.length > 0) {
		parts.push(`m.type IN (${typeValues.map(() => "?").join(", ")})`);
		params.push(...typeValues);
	}

	const sourceTypeValues = normalizeFilterValues(filters.sourceTypes);
	if (sourceTypeValues.length > 0) {
		parts.push(
			`m.source_type IN (${sourceTypeValues.map(() => "?").join(", ")})`,
		);
		params.push(...sourceTypeValues);
	}

	const tagValues = normalizeFilterValues(filters.tags);
	for (const tag of tagValues) {
		parts.push("m.tags LIKE ?");
		params.push(`%${tag}%`);
	}

	if (typeof filters.pinned === "boolean") {
		parts.push("m.pinned = ?");
		params.push(filters.pinned ? 1 : 0);
	}

	if (typeof filters.since === "string" && filters.since.length > 0) {
		parts.push("m.created_at >= ?");
		params.push(filters.since);
	}

	if (typeof filters.until === "string" && filters.until.length > 0) {
		parts.push("m.created_at <= ?");
		params.push(filters.until);
	}

	if (
		typeof filters.importanceMin === "number" &&
		Number.isFinite(filters.importanceMin)
	) {
		parts.push("m.importance >= ?");
		params.push(filters.importanceMin);
	}

	if (
		typeof filters.importanceMax === "number" &&
		Number.isFinite(filters.importanceMax)
	) {
		parts.push("m.importance <= ?");
		params.push(filters.importanceMax);
	}

	return {
		clause: parts.length > 0 ? ` AND ${parts.join(" AND ")}` : "",
		params,
	};
}

interface ProjectionRowsResult {
	readonly rows: EmbeddingRow[];
	readonly total: number;
	readonly offset: number;
	readonly limit: number;
	readonly hasMore: boolean;
}

function loadProjectionRows(
	db: ReadDb,
	query: ProjectionQuery,
): ProjectionRowsResult {
	const offset =
		typeof query.offset === "number" && Number.isFinite(query.offset)
			? Math.max(0, Math.trunc(query.offset))
			: 0;
	const requestedLimit =
		typeof query.limit === "number" && Number.isFinite(query.limit)
			? Math.max(1, Math.trunc(query.limit))
			: null;

	const { clause, params } = buildProjectionWhere(query.filters);

	const totalRow = db
		.prepare(
			`SELECT COUNT(*) AS count ${EMBEDDINGS_FROM_SQL}${clause}`,
		)
		.get(...params) as { count?: number } | undefined;
	const total =
		totalRow !== undefined && typeof totalRow.count === "number"
			? totalRow.count
			: 0;

	let sql = `${EMBEDDINGS_SELECT_SQL} ${EMBEDDINGS_FROM_SQL}${clause} ORDER BY m.created_at DESC`;
	const rowParams: unknown[] = [...params];
	if (requestedLimit !== null) {
		sql += " LIMIT ? OFFSET ?";
		rowParams.push(requestedLimit, offset);
	} else if (offset > 0) {
		sql += " LIMIT -1 OFFSET ?";
		rowParams.push(offset);
	}

	const rawRows = db.prepare(sql).all(...rowParams) as Record<string, unknown>[];
	const rows = rawRows
		.map(toEmbeddingRow)
		.filter((row): row is EmbeddingRow => row !== null);
	const limit =
		requestedLimit ?? Math.max(0, total - offset);
	const hasMore = offset + rows.length < total;

	return { rows, total, offset, limit, hasMore };
}

function buildNodesFromRows(
	rows: readonly EmbeddingRow[],
	xs: readonly number[],
	ys: readonly number[],
	zs: readonly number[] | null,
): ProjectionNode[] {
	return rows.map((row, i) => {
		const base = {
			id: row.id,
			x: xs[i],
			y: ys[i],
			content: row.content,
			who: row.who ?? "unknown",
			importance: row.importance ?? 0.5,
			type: row.type ?? "memory",
			tags: parseTags(row.tags),
			pinned: row.pinned === 1,
			sourceType: row.source_type ?? "memory",
			sourceId: row.source_id ?? row.id,
			createdAt: row.created_at,
		};
		return zs !== null ? { ...base, z: zs[i] } : base;
	});
}

function computeProjectionFromRows(
	rows: readonly EmbeddingRow[],
	nComponents: 2 | 3,
): ProjectionResult {
	if (rows.length === 0) return { nodes: [], edges: [] };
	if (rows.length === 1) {
		return {
			nodes: buildNodesFromRows(rows, [0], [0], nComponents === 3 ? [0] : null),
			edges: [],
		};
	}
	if (rows.length === 2) {
		const xs = [-SCALE * 0.25, SCALE * 0.25];
		const ys = [0, 0];
		const zs = nComponents === 3 ? [0, 0] : null;
		return {
			nodes: buildNodesFromRows(rows, xs, ys, zs),
			edges: [[0, 1]],
		};
	}

	const vectors = rows.map((row) => blobToVector(row.vector, row.dimensions));
	const nNeighbors = Math.min(15, Math.max(2, vectors.length - 1));
	const umap = new UMAP({ nComponents, nNeighbors, minDist: 0.1, spread: 1.0 });
	const projected: number[][] = umap.fit(vectors);

	const xs = normaliseAxis(projected.map((point) => point[0]));
	const ys = normaliseAxis(projected.map((point) => point[1]));
	const zs: number[] | null =
		nComponents === 3
			? normaliseAxis(projected.map((point) => point[2] ?? 0))
			: null;
	const nodes = buildNodesFromRows(rows, xs, ys, zs);
	const edges = buildKnnEdges(projected, KNN_K);

	return { nodes, edges };
}

export function computeProjection(
	db: ReadDb,
	nComponents: 2 | 3,
): ProjectionResult {
	const { rows } = loadProjectionRows(db, {});
	return computeProjectionFromRows(rows, nComponents);
}

export function computeProjectionForQuery(
	db: ReadDb,
	nComponents: 2 | 3,
	query: ProjectionQuery,
): ProjectionQueryResult {
	const loaded = loadProjectionRows(db, query);
	const result = computeProjectionFromRows(loaded.rows, nComponents);
	return {
		result,
		total: loaded.total,
		count: loaded.rows.length,
		limit: loaded.limit,
		offset: loaded.offset,
		hasMore: loaded.hasMore,
	};
}

export function getCachedProjection(
	db: ReadDb,
	nComponents: 2 | 3,
): CachedProjection | null {
	const rawRow: Record<string, unknown> | null | undefined = db
		.prepare(
			"SELECT dimensions, embedding_count, payload, created_at FROM umap_cache WHERE dimensions = ? LIMIT 1",
		)
		.get(nComponents);

	if (!rawRow) return null;

	const payload = rawRow.payload;
	const embeddingCount = rawRow.embedding_count;
	const cachedAt = rawRow.created_at;

	if (
		typeof payload !== "string" ||
		typeof embeddingCount !== "number" ||
		typeof cachedAt !== "string"
	) {
		return null;
	}

	try {
		const result: ProjectionResult = JSON.parse(payload);
		return { result, embeddingCount, cachedAt };
	} catch {
		return null;
	}
}

export function cacheProjection(
	db: WriteDb,
	nComponents: 2 | 3,
	payload: ProjectionResult,
	embeddingCount: number,
): void {
	db.prepare("DELETE FROM umap_cache WHERE dimensions = ?").run(nComponents);
	db.prepare(
		"INSERT INTO umap_cache (dimensions, embedding_count, payload, created_at) VALUES (?, ?, ?, ?)",
	).run(nComponents, embeddingCount, JSON.stringify(payload), new Date().toISOString());
}

export function invalidateProjectionCache(db: WriteDb): void {
	db.prepare("DELETE FROM umap_cache").run();
}

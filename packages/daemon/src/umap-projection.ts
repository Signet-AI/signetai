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
	readonly createdAt: string;
}

export interface ProjectionResult {
	readonly nodes: readonly ProjectionNode[];
	readonly edges: readonly [number, number][];
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

function blobToVector(buf: Buffer, dimensions: number | null): number[] {
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
	created_at: string;
	vector: Buffer;
	dimensions: number | null;
}

function toEmbeddingRow(raw: Record<string, unknown>): EmbeddingRow | null {
	const { id, content, created_at, vector } = raw;
	if (
		typeof id !== "string" ||
		typeof content !== "string" ||
		typeof created_at !== "string" ||
		!Buffer.isBuffer(vector)
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
		created_at,
		vector,
		dimensions: typeof raw.dimensions === "number" ? raw.dimensions : null,
	};
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

const EMBEDDINGS_SQL = `
	SELECT m.id, m.content, m.who, m.importance, m.type, m.tags,
	       m.source_type, m.source_id, m.created_at,
	       e.vector, e.dimensions
	FROM embeddings e
	INNER JOIN memories m ON m.id = e.source_id
	WHERE e.source_type = 'memory'
	ORDER BY m.created_at DESC
`;

export function computeProjection(
	db: ReadDb,
	nComponents: 2 | 3,
): ProjectionResult {
	const rawRows: Record<string, unknown>[] = db.prepare(EMBEDDINGS_SQL).all();
	const rows = rawRows
		.map(toEmbeddingRow)
		.filter((r): r is EmbeddingRow => r !== null);

	if (rows.length === 0) return { nodes: [], edges: [] };

	const vectors = rows.map((r) => blobToVector(r.vector, r.dimensions));
	const nNeighbors = Math.min(15, Math.max(2, vectors.length - 1));

	const umap = new UMAP({ nComponents, nNeighbors, minDist: 0.1, spread: 1.0 });
	const projected: number[][] = umap.fit(vectors);

	const xs = normaliseAxis(projected.map((p) => p[0]));
	const ys = normaliseAxis(projected.map((p) => p[1]));
	const zs: number[] | null =
		nComponents === 3
			? normaliseAxis(projected.map((p) => p[2] ?? 0))
			: null;

	const nodes: ProjectionNode[] = rows.map((row, i) => {
		const base = {
			id: row.id,
			x: xs[i],
			y: ys[i],
			content: row.content,
			who: row.who ?? "unknown",
			importance: row.importance ?? 0.5,
			type: row.type ?? "memory",
			tags: parseTags(row.tags),
			createdAt: row.created_at,
		};
		return zs !== null ? { ...base, z: zs[i] } : base;
	});

	const edges = buildKnnEdges(projected, KNN_K);

	return { nodes, edges };
}

export function getCachedProjection(
	db: ReadDb,
	nComponents: 2 | 3,
): CachedProjection | null {
	const rawRow: Record<string, unknown> | undefined = db
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

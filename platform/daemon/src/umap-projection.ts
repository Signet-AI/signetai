import { createRequire } from "node:module";
import { UMAP } from "umap-js";
import type { ReadScope } from "./read-scope";
let nativeKnn: typeof import("@signet/native") | null = null;
try {
	const esmRequire = createRequire(import.meta.url);
	nativeKnn = esmRequire("@signet/native");
} catch {}

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
	readonly scope?: ReadScope;
}

export interface ProjectionQueryResult {
	readonly result: ProjectionResult;
	readonly total: number;
	readonly count: number;
	readonly limit: number;
	readonly offset: number;
	readonly hasMore: boolean;
}

const SCALE = 420;
const KNN_K = 4;
const KNN_EXACT_THRESHOLD = 450;
const KNN_APPROX_WINDOW_MULTIPLIER = 6;
const UMAP_MAX_DIMENSIONS = 64;

interface ScoredNeighbor {
	readonly index: number;
	readonly distance: number;
}
function squaredDistance(left: readonly number[], right: readonly number[]): number {
	let distance = 0;
	for (let index = 0; index < left.length; index += 1) {
		const diff = left[index] - right[index];
		distance += diff * diff;
	}
	return distance;
}

function insertNearestNeighbor(neighbors: ScoredNeighbor[], next: ScoredNeighbor, k: number): void {
	let index = 0;
	while (index < neighbors.length && neighbors[index].distance <= next.distance) {
		index += 1;
	}
	if (index >= k) return;
	neighbors.splice(index, 0, next);
	if (neighbors.length > k) neighbors.pop();
}

function blobToVector(buf: Uint8Array, dimensions: number | null): number[] {
	const raw = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
	const f32 = new Float32Array(raw);
	const size = typeof dimensions === "number" && dimensions > 0 && dimensions <= f32.length ? dimensions : f32.length;
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
	let min = Number.POSITIVE_INFINITY;
	let max = Number.NEGATIVE_INFINITY;
	for (const v of values) {
		if (v < min) min = v;
		if (v > max) max = v;
	}
	const range = max - min || 1;
	return values.map((v) => ((v - min) / range - 0.5) * SCALE);
}

function buildExactKnnEdges(projected: readonly number[][], k: number): [number, number][] {
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

function buildApproximateKnnEdges(projected: readonly number[][], k: number): [number, number][] {
	const edgeSet = new Set<string>();
	const result: [number, number][] = [];
	if (projected.length <= 2) return result;

	const ids = projected.map((_, i) => i);
	const byX = [...ids].sort((a, b) => projected[a][0] - projected[b][0]);
	const byY = [...ids].sort((a, b) => projected[a][1] - projected[b][1]);
	const windowSize = Math.max(4, k * KNN_APPROX_WINDOW_MULTIPLIER);
	const candidateNeighbors: Array<Set<number>> = projected.map(() => new Set<number>());

	const addEdge = (a: number, b: number): void => {
		if (a === b) return;
		const left = Math.min(a, b);
		const right = Math.max(a, b);
		const key = `${left}-${right}`;
		if (edgeSet.has(key)) return;
		edgeSet.add(key);
		result.push([left, right]);
	};

	const collectCandidates = (ordering: number[]): void => {
		for (let idx = 0; idx < ordering.length; idx++) {
			const source = ordering[idx];
			const candidates = candidateNeighbors[source];
			for (let offset = 1; offset <= windowSize; offset++) {
				const left = idx - offset;
				const right = idx + offset;
				if (left >= 0) candidates.add(ordering[left]);
				if (right < ordering.length) candidates.add(ordering[right]);
			}
		}
	};

	collectCandidates(byX);
	collectCandidates(byY);

	for (let source = 0; source < projected.length; source += 1) {
		const nearest: ScoredNeighbor[] = [];
		for (const candidate of candidateNeighbors[source]) {
			insertNearestNeighbor(
				nearest,
				{
					index: candidate,
					distance: squaredDistance(projected[source], projected[candidate]),
				},
				k,
			);
		}
		for (const neighbor of nearest) {
			addEdge(source, neighbor.index);
		}
	}

	return result;
}

function buildKnnEdges(projected: readonly number[][], k: number): [number, number][] {
	if (nativeKnn !== null) {
		const mutableCoords: number[][] = projected.map((p) => [...p]);
		const edges = nativeKnn.buildKnnEdges(mutableCoords, k, KNN_EXACT_THRESHOLD);
		return edges.map((e): [number, number] => [e[0], e[1]]);
	}
	if (projected.length <= KNN_EXACT_THRESHOLD) return buildExactKnnEdges(projected, k);
	return buildApproximateKnnEdges(projected, k);
}

export interface EmbeddingRow {
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

export function toEmbeddingRow(raw: Record<string, unknown>): EmbeddingRow | null {
	const { id, content, created_at, vector } = raw;
	if (typeof id !== "string" || typeof content !== "string" || typeof created_at !== "string" || !isBlob(vector)) {
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
		source_type: typeof raw.source_type === "string" ? raw.source_type : null,
		source_id: typeof raw.source_id === "string" ? raw.source_id : null,
		created_at,
		vector,
		dimensions: typeof raw.dimensions === "number" ? raw.dimensions : null,
	};
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

function projectionRandom(): () => number {
	let seed = 42;
	return () => {
		seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
		return seed / 4294967296;
	};
}

export function computeProjectionFromRows(rows: readonly EmbeddingRow[], nComponents: 2 | 3): ProjectionResult {
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

	const vectors = rows.map((row) => {
		const full = blobToVector(row.vector, row.dimensions);
		return full.length > UMAP_MAX_DIMENSIONS ? full.slice(0, UMAP_MAX_DIMENSIONS) : full;
	});
	const nNeighbors = Math.min(15, Math.max(2, vectors.length - 1));
	const umap = new UMAP({ nComponents, nNeighbors, minDist: 0.1, spread: 1.0, random: projectionRandom() });
	const projected: number[][] = umap.fit(vectors);

	let xs: number[];
	let ys: number[];
	let zs: number[] | null;
	if (nativeKnn !== null) {
		const rawXs = projected.map((point) => point[0]);
		const rawYs = projected.map((point) => point[1]);
		const rawZs = nComponents === 3 ? projected.map((point) => point[2] ?? 0) : null;
		const norm = nativeKnn.normaliseAxes(rawXs, rawYs, rawZs, SCALE);
		xs = norm.xs;
		ys = norm.ys;
		zs = norm.zs ?? null;
	} else {
		xs = normaliseAxis(projected.map((point) => point[0]));
		ys = normaliseAxis(projected.map((point) => point[1]));
		zs = nComponents === 3 ? normaliseAxis(projected.map((point) => point[2] ?? 0)) : null;
	}
	const nodes = buildNodesFromRows(rows, xs, ys, zs);
	const edges = buildKnnEdges(projected, KNN_K);

	return { nodes, edges };
}

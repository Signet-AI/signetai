/**
 * Pure functions and types for the embedding graph visualization.
 * No Svelte runtime dependencies -- safe to import anywhere.
 */

import type { EmbeddingPoint, EmbeddingsResponse } from "../../api";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const DEFAULT_EMBEDDING_LIMIT = 600;
export const MIN_EMBEDDING_LIMIT = 50;
export const MAX_EMBEDDING_LIMIT = 5000;
export const EMBEDDING_LIMIT_STORAGE_KEY = "signet-embedding-limit";
export const GRAPH_K = 4;
export const KNN_EXACT_THRESHOLD = 450;
export const KNN_APPROX_WINDOW_MULTIPLIER = 6;
export const RELATION_LIMIT = 10;
export const EMBEDDING_PAGE_PROBE_LIMIT = 24;
export const GRAPH_PHYSICS_STORAGE_KEY = "signet-embeddings-graph-physics";

export interface GraphPhysicsConfig {
	centerForce: number;
	repelForce: number;
	linkForce: number;
	linkDistance: number;
}

export const DEFAULT_GRAPH_PHYSICS: GraphPhysicsConfig = {
	centerForce: 0.28,
	repelForce: -260,
	linkForce: 0.12,
	linkDistance: 92,
};

export const sourceColors: Record<string, string> = {
	"claude-code": "#5eada4",
	clawdbot: "#a78bfa",
	daemon: "#22c55e",
	"signet-daemon": "#22c55e",
	openclaw: "#4ade80",
	opencode: "#60a5fa",
	manual: "#f472b6",
	unknown: "#737373",
};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type RelationKind = "similar" | "dissimilar";

export interface EmbeddingRelation {
	id: string;
	score: number;
	kind: RelationKind;
}

export interface RelationScore {
	id: string;
	score: number;
}

export interface RelationCacheEntry {
	similar: EmbeddingRelation[];
	dissimilar: EmbeddingRelation[];
}

export interface GraphNode {
	index?: number;
	x: number;
	y: number;
	vx?: number;
	vy?: number;
	fx?: number | null;
	fy?: number | null;
	radius: number;
	color: string;
	data: EmbeddingPoint;
}

export interface GraphEdge {
	source: GraphNode | number;
	target: GraphNode | number;
}

export function clampGraphPhysics(value: GraphPhysicsConfig): GraphPhysicsConfig {
	const clamp = (raw: number, min: number, max: number): number => Math.min(max, Math.max(min, raw));
	return {
		centerForce: clamp(value.centerForce, 0, 1),
		repelForce: clamp(value.repelForce, -600, -10),
		linkForce: clamp(value.linkForce, 0.01, 1),
		linkDistance: clamp(value.linkDistance, 12, 280),
	};
}

interface ScoredNeighbor {
	index: number;
	distance: number;
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

// ---------------------------------------------------------------------------
// Color helpers
// ---------------------------------------------------------------------------

export function hexToRgb(hex: string): [number, number, number] {
	const v = Number.parseInt(hex.slice(1), 16);
	return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}

export function sourceColorRgba(who: string | undefined, alpha: number): string {
	const [r, g, b] = hexToRgb(sourceColors[who ?? "unknown"] ?? sourceColors["unknown"]);
	return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

// ---------------------------------------------------------------------------
// Vector math
// ---------------------------------------------------------------------------

export function vectorNorm(vector: readonly number[]): number {
	let sum = 0;
	for (const value of vector) sum += value * value;
	return Math.sqrt(sum);
}

export function cosineSimilarity(
	left: readonly number[],
	right: readonly number[],
	leftNorm: number,
	rightNorm: number,
): number {
	if (leftNorm === 0 || rightNorm === 0 || left.length !== right.length) return 0;
	let dot = 0;
	for (let i = 0; i < left.length; i++) dot += left[i] * right[i];
	return dot / (leftNorm * rightNorm);
}

// ---------------------------------------------------------------------------
// Embedding accessors
// ---------------------------------------------------------------------------

export function hasEmbeddingVector(entry: EmbeddingPoint): entry is EmbeddingPoint & { vector: number[] } {
	return Array.isArray(entry.vector) && entry.vector.length > 0;
}

/** Cached norm lookup -- pass the mutable cache from the caller. */
export function embeddingNorm(embedding: EmbeddingPoint, cache: Map<string, number>): number {
	const cached = cache.get(embedding.id);
	if (typeof cached === "number") return cached;
	if (!hasEmbeddingVector(embedding)) return 0;
	const norm = vectorNorm(embedding.vector);
	cache.set(embedding.id, norm);
	return norm;
}

export function embeddingLabel(embedding: EmbeddingPoint): string {
	const text = embedding.content ?? embedding.text ?? "";
	return text.length > 160 ? `${text.slice(0, 160)}...` : text;
}

export function embeddingSourceLabel(embedding: EmbeddingPoint): string {
	const sourceType = embedding.sourceType ?? "memory";
	const sourceId = embedding.sourceId ?? embedding.id;
	return `${sourceType}:${sourceId}`;
}

// ---------------------------------------------------------------------------
// Relation scoring
// ---------------------------------------------------------------------------

export function insertTopScore(scores: RelationScore[], next: RelationScore): void {
	let index = 0;
	while (index < scores.length && scores[index].score >= next.score) index += 1;
	if (index >= RELATION_LIMIT) return;
	scores.splice(index, 0, next);
	if (scores.length > RELATION_LIMIT) scores.pop();
}

export function insertBottomScore(scores: RelationScore[], next: RelationScore): void {
	let index = 0;
	while (index < scores.length && scores[index].score <= next.score) index += 1;
	if (index >= RELATION_LIMIT) return;
	scores.splice(index, 0, next);
	if (scores.length > RELATION_LIMIT) scores.pop();
}

// ---------------------------------------------------------------------------
// KNN edge construction
// ---------------------------------------------------------------------------

export function buildExactKnnEdges(projected: number[][], k: number): [number, number][] {
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

export function buildApproximateKnnEdges(projected: number[][], k: number): [number, number][] {
	const edgeSet = new Set<string>();
	const result: [number, number][] = [];
	if (projected.length <= 2) return result;

	const ids = projected.map((_, index) => index);
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

export function buildKnnEdges(projected: number[][], k: number): [number, number][] {
	if (projected.length <= KNN_EXACT_THRESHOLD) return buildExactKnnEdges(projected, k);
	return buildApproximateKnnEdges(projected, k);
}

// ---------------------------------------------------------------------------
// Embedding limit & merge helpers
// ---------------------------------------------------------------------------

export function clampEmbeddingLimit(value: number): number {
	return Math.min(MAX_EMBEDDING_LIMIT, Math.max(MIN_EMBEDDING_LIMIT, value));
}

export function mergeUniqueEmbeddings(
	target: EmbeddingPoint[],
	seen: Set<string>,
	incoming: readonly EmbeddingPoint[],
): number {
	let added = 0;
	for (const item of incoming) {
		if (seen.has(item.id)) continue;
		seen.add(item.id);
		target.push(item);
		added += 1;
	}
	return added;
}

export function buildEmbeddingsResponse(
	requestedLimit: number,
	embs: EmbeddingPoint[],
	total: number,
	hasMore: boolean,
	error?: string,
): EmbeddingsResponse {
	const normalizedTotal = total > 0 ? total : embs.length;
	return {
		embeddings: embs,
		count: embs.length,
		total: normalizedTotal,
		limit: requestedLimit,
		offset: 0,
		hasMore: hasMore || normalizedTotal > embs.length,
		error,
	};
}

// ---------------------------------------------------------------------------
// Styling helpers for canvas rendering
// ---------------------------------------------------------------------------

/** Determine node fill given current selection, filter, and relation state. */
export function nodeFillStyle(
	node: GraphNode,
	selectedId: string | null,
	filterIds: Set<string> | null,
	relations: Map<string, RelationKind>,
	pinnedIds: Set<string>,
	lensIds: Set<string>,
	lensActive: boolean,
): string {
	const id = node.data.id;
	const relation = relations.get(id) ?? null;
	const dimmed = filterIds !== null && !filterIds.has(id);
	const isPinned = pinnedIds.has(id);
	const outsideLens = lensActive && !lensIds.has(id);

	if (selectedId === id) return "rgba(255, 255, 255, 0.95)";
	if (outsideLens) return dimmed ? "rgba(80, 80, 80, 0.08)" : "rgba(95, 95, 95, 0.15)";
	if (relation === "similar") return dimmed ? "rgba(129, 180, 255, 0.35)" : "rgba(129, 180, 255, 0.9)";
	if (relation === "dissimilar") return dimmed ? "rgba(255, 146, 146, 0.35)" : "rgba(255, 146, 146, 0.9)";
	if (isPinned) return dimmed ? "rgba(220, 220, 220, 0.42)" : "rgba(235, 235, 235, 0.95)";
	if (dimmed) return "rgba(120, 120, 120, 0.2)";
	return sourceColorRgba(node.data.who, 0.85);
}

/** Determine edge stroke given filter and relation state. */
export function edgeStrokeStyle(
	sourceId: string,
	targetId: string,
	filterIds: Set<string> | null,
	relations: Map<string, RelationKind>,
	lensIds: Set<string>,
	lensActive: boolean,
): string {
	const sourceDimmed = filterIds !== null && !filterIds.has(sourceId);
	const targetDimmed = filterIds !== null && !filterIds.has(targetId);
	if (sourceDimmed || targetDimmed) return "rgba(120, 120, 120, 0.12)";
	if (lensActive) {
		const sourceInLens = lensIds.has(sourceId);
		const targetInLens = lensIds.has(targetId);
		if (sourceInLens && targetInLens) return "rgba(220, 220, 220, 0.72)";
		return "rgba(90, 90, 90, 0.08)";
	}
	if (relations.get(sourceId) || relations.get(targetId)) return "rgba(200, 200, 200, 0.6)";
	return "rgba(180, 180, 180, 0.4)";
}

/** Node color for the 3D graph renderer. */
export function nodeColor3D(
	id: string,
	who: string,
	selectedId: string | null,
	filterIds: Set<string> | null,
	relations: Map<string, RelationKind>,
	pinnedIds: Set<string>,
	lensIds: Set<string>,
	lensActive: boolean,
): string {
	if (selectedId === id) return "#ffffff";
	if (lensActive && !lensIds.has(id)) return "#3b3b3b";
	const relation = relations.get(id) ?? null;
	if (relation === "similar") return "#81b4ff";
	if (relation === "dissimilar") return "#ff9292";
	if (pinnedIds.has(id)) return "#e5e7eb";
	const dimmed = filterIds !== null && !filterIds.has(id);
	if (dimmed) return "#5b5b5b";
	return sourceColors[who] ?? sourceColors["unknown"];
}

export function edgeColor3D(
	sourceId: string,
	targetId: string,
	filterIds: Set<string> | null,
	lensIds: Set<string>,
	lensActive: boolean,
): string {
	const sourceDimmed = filterIds !== null && !filterIds.has(sourceId);
	const targetDimmed = filterIds !== null && !filterIds.has(targetId);
	if (sourceDimmed || targetDimmed) return "rgba(95,95,95,0.18)";
	if (lensActive) {
		const sourceInLens = lensIds.has(sourceId);
		const targetInLens = lensIds.has(targetId);
		if (sourceInLens && targetInLens) return "rgba(210,210,210,0.72)";
		return "rgba(85,85,85,0.08)";
	}
	return "rgba(160,160,160,0.5)";
}

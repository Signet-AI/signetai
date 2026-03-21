/**
 * Pure functions and types for the embedding graph visualization.
 * No Svelte runtime dependencies -- safe to import anywhere.
 */

import type {
	ConstellationAspect,
	ConstellationAttribute,
	ConstellationEntity,
	EmbeddingPoint,
	EmbeddingsResponse,
} from "../../api";

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
	openclaw: "#facc15",
	"openclaw-memory": "#facc15",
	opencode: "#60a5fa",
	user: "#ef4444",
	manual: "#f472b6",
	unknown: "#737373",
};

const NEWNESS_HOUR_MS = 60 * 60 * 1000;
const NEWNESS_DAY_MS = 24 * NEWNESS_HOUR_MS;
const NEWNESS_WEEK_MS = 7 * NEWNESS_DAY_MS;
const NEWNESS_MINUTES_MS = 15 * 60 * 1000;
const NEWNESS_HOURS_MS = 6 * NEWNESS_HOUR_MS;

type NewnessBucket = "minutes" | "hours" | "week" | "older";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type RelationKind = "similar" | "dissimilar";

export type NodeColorMode = "source" | "newness" | "none";

export type NodeType = "memory" | "entity" | "aspect" | "attribute";
export type EdgeType = "knn" | "hierarchy" | "dependency";

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
	nodeType?: NodeType;
	entityData?: ConstellationEntity;
	aspectData?: ConstellationAspect;
	attributeData?: ConstellationAttribute;
	parentEntityId?: string;
	parentAspectId?: string;
}

export interface GraphEdge {
	source: GraphNode | number;
	target: GraphNode | number;
	edgeType?: EdgeType;
	dependencyType?: string;
	strength?: number;
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

function parseCreatedAtMs(createdAt: string | undefined): number | null {
	if (!createdAt) return null;
	const parsed = new Date(createdAt).getTime();
	if (Number.isNaN(parsed)) return null;
	return parsed;
}

export function newnessIntensity(createdAt: string | undefined, nowMs: number): number {
	const createdMs = parseCreatedAtMs(createdAt);
	if (createdMs === null) return 0.22;
	const ageMs = Math.max(0, nowMs - createdMs);
	if (ageMs <= NEWNESS_MINUTES_MS) return 1;
	if (ageMs <= NEWNESS_HOURS_MS) return 0.76;
	if (ageMs <= NEWNESS_WEEK_MS) return 0.52;
	return 0.22;
}

function newnessBucketFromIntensity(intensity: number): NewnessBucket {
	if (intensity >= 0.95) return "minutes";
	if (intensity >= 0.7) return "hours";
	if (intensity >= 0.45) return "week";
	return "older";
}

export function newnessBucket(createdAt: string | undefined, nowMs: number): NewnessBucket {
	return newnessBucketFromIntensity(newnessIntensity(createdAt, nowMs));
}

export function newnessFillStyle(intensity: number, alpha: number): string {
	const bucket = newnessBucketFromIntensity(intensity);
	if (bucket === "minutes") return `rgba(255, 176, 74, ${alpha})`;
	if (bucket === "hours") return `rgba(168, 34, 98, ${alpha})`;
	if (bucket === "week") return `rgba(76, 34, 122, ${alpha})`;
	return `rgba(118, 111, 102, ${alpha})`;
}

export function isNewSinceLastSeen(createdAt: string | undefined, lastSeenMs: number | null): boolean {
	if (lastSeenMs === null) return false;
	const createdMs = parseCreatedAtMs(createdAt);
	if (createdMs === null) return false;
	return createdMs > lastSeenMs;
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
	colorMode: NodeColorMode,
	nowMs: number,
	sourceFocusSources: Set<string> | null,
): string {
	const id = node.data.id;
	const relation = relations.get(id) ?? null;
	const dimmed = filterIds !== null && !filterIds.has(id);
	const isPinned = pinnedIds.has(id);
	const outsideLens = lensActive && !lensIds.has(id);

	if (selectedId === id) return "rgba(255, 255, 255, 0.95)";
	if (outsideLens) return dimmed ? "rgba(80, 80, 80, 0.08)" : "rgba(95, 95, 95, 0.15)";
	if (relation === "similar") {
		if (colorMode === "none") return dimmed ? "rgba(160, 170, 185, 0.3)" : "rgba(198, 210, 228, 0.84)";
		return dimmed ? "rgba(129, 180, 255, 0.35)" : "rgba(129, 180, 255, 0.9)";
	}
	if (relation === "dissimilar") {
		if (colorMode === "none") return dimmed ? "rgba(165, 150, 150, 0.28)" : "rgba(208, 190, 190, 0.8)";
		return dimmed ? "rgba(255, 146, 146, 0.35)" : "rgba(255, 146, 146, 0.9)";
	}
	if (isPinned) return dimmed ? "rgba(220, 220, 220, 0.42)" : "rgba(235, 235, 235, 0.95)";
	if (dimmed) return "rgba(120, 120, 120, 0.2)";
	if (colorMode === "none") return "rgba(168, 168, 168, 0.82)";
	if (colorMode === "newness") {
		if (newnessBucket(node.data.createdAt, nowMs) === "older") {
			const source = node.data.who ?? "unknown";
			if (sourceFocusSources !== null && sourceFocusSources.has(source)) {
				return sourceColorRgba(source, 0.85);
			}
		}
		const intensity = newnessIntensity(node.data.createdAt, nowMs);
		return newnessFillStyle(intensity, 0.9);
	}
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
	createdAt: string | undefined,
	selectedId: string | null,
	filterIds: Set<string> | null,
	relations: Map<string, RelationKind>,
	pinnedIds: Set<string>,
	lensIds: Set<string>,
	lensActive: boolean,
	colorMode: NodeColorMode,
	nowMs: number,
	showNewSinceLastSeen: boolean,
	lastSeenMs: number | null,
	sourceFocusSources: Set<string> | null,
): string {
	const noColorMode = colorMode === "none";
	if (selectedId === id) return "#ffffff";
	if (lensActive && !lensIds.has(id)) return "#3b3b3b";
	const relation = relations.get(id) ?? null;
	if (relation === "similar") return noColorMode ? "#c6d2e4" : "#81b4ff";
	if (relation === "dissimilar") return noColorMode ? "#cfbcbc" : "#ff9292";
	if (pinnedIds.has(id)) return "#e5e7eb";
	const dimmed = filterIds !== null && !filterIds.has(id);
	if (dimmed) return "#5b5b5b";
	if (!noColorMode && showNewSinceLastSeen && isNewSinceLastSeen(createdAt, lastSeenMs)) return "#f6c26b";
	if (noColorMode) return "#a8a8a8";
	if (colorMode === "newness") {
		if (newnessBucket(createdAt, nowMs) === "older") {
			if (sourceFocusSources !== null && sourceFocusSources.has(who)) {
				return sourceColors[who] ?? sourceColors["unknown"];
			}
		}
		return newnessFillStyle(newnessIntensity(createdAt, nowMs), 1);
	}
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

// ---------------------------------------------------------------------------
// Entity overlay helpers
// ---------------------------------------------------------------------------

export const entityTypeColors: Record<string, string> = {
	person: "#eab308",
	project: "#06b6d4",
	system: "#a855f7",
	tool: "#10b981",
	concept: "#f43f5e",
	skill: "#f59e0b",
	task: "#64748b",
	unknown: "#737373",
};

export function entityTypeColor(entityType: string): string {
	return entityTypeColors[entityType.toLowerCase()] ?? entityTypeColors["unknown"];
}

export function entityMass(entity: ConstellationEntity): number {
	const density = Math.min(
		entity.aspects.length + entity.aspects.reduce((sum, a) => sum + a.attributes.length * 0.5, 0),
		40,
	);
	return 6 + density * 0.35;
}

export function entityFillStyle(entityType: string, alpha: number): string {
	const hex = entityTypeColor(entityType);
	const [r, g, b] = hexToRgb(hex);
	return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

export function dependencyEdgeStyle(depType: string, strength: number): {
	color: string;
	width: number;
	dash: number[];
} {
	const w = 0.8 + strength * 1.2;
	switch (depType) {
		case "uses":
		case "requires":
			return { color: "rgba(180, 180, 200, 0.35)", width: w, dash: [] };
		case "owned_by":
			return { color: "rgba(160, 160, 180, 0.25)", width: w + 0.4, dash: [] };
		case "blocks":
			return { color: "rgba(220, 100, 100, 0.4)", width: w, dash: [4, 3] };
		case "informs":
			return { color: "rgba(100, 160, 220, 0.35)", width: w, dash: [2, 3] };
		default:
			return { color: "rgba(150, 150, 160, 0.3)", width: w, dash: [] };
	}
}

/** Compute aspect node radius from weight (5-8px range). */
export function aspectRadius(weight: number): number {
	return 5 + Math.min(weight, 1) * 3;
}

/** Compute attribute node radius from importance (3-4px range). */
export function attributeRadius(importance: number): number {
	return 3 + Math.min(importance, 1);
}

/** Compute entity node radius from density (10-22px range). */
export function entityRadius(entity: ConstellationEntity): number {
	const density = entity.aspects.length +
		entity.aspects.reduce((sum, a) => sum + a.attributes.length * 0.5, 0);
	return 10 + Math.min(density, 24) * 0.5;
}

/** Charge strength per node type for force simulation. */
export function tierChargeStrength(nodeType: NodeType | undefined): number {
	switch (nodeType) {
		case "entity": return -200;
		case "aspect": return -40;
		case "attribute": return -15;
		case "memory": return -5;
		default: return -5;
	}
}

/** Draw a hexagonal path centered at (x, y) with given radius. */
export function hexPath(ctx: CanvasRenderingContext2D, x: number, y: number, r: number): void {
	ctx.beginPath();
	for (let i = 0; i < 6; i++) {
		const angle = (Math.PI / 3) * i - Math.PI / 6;
		const px = x + r * Math.cos(angle);
		const py = y + r * Math.sin(angle);
		if (i === 0) ctx.moveTo(px, py);
		else ctx.lineTo(px, py);
	}
	ctx.closePath();
}

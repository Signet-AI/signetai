<script lang="ts">
	import { tick, onMount } from "svelte";
	import { browser } from "$app/environment";
	import { UMAP } from "umap-js";
	import {
		forceSimulation,
		forceLink,
		forceManyBody,
		forceCenter,
		forceCollide,
	} from "d3-force";
	import {
		getEmbeddings,
		getSimilarMemories,
		type Memory,
		type EmbeddingPoint,
		type EmbeddingsResponse,
	} from "$lib/api";
	import { mem } from "$lib/stores/memory.svelte";

	interface Props {
		onopenglobalsimilar: (memory: Memory) => void;
	}

	let { onopenglobalsimilar }: Props = $props();

	const DEFAULT_EMBEDDING_LIMIT = 600;
	const MIN_EMBEDDING_LIMIT = 50;
	const MAX_EMBEDDING_LIMIT = 5000;
	const EMBEDDING_LIMIT_STORAGE_KEY = "signet-embedding-limit";
	const GRAPH_K = 4;
	const RELATION_LIMIT = 10;
	const EMBEDDING_PAGE_PROBE_LIMIT = 24;

	let canvas = $state<HTMLCanvasElement | null>(null);
	let graphSelected = $state<EmbeddingPoint | null>(null);
	let graphHovered = $state<EmbeddingPoint | null>(null);
	let graphStatus = $state("");
	let graphError = $state("");
	let embeddings = $state<EmbeddingPoint[]>([]);
	let embeddingsTotal = $state(0);
	let embeddingsHasMore = $state(false);
	let graphInitialized = $state(false);
	let embeddingLimit = $state(DEFAULT_EMBEDDING_LIMIT);
	let embeddingLimitInput = $state(String(DEFAULT_EMBEDDING_LIMIT));
	let embeddingSearch = $state("");
	let embeddingSearchMatches = $state<EmbeddingPoint[]>([]);
	let embeddingFilterIds = $state<Set<string> | null>(null);

	type RelationKind = "similar" | "dissimilar";

	interface EmbeddingRelation {
		id: string;
		score: number;
		kind: RelationKind;
	}

	interface RelationScore {
		id: string;
		score: number;
	}

	interface RelationCacheEntry {
		similar: EmbeddingRelation[];
		dissimilar: EmbeddingRelation[];
	}

	let relationMode = $state<RelationKind>("similar");
	let similarNeighbors = $state<EmbeddingRelation[]>([]);
	let dissimilarNeighbors = $state<EmbeddingRelation[]>([]);
	let activeNeighbors = $state<EmbeddingRelation[]>([]);
	let loadingGlobalSimilar = $state(false);
	let globalSimilar = $state<Memory[]>([]);

	const sourceColors: Record<string, string> = {
		"claude-code": "#5eada4",
		clawdbot: "#a78bfa",
		openclaw: "#4ade80",
		opencode: "#60a5fa",
		manual: "#f472b6",
		unknown: "#737373",
	};

	interface GraphNode {
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

	interface GraphEdge {
		source: GraphNode | number;
		target: GraphNode | number;
	}

	let camX = 0, camY = 0, camZoom = 1;
	let isPanning = false, isDragging = false;
	let dragNode: GraphNode | null = null;
	let panStartX = 0, panStartY = 0;
	let panCamStartX = 0, panCamStartY = 0;

	let nodes = $state<GraphNode[]>([]);
	let edges = $state<GraphEdge[]>([]);
	let simulation: ReturnType<typeof forceSimulation> | null = null;
	let animFrame = 0;

	let graphMode: "2d" | "3d" = $state("2d");
	let graph3d: any = null;
	let graph3dContainer = $state<HTMLDivElement | null>(null);

	let projected3dCache: number[][] | null = null;
	let graphLoadId = 0;
	let interactionCleanup: (() => void) | null = null;
	let resizeListenerAttached = false;
	let embeddingById = new Map<string, EmbeddingPoint>();
	let embeddingNormById = new Map<string, number>();
	let relationLookup = new Map<string, RelationKind>();
	let relationCache = new Map<string, RelationCacheEntry>();

	if (browser) {
		let nextLimit = DEFAULT_EMBEDDING_LIMIT;
		const storedLimit = Number.parseInt(
			localStorage.getItem(EMBEDDING_LIMIT_STORAGE_KEY) ?? "",
			10,
		);
		if (Number.isFinite(storedLimit)) {
			nextLimit = Math.min(
				MAX_EMBEDDING_LIMIT,
				Math.max(MIN_EMBEDDING_LIMIT, storedLimit),
			);
		}
		embeddingLimit = nextLimit;
		embeddingLimitInput = String(nextLimit);
	}

	function hasEmbeddingVector(
		entry: EmbeddingPoint,
	): entry is EmbeddingPoint & { vector: number[] } {
		return Array.isArray(entry.vector) && entry.vector.length > 0;
	}

	function hexToRgb(hex: string): [number, number, number] {
		const v = parseInt(hex.slice(1), 16);
		return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
	}

	function sourceColorRgba(who: string | undefined, alpha: number): string {
		const [r, g, b] = hexToRgb(sourceColors[who ?? "unknown"] ?? sourceColors["unknown"]);
		return `rgba(${r}, ${g}, ${b}, ${alpha})`;
	}

	function clampEmbeddingLimit(value: number): number {
		return Math.min(MAX_EMBEDDING_LIMIT, Math.max(MIN_EMBEDDING_LIMIT, value));
	}

	function applyEmbeddingLimit() {
		const parsed = Number.parseInt(embeddingLimitInput, 10);
		const next = clampEmbeddingLimit(Number.isFinite(parsed) ? parsed : embeddingLimit);
		embeddingLimit = next;
		embeddingLimitInput = String(next);
		if (browser) {
			localStorage.setItem(EMBEDDING_LIMIT_STORAGE_KEY, String(next));
		}
		reloadEmbeddingsGraph();
	}

	function clearEmbeddingSelection() {
		graphSelected = null;
		graphHovered = null;
		globalSimilar = [];
	}

	function mergeUniqueEmbeddings(
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

	function buildEmbeddingsResponse(
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

	async function loadEmbeddingsForGraph(limit: number): Promise<EmbeddingsResponse> {
		const requestedLimit = clampEmbeddingLimit(limit);
		const firstPage = await getEmbeddings(true, { limit: requestedLimit, offset: 0 });

		if (firstPage.error) return firstPage;

		const merged: EmbeddingPoint[] = [];
		const seen = new Set<string>();
		mergeUniqueEmbeddings(merged, seen, firstPage.embeddings ?? []);

		let total = firstPage.total > 0 ? firstPage.total : merged.length;
		let hasMore = firstPage.hasMore || total > merged.length;

		if (merged.length >= requestedLimit) {
			return buildEmbeddingsResponse(requestedLimit, merged.slice(0, requestedLimit), total, hasMore);
		}

		let offset = merged.length;
		let probeCount = 0;
		let shouldProbeForMore = requestedLimit > merged.length && merged.length > 0;

		while (
			merged.length < requestedLimit &&
			probeCount < EMBEDDING_PAGE_PROBE_LIMIT &&
			(hasMore || shouldProbeForMore)
		) {
			const remaining = requestedLimit - merged.length;
			const page = await getEmbeddings(true, { limit: remaining, offset });

			if (page.error) {
				return buildEmbeddingsResponse(requestedLimit, merged, total, hasMore, page.error);
			}

			const rows = page.embeddings ?? [];
			const added = mergeUniqueEmbeddings(merged, seen, rows);

			if (page.total > total) total = page.total;
			hasMore = page.hasMore || total > merged.length;

			if (rows.length === 0 || added === 0) break;

			offset += rows.length;
			shouldProbeForMore = !hasMore && merged.length < requestedLimit;
			probeCount += 1;
		}

		return buildEmbeddingsResponse(requestedLimit, merged.slice(0, requestedLimit), total, hasMore);
	}

	function embeddingLabel(embedding: EmbeddingPoint): string {
		const text = embedding.content ?? embedding.text ?? "";
		return text.length > 160 ? `${text.slice(0, 160)}...` : text;
	}

	function embeddingSourceLabel(embedding: EmbeddingPoint): string {
		const sourceType = embedding.sourceType ?? "memory";
		const sourceId = embedding.sourceId ?? embedding.id;
		return `${sourceType}:${sourceId}`;
	}

	function getEmbeddingById(id: string): EmbeddingPoint | null {
		return embeddingById.get(id) ?? null;
	}

	function selectEmbeddingById(id: string, center = true) {
		const next = getEmbeddingById(id);
		if (!next) return;
		graphSelected = next;
		if (center) focusEmbedding(id);
	}

	function focusEmbedding(id: string) {
		if (graphMode === "2d") {
			const node = nodes.find((entry) => entry.data.id === id);
			if (!node) return;
			camX = node.x;
			camY = node.y;
			camZoom = Math.max(camZoom, 1.6);
			return;
		}
		focusEmbedding3D(id);
	}

	function focusEmbedding3D(id: string) {
		if (!graph3d) return;
		const graphData = graph3d.graphData?.();
		if (!graphData?.nodes) return;
		const node = graphData.nodes.find((entry: any) => String(entry.id) === id);
		if (!node) return;
		const distance = 120;
		const len = Math.hypot(node.x ?? 0, node.y ?? 0, node.z ?? 0) || 1;
		const ratio = 1 + distance / len;
		graph3d.cameraPosition(
			{
				x: (node.x ?? 0) * ratio,
				y: (node.y ?? 0) * ratio,
				z: (node.z ?? 0) * ratio,
			},
			node,
			900,
		);
	}

	function vectorNorm(vector: readonly number[]): number {
		let sum = 0;
		for (const value of vector) sum += value * value;
		return Math.sqrt(sum);
	}

	function embeddingNorm(embedding: EmbeddingPoint): number {
		const cached = embeddingNormById.get(embedding.id);
		if (typeof cached === "number") return cached;
		if (!hasEmbeddingVector(embedding)) return 0;
		const norm = vectorNorm(embedding.vector);
		embeddingNormById.set(embedding.id, norm);
		return norm;
	}

	function cosineSimilarity(
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

	function insertTopScore(scores: RelationScore[], next: RelationScore) {
		let index = 0;
		while (index < scores.length && scores[index].score >= next.score) index += 1;
		if (index >= RELATION_LIMIT) return;
		scores.splice(index, 0, next);
		if (scores.length > RELATION_LIMIT) scores.pop();
	}

	function insertBottomScore(scores: RelationScore[], next: RelationScore) {
		let index = 0;
		while (index < scores.length && scores[index].score <= next.score) index += 1;
		if (index >= RELATION_LIMIT) return;
		scores.splice(index, 0, next);
		if (scores.length > RELATION_LIMIT) scores.pop();
	}

	function computeRelationsForSelection(selected: EmbeddingPoint | null) {
		if (!selected || !hasEmbeddingVector(selected)) {
			similarNeighbors = [];
			dissimilarNeighbors = [];
			activeNeighbors = [];
			relationLookup = new Map();
			return;
		}

		const cached = relationCache.get(selected.id);
		if (cached) {
			similarNeighbors = cached.similar;
			dissimilarNeighbors = cached.dissimilar;
			activeNeighbors = relationMode === "similar" ? cached.similar : cached.dissimilar;
			relationLookup = new Map(activeNeighbors.map((item) => [item.id, item.kind]));
			return;
		}

		const selectedNorm = embeddingNorm(selected);
		const similarScores: RelationScore[] = [];
		const dissimilarScores: RelationScore[] = [];

		for (const candidate of embeddings) {
			if (candidate.id === selected.id || !hasEmbeddingVector(candidate)) continue;
			const score = cosineSimilarity(
				selected.vector,
				candidate.vector,
				selectedNorm,
				embeddingNorm(candidate),
			);
			if (Number.isFinite(score)) {
				const relation = { id: candidate.id, score };
				insertTopScore(similarScores, relation);
				insertBottomScore(dissimilarScores, relation);
			}
		}

		if (similarScores.length === 0) {
			similarNeighbors = [];
			dissimilarNeighbors = [];
			activeNeighbors = [];
			relationLookup = new Map();
			return;
		}

		similarNeighbors = similarScores.map((item) => ({ ...item, kind: "similar" as const }));
		dissimilarNeighbors = dissimilarScores.map((item) => ({ ...item, kind: "dissimilar" as const }));
		relationCache.set(selected.id, { similar: similarNeighbors, dissimilar: dissimilarNeighbors });

		activeNeighbors = relationMode === "similar" ? similarNeighbors : dissimilarNeighbors;
		relationLookup = new Map(activeNeighbors.map((item) => [item.id, item.kind]));
	}

	function isFilteredOut(id: string): boolean {
		if (!embeddingFilterIds) return false;
		return !embeddingFilterIds.has(id);
	}

	function relationFor(id: string): RelationKind | null {
		return relationLookup.get(id) ?? null;
	}

	function nodeFillStyle(node: GraphNode): string {
		const id = node.data.id;
		const relation = relationFor(id);
		const dimmed = isFilteredOut(id);
		if (graphSelected?.id === id) return "rgba(255, 255, 255, 0.95)";
		if (relation === "similar") return dimmed ? "rgba(129, 180, 255, 0.35)" : "rgba(129, 180, 255, 0.9)";
		if (relation === "dissimilar") return dimmed ? "rgba(255, 146, 146, 0.35)" : "rgba(255, 146, 146, 0.9)";
		if (dimmed) return "rgba(120, 120, 120, 0.2)";
		return sourceColorRgba(node.data.who, 0.85);
	}

	function edgeStrokeStyle(sourceId: string, targetId: string): string {
		const sourceDimmed = isFilteredOut(sourceId);
		const targetDimmed = isFilteredOut(targetId);
		if (sourceDimmed || targetDimmed) return "rgba(120, 120, 120, 0.12)";
		if (relationFor(sourceId) || relationFor(targetId)) return "rgba(200, 200, 200, 0.6)";
		return "rgba(180, 180, 180, 0.4)";
	}

	function nodeColor3D(id: string, who: string): string {
		if (graphSelected?.id === id) return "#ffffff";
		const relation = relationFor(id);
		if (relation === "similar") return "#81b4ff";
		if (relation === "dissimilar") return "#ff9292";
		if (isFilteredOut(id)) return "#5b5b5b";
		return sourceColors[who] ?? sourceColors["unknown"];
	}

	function refresh3DAppearance() {
		if (!graph3d) return;
		graph3d.nodeColor((node: any) =>
			nodeColor3D(String(node.id), String(node.who ?? "unknown")),
		);
		graph3d.refresh?.();
	}

	function buildExactKnnEdges(projected: number[][], k: number): [number, number][] {
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

	function buildApproximateKnnEdges(projected: number[][], k: number): [number, number][] {
		const edgeSet = new Set<string>();
		const result: [number, number][] = [];
		const ids = projected.map((_, index) => index);
		const byX = [...ids].sort((a, b) => projected[a][0] - projected[b][0]);
		const byY = [...ids].sort((a, b) => projected[a][1] - projected[b][1]);
		const windowSize = Math.max(2, k * 3);

		const addEdge = (a: number, b: number) => {
			if (a === b) return;
			const left = Math.min(a, b);
			const right = Math.max(a, b);
			const key = `${left}-${right}`;
			if (edgeSet.has(key)) return;
			edgeSet.add(key);
			result.push([left, right]);
		};

		const addFromOrdering = (ordering: number[]) => {
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

	function buildKnnEdges(projected: number[][], k: number): [number, number][] {
		if (projected.length <= 450) return buildExactKnnEdges(projected, k);
		return buildApproximateKnnEdges(projected, k);
	}

	function screenToWorld(sx: number, sy: number): [number, number] {
		if (!canvas) return [0, 0];
		const rect = canvas.getBoundingClientRect();
		const cx = rect.width / 2;
		const cy = rect.height / 2;
		return [
			(sx - rect.left - cx) / camZoom + camX,
			(sy - rect.top - cy) / camZoom + camY,
		];
	}

	function findNodeAt(wx: number, wy: number): GraphNode | null {
		for (let i = nodes.length - 1; i >= 0; i--) {
			const n = nodes[i];
			const dx = n.x - wx;
			const dy = n.y - wy;
			const hitR = n.radius + 4;
			if (dx * dx + dy * dy <= hitR * hitR) return n;
		}
		return null;
	}

	function draw(ctx: CanvasRenderingContext2D) {
		if (!canvas) return;
		const w = canvas.width;
		const h = canvas.height;
		ctx.fillStyle = "#050505";
		ctx.fillRect(0, 0, w, h);
		ctx.save();
		ctx.translate(w / 2, h / 2);
		ctx.scale(camZoom, camZoom);
		ctx.translate(-camX, -camY);

		for (const edge of edges) {
			const s = edge.source as GraphNode;
			const t = edge.target as GraphNode;
			ctx.beginPath();
			ctx.moveTo(s.x, s.y);
			ctx.lineTo(t.x, t.y);
			ctx.strokeStyle = edgeStrokeStyle(s.data.id, t.data.id);
			ctx.lineWidth = 0.8 / camZoom;
			ctx.stroke();
		}

		for (const node of nodes) {
			ctx.beginPath();
			ctx.arc(node.x, node.y, node.radius, 0, Math.PI * 2);
			ctx.fillStyle = nodeFillStyle(node);
			ctx.fill();

			if (graphSelected && node.data.id === graphSelected.id) {
				ctx.beginPath();
				ctx.arc(node.x, node.y, node.radius + 3, 0, Math.PI * 2);
				ctx.strokeStyle = "rgba(255, 255, 255, 0.95)";
				ctx.lineWidth = 1.5 / camZoom;
				ctx.stroke();
			}
		}

		if (graphHovered) {
			const node = nodes.find((entry) => entry.data.id === graphHovered?.id);
			if (node) {
				const text = embeddingLabel(graphHovered);
				const fs = 9 / camZoom;
				ctx.font = `${fs}px var(--font-mono)`;
				ctx.fillStyle = "rgba(220, 220, 220, 0.9)";
				ctx.textAlign = "left";
				ctx.fillText(text, node.x + node.radius + 5 / camZoom, node.y + fs * 0.35);
				ctx.textAlign = "start";
			}
		}

		ctx.restore();

		const legendSources = ["claude-code", "clawdbot", "openclaw", "opencode", "manual"];
		const lx = 12;
		let ly = h - 12 - legendSources.length * 16;
		ctx.font = "10px var(--font-mono)";
		for (const name of legendSources) {
			const [r, g, b] = hexToRgb(sourceColors[name] ?? sourceColors["unknown"]);
			ctx.beginPath();
			ctx.arc(lx + 3, ly, 3, 0, Math.PI * 2);
			ctx.fillStyle = `rgba(${r}, ${g}, ${b}, 0.8)`;
			ctx.fill();
			ctx.fillStyle = "rgba(200, 200, 200, 0.4)";
			ctx.fillText(name, lx + 12, ly + 3);
			ly += 16;
		}

		animFrame = requestAnimationFrame(() => draw(ctx));
	}

	function setupInteractions() {
		if (!canvas) return;
		if (interactionCleanup) {
			interactionCleanup();
			interactionCleanup = null;
		}

		const target = canvas;

		const onPointerDown = (event: PointerEvent) => {
			const [wx, wy] = screenToWorld(event.clientX, event.clientY);
			const node = findNodeAt(wx, wy);
			if (node) {
				isDragging = true;
				dragNode = node;
				node.fx = node.x;
				node.fy = node.y;
				(simulation as any)?.alphaTarget(0.3).restart();
			} else {
				isPanning = true;
				panStartX = event.clientX;
				panStartY = event.clientY;
				panCamStartX = camX;
				panCamStartY = camY;
			}
		};

		const onPointerMove = (event: PointerEvent) => {
			if (isDragging && dragNode) {
				const [wx, wy] = screenToWorld(event.clientX, event.clientY);
				dragNode.fx = wx;
				dragNode.fy = wy;
				return;
			}
			if (isPanning) {
				camX = panCamStartX - (event.clientX - panStartX) / camZoom;
				camY = panCamStartY - (event.clientY - panStartY) / camZoom;
				return;
			}
			const [wx, wy] = screenToWorld(event.clientX, event.clientY);
			const node = findNodeAt(wx, wy);
			graphHovered = node?.data ?? null;
			target.style.cursor = node ? "pointer" : "grab";
		};

		const onPointerUp = () => {
			if (isDragging && dragNode) {
				dragNode.fx = null;
				dragNode.fy = null;
				(simulation as any)?.alphaTarget(0);
				dragNode = null;
				isDragging = false;
				return;
			}
			isPanning = false;
		};

		const onClick = (event: MouseEvent) => {
			if (isDragging) return;
			const [wx, wy] = screenToWorld(event.clientX, event.clientY);
			const node = findNodeAt(wx, wy);
			graphSelected = node?.data ?? null;
		};

		const onWheel = (event: WheelEvent) => {
			event.preventDefault();
			const factor = event.deltaY > 0 ? 0.9 : 1.1;
			const newZoom = Math.max(0.1, Math.min(5, camZoom * factor));
			const rect = target.getBoundingClientRect();
			const cx = rect.width / 2;
			const cy = rect.height / 2;
			const mx = event.clientX - rect.left - cx;
			const my = event.clientY - rect.top - cy;
			const wx = mx / camZoom + camX;
			const wy = my / camZoom + camY;
			camZoom = newZoom;
			camX = wx - mx / camZoom;
			camY = wy - my / camZoom;
		};

		target.addEventListener("pointerdown", onPointerDown);
		target.addEventListener("pointermove", onPointerMove);
		target.addEventListener("pointerup", onPointerUp);
		target.addEventListener("pointerleave", onPointerUp);
		target.addEventListener("click", onClick);
		target.addEventListener("wheel", onWheel, { passive: false });

		interactionCleanup = () => {
			target.removeEventListener("pointerdown", onPointerDown);
			target.removeEventListener("pointermove", onPointerMove);
			target.removeEventListener("pointerup", onPointerUp);
			target.removeEventListener("pointerleave", onPointerUp);
			target.removeEventListener("click", onClick);
			target.removeEventListener("wheel", onWheel);
		};
	}

	function resizeCanvas() {
		if (!canvas) return;
		const rect = canvas.parentElement?.getBoundingClientRect();
		if (!rect) return;
		canvas.width = rect.width;
		canvas.height = rect.height;
	}

	async function reloadEmbeddingsGraph() {
		graphInitialized = false;
		graphStatus = "";
		graphError = "";
		projected3dCache = null;
		graphSelected = null;
		graphHovered = null;
		globalSimilar = [];
		loadingGlobalSimilar = false;
		embeddingById = new Map();
		embeddingNormById = new Map();
		relationLookup = new Map();
		relationCache = new Map();
		similarNeighbors = [];
		dissimilarNeighbors = [];
		activeNeighbors = [];
		embeddings = [];
		embeddingsTotal = 0;
		embeddingsHasMore = false;
		nodes = [];
		edges = [];
		camX = 0;
		camY = 0;
		camZoom = 1;
		simulation?.stop();
		simulation = null;
		cancelAnimationFrame(animFrame);
		if (graph3d) {
			graph3d._destructor?.();
			graph3d = null;
		}
		graphMode = "2d";

		await tick();
		if (canvas) initGraph();
	}

	async function initGraph() {
		if (graphInitialized) return;
		graphInitialized = true;
		graphError = "";
		graphStatus = "Loading embeddings...";
		const loadId = ++graphLoadId;

		try {
			const result = await loadEmbeddingsForGraph(embeddingLimit);
			if (loadId !== graphLoadId) return;

			if (result.error) {
				graphError = result.error;
				graphStatus = "";
				return;
			}

			embeddings = (result.embeddings ?? []).filter(hasEmbeddingVector);
			embeddingsTotal = result.total || embeddings.length;
			embeddingsHasMore = Boolean(result.hasMore);
			embeddingById = new Map(embeddings.map((item) => [item.id, item]));
			embeddingNormById = new Map();
			projected3dCache = null;

			if (embeddings.length === 0) {
				graphStatus = "";
				return;
			}

			graphStatus = `Computing UMAP (${embeddings.length})...`;
			await new Promise((resolve) => setTimeout(resolve, 30));

			const vectors = embeddings
				.map((item) => item.vector)
				.filter((vector): vector is number[] => Array.isArray(vector));
			const umap = new UMAP({
				nComponents: 2,
				nNeighbors: Math.min(15, Math.max(2, vectors.length - 1)),
				minDist: 0.1,
				spread: 1.0,
			});

			let projected: number[][];
			try {
				projected = umap.fit(vectors);
			} catch (error) {
				graphError = `UMAP failed: ${(error as Error).message}`;
				graphStatus = "";
				return;
			}

			graphStatus = "Building graph...";
			await new Promise((resolve) => setTimeout(resolve, 30));

			let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
			for (const point of projected) {
				if (point[0] < minX) minX = point[0];
				if (point[0] > maxX) maxX = point[0];
				if (point[1] < minY) minY = point[1];
				if (point[1] > maxY) maxY = point[1];
			}

			const rangeX = maxX - minX || 1;
			const rangeY = maxY - minY || 1;
			const scale = 420;

			nodes = embeddings.map((embedding, index) => ({
				x: ((projected[index][0] - minX) / rangeX - 0.5) * scale,
				y: ((projected[index][1] - minY) / rangeY - 0.5) * scale,
				radius: 2.3 + (embedding.importance ?? 0.5) * 2.8,
				color: sourceColorRgba(embedding.who, 0.85),
				data: embedding,
			}));

			edges = buildKnnEdges(projected, GRAPH_K).map(([source, target]) => ({
				source,
				target,
			}));

			simulation?.stop();
			simulation = forceSimulation(nodes as any)
				.force("link", forceLink(edges).distance(58).strength(0.28))
				.force("charge", forceManyBody().strength(-72))
				.force("center", forceCenter(0, 0))
				.force(
					"collide",
					forceCollide().radius((entry: any) => entry.radius + 2),
				)
				.alphaDecay(0.03)
				.on("tick", () => {});

			graphStatus = "";
			await tick();
			if (loadId !== graphLoadId) return;

			resizeCanvas();
			if (!resizeListenerAttached) {
				window.addEventListener("resize", resizeCanvas);
				resizeListenerAttached = true;
			}
			setupInteractions();

			const context = canvas?.getContext("2d");
			if (context) {
				cancelAnimationFrame(animFrame);
				draw(context);
			}
		} catch (error) {
			graphError = (error as Error).message || "Failed to load embeddings";
			graphStatus = "";
		}
	}

	function nodeTooltip(id: string): string {
		const item = getEmbeddingById(id);
		if (!item) return "";
		const preview = embeddingLabel(item);
		return `${item.who ?? "unknown"} - ${preview}`;
	}

	async function init3DGraph(projected3d: number[][]) {
		if (!graph3dContainer) return;
		if (graph3d) {
			graph3d._destructor?.();
			graph3d = null;
		}

		const { default: ForceGraph3D } = await import("3d-force-graph");

		const nodeData = embeddings.map((embedding, index) => ({
			id: embedding.id,
			content: embedding.content,
			who: embedding.who,
			importance: embedding.importance ?? 0.5,
			x: projected3d[index][0] * 52,
			y: projected3d[index][1] * 52,
			z: projected3d[index][2] * 52,
			val: 1 + (embedding.importance ?? 0.5) * 2.6,
		}));

		const edgePairs = buildKnnEdges(projected3d, GRAPH_K);
		const linkData = edgePairs.map(([source, target]) => ({
			source: nodeData[source].id,
			target: nodeData[target].id,
		}));

		const rect = graph3dContainer.getBoundingClientRect();
		graph3d = new ForceGraph3D(graph3dContainer)
			.width(rect.width || graph3dContainer.offsetWidth)
			.height(rect.height || graph3dContainer.offsetHeight)
			.graphData({ nodes: nodeData, links: linkData })
			.nodeLabel((node: any) => nodeTooltip(String(node.id)))
			.nodeColor((node: any) => nodeColor3D(String(node.id), String(node.who ?? "unknown")))
			.nodeVal((node: any) => 0.6 + (node.importance ?? 0.5) * 1.4)
			.linkColor(() => "rgba(160,160,160,0.5)")
			.linkWidth(0.45)
			.backgroundColor("#050505")
			.onNodeClick((node: any) => {
				selectEmbeddingById(String(node.id), true);
			})
			.onNodeHover((node: any) => {
				graphHovered = node ? getEmbeddingById(String(node.id)) : null;
			});
	}

	async function switchGraphMode(mode: "2d" | "3d") {
		if (graphMode === mode) return;
		graphMode = mode;

		if (mode === "3d") {
			cancelAnimationFrame(animFrame);
			if (!graphInitialized || embeddings.length === 0) return;

			if (!projected3dCache) {
				graphStatus = "Computing 3D layout...";
				await new Promise((resolve) => setTimeout(resolve, 30));

				const vectors = embeddings
					.map((entry) => entry.vector)
					.filter((vector): vector is number[] => Array.isArray(vector));
				const umap3d = new UMAP({
					nComponents: 3,
					nNeighbors: Math.min(15, Math.max(2, vectors.length - 1)),
					minDist: 0.1,
					spread: 1.0,
				});

				try {
					projected3dCache = umap3d.fit(vectors);
				} catch (error) {
					graphError = `3D UMAP failed: ${(error as Error).message}`;
					graphStatus = "";
					graphMode = "2d";
					const context = canvas?.getContext("2d");
					if (context) draw(context);
					return;
				}
			}

			graphStatus = "";
			await tick();
			await init3DGraph(projected3dCache);
			refresh3DAppearance();
			if (graphSelected) focusEmbedding3D(graphSelected.id);
		} else {
			if (graph3d) {
				graph3d._destructor?.();
				graph3d = null;
			}
			await tick();
			const context = canvas?.getContext("2d");
			if (context) {
				cancelAnimationFrame(animFrame);
				draw(context);
			}
		}
	}

	async function loadGlobalSimilarForSelected() {
		if (!graphSelected) return;
		loadingGlobalSimilar = true;
		try {
			globalSimilar = await getSimilarMemories(graphSelected.id, 10, mem.filterType || undefined);
		} finally {
			loadingGlobalSimilar = false;
		}
	}

	// --- Effects ---

	$effect(() => {
		const query = embeddingSearch.trim().toLowerCase();
		const rows = embeddings;
		if (!query) {
			embeddingFilterIds = null;
			embeddingSearchMatches = [];
			if (graphMode === "3d") refresh3DAppearance();
			return;
		}

		const ids = new Set<string>();
		const matches: EmbeddingPoint[] = [];
		for (const row of rows) {
			const haystack = [
				row.content, row.text ?? "", row.who ?? "",
				row.type ?? "", row.sourceType ?? "", row.sourceId ?? "",
				...(row.tags ?? []),
			].join(" ").toLowerCase();
			if (haystack.includes(query)) {
				ids.add(row.id);
				matches.push(row);
			}
		}

		embeddingFilterIds = ids;
		embeddingSearchMatches = matches.slice(0, 50);
		if (graphMode === "3d") refresh3DAppearance();
	});

	$effect(() => {
		computeRelationsForSelection(graphSelected);
	});

	$effect(() => {
		const mode = relationMode;
		const similar = similarNeighbors;
		const dissimilar = dissimilarNeighbors;
		activeNeighbors = mode === "similar" ? similar : dissimilar;
		relationLookup = new Map(activeNeighbors.map((item) => [item.id, item.kind]));
		if (graphMode === "3d") refresh3DAppearance();
	});

	$effect(() => {
		if (canvas && !graphInitialized) {
			initGraph();
		}
	});

	$effect(() => {
		if (canvas && graphInitialized && graphMode === "2d" && nodes.length > 0) {
			tick().then(() => {
				resizeCanvas();
				cancelAnimationFrame(animFrame);
				const context = canvas?.getContext("2d");
				if (context) draw(context);
			});
		}
	});

	// Cleanup on unmount
	$effect(() => {
		return () => {
			simulation?.stop();
			simulation = null;
			if (interactionCleanup) {
				interactionCleanup();
				interactionCleanup = null;
			}
			if (resizeListenerAttached) {
				window.removeEventListener("resize", resizeCanvas);
				resizeListenerAttached = false;
			}
			cancelAnimationFrame(animFrame);
			if (graph3d) {
				graph3d._destructor?.();
				graph3d = null;
			}
		};
	});
</script>

<div class="embeddings-layout">
	<div class="canvas-container">
		<div class="graph-toolbar">
			<input
				type="text"
				class="graph-toolbar-input"
				bind:value={embeddingSearch}
				placeholder="Filter embeddings (content, source, tags)..."
			/>
			{#if embeddingSearch}
				<span class="graph-toolbar-meta">
					{embeddingSearchMatches.length} match{embeddingSearchMatches.length === 1 ? '' : 'es'}
				</span>
			{/if}
			{#if embeddingsHasMore}
				<span class="graph-toolbar-meta">showing latest {embeddings.length} of {embeddingsTotal}</span>
			{/if}
		</div>

		{#if graphStatus}
			<div class="overlay">
				<p>{graphStatus}</p>
			</div>
		{:else if graphError}
			<div class="overlay">
				<p class="text-error">{graphError}</p>
			</div>
		{:else if graphInitialized && embeddings.length === 0}
			<div class="overlay">
				<p>No embeddings found</p>
			</div>
		{:else if !graphInitialized}
			<div class="overlay">
				<p>Loading...</p>
			</div>
		{/if}

		<div class="graph-ascii" aria-hidden="true">:: ○ ○ 01 10 11 // latent topology</div>
		<div class="graph-corners" aria-hidden="true">
			<span class="corner corner-tl"></span>
			<span class="corner corner-tr"></span>
			<span class="corner corner-bl"></span>
			<span class="corner corner-br"></span>
		</div>
		<canvas
			bind:this={canvas}
			class="canvas"
			style:display={graphMode === '2d' ? 'block' : 'none'}
		></canvas>
		<div
			bind:this={graph3dContainer}
			class="graph3d-container"
			style:display={graphMode === '3d' ? 'block' : 'none'}
		></div>
	</div>

	<aside class="embedding-inspector">
		<div class="embedding-inspector-header">
			<span class="embedding-inspector-title">Inspector</span>
			{#if graphSelected}
				<button class="btn-text" onclick={clearEmbeddingSelection}>Clear</button>
			{/if}
		</div>

		{#if graphSelected}
			<div class="embedding-inspector-meta">
				<span>{graphSelected.who ?? 'unknown'}</span>
				{#if graphSelected.type}
					<span>{graphSelected.type}</span>
				{/if}
				<span>importance {Math.round((graphSelected.importance ?? 0) * 100)}%</span>
			</div>
			<div class="embedding-inspector-source">{embeddingSourceLabel(graphSelected)}</div>
			<p class="embedding-inspector-content">{graphSelected.content}</p>

			{#if graphSelected.tags?.length}
				<div class="embedding-inspector-tags">
					{#each graphSelected.tags.slice(0, 8) as tag}
						<span>#{tag}</span>
					{/each}
				</div>
			{/if}

			<div class="embedding-inspector-actions">
				<button
					class="btn-primary-small"
					onclick={() => graphSelected && focusEmbedding(graphSelected.id)}
				>
					Center
				</button>
				<button
					class="btn-primary-small"
					onclick={loadGlobalSimilarForSelected}
					disabled={loadingGlobalSimilar}
				>
					{loadingGlobalSimilar ? 'Loading...' : 'Global similar'}
				</button>
			</div>

			<div class="mode-toggle embedding-mode-toggle">
				<button
					class="mode-btn"
					class:mode-btn-active={relationMode === 'similar'}
					onclick={() => relationMode = 'similar'}
				>
					Similar
				</button>
				<button
					class="mode-btn"
					class:mode-btn-active={relationMode === 'dissimilar'}
					onclick={() => relationMode = 'dissimilar'}
				>
					Dissimilar
				</button>
			</div>

			<div class="embedding-relation-list">
				{#if activeNeighbors.length === 0}
					<div class="embedding-inspector-empty">No related embeddings in this view.</div>
				{:else}
					{#each activeNeighbors as relation}
						{@const item = getEmbeddingById(relation.id)}
						{#if item}
							<button
								class="embedding-relation-item"
								onclick={() => selectEmbeddingById(item.id, true)}
							>
								<span class="embedding-relation-score">
									{Math.round(relation.score * 1000) / 1000}
								</span>
								<span class="embedding-relation-text">{embeddingLabel(item)}</span>
							</button>
						{/if}
					{/each}
				{/if}
			</div>

			{#if loadingGlobalSimilar}
				<div class="embedding-inspector-empty">Finding globally similar embeddings...</div>
			{:else if globalSimilar.length > 0}
				<div class="embedding-inspector-subtitle">Global similar</div>
				<div class="embedding-relation-list">
					{#each globalSimilar as item}
						<button class="embedding-relation-item" onclick={() => onopenglobalsimilar(item)}>
							<span class="embedding-relation-score">global</span>
							<span class="embedding-relation-text">{item.content}</span>
						</button>
					{/each}
				</div>
			{/if}
		{:else}
			<div class="embedding-inspector-empty">
				Select a node to inspect content, source metadata, and similar or dissimilar neighbors.
			</div>

			{#if embeddingSearch && embeddingSearchMatches.length > 0}
				<div class="embedding-inspector-subtitle">Search matches</div>
				<div class="embedding-relation-list">
					{#each embeddingSearchMatches as item}
						<button
							class="embedding-relation-item"
							onclick={() => selectEmbeddingById(item.id, true)}
						>
							<span class="embedding-relation-score">{item.who}</span>
							<span class="embedding-relation-text">{embeddingLabel(item)}</span>
						</button>
					{/each}
				</div>
			{/if}
		{/if}
	</aside>
</div>

<script lang="ts">
import { tick } from "svelte";
import { browser } from "$app/environment";
import { UMAP } from "umap-js";
import {
	getEmbeddings,
	getSimilarMemories,
	type Memory,
	type EmbeddingPoint,
} from "$lib/api";
import { mem } from "$lib/stores/memory.svelte";
import EmbeddingCanvas2D from "../embeddings/EmbeddingCanvas2D.svelte";
import EmbeddingCanvas3D from "../embeddings/EmbeddingCanvas3D.svelte";
import EmbeddingInspector from "../embeddings/EmbeddingInspector.svelte";
import {
	type RelationKind,
	type EmbeddingRelation,
	type RelationCacheEntry,
	type RelationScore,
	type GraphNode,
	type GraphEdge,
	DEFAULT_EMBEDDING_LIMIT,
	MIN_EMBEDDING_LIMIT,
	MAX_EMBEDDING_LIMIT,
	EMBEDDING_LIMIT_STORAGE_KEY,
	GRAPH_K,
	hasEmbeddingVector,
	sourceColorRgba,
	clampEmbeddingLimit,
	mergeUniqueEmbeddings,
	buildEmbeddingsResponse,
	buildKnnEdges,
	cosineSimilarity,
	embeddingNorm,
	insertTopScore,
	insertBottomScore,
	RELATION_LIMIT,
	EMBEDDING_PAGE_PROBE_LIMIT,
} from "../embeddings/embedding-graph";

interface Props {
	onopenglobalsimilar: (memory: Memory) => void;
}

let { onopenglobalsimilar }: Props = $props();

// -----------------------------------------------------------------------
// State
// -----------------------------------------------------------------------

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

let relationMode = $state<RelationKind>("similar");
let similarNeighbors = $state<EmbeddingRelation[]>([]);
let dissimilarNeighbors = $state<EmbeddingRelation[]>([]);
let activeNeighbors = $state<EmbeddingRelation[]>([]);
let loadingGlobalSimilar = $state(false);
let globalSimilar = $state<Memory[]>([]);

let nodes = $state<GraphNode[]>([]);
let edges = $state<GraphEdge[]>([]);

let graphMode: "2d" | "3d" = $state("2d");
let projected3dCache: number[][] | null = null;
let graphLoadId = 0;

let embeddingById = new Map<string, EmbeddingPoint>();
let embeddingNormById = new Map<string, number>();
let relationLookup = $state(new Map<string, RelationKind>());
let relationCache = new Map<string, RelationCacheEntry>();

// Sub-component references
let canvas2d = $state<EmbeddingCanvas2D | null>(null);
let canvas3d = $state<EmbeddingCanvas3D | null>(null);

// -----------------------------------------------------------------------
// Init stored limit
// -----------------------------------------------------------------------

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

// -----------------------------------------------------------------------
// Data loading
// -----------------------------------------------------------------------

async function loadEmbeddingsForGraph(limit: number) {
	const requestedLimit = clampEmbeddingLimit(limit);
	const firstPage = await getEmbeddings(true, {
		limit: requestedLimit,
		offset: 0,
	});

	if (firstPage.error) return firstPage;

	const merged: EmbeddingPoint[] = [];
	const seen = new Set<string>();
	mergeUniqueEmbeddings(merged, seen, firstPage.embeddings ?? []);

	let total = firstPage.total > 0 ? firstPage.total : merged.length;
	let hasMore = firstPage.hasMore || total > merged.length;

	if (merged.length >= requestedLimit) {
		return buildEmbeddingsResponse(
			requestedLimit,
			merged.slice(0, requestedLimit),
			total,
			hasMore,
		);
	}

	let offset = merged.length;
	let probeCount = 0;
	let shouldProbeForMore =
		requestedLimit > merged.length && merged.length > 0;

	while (
		merged.length < requestedLimit &&
		probeCount < EMBEDDING_PAGE_PROBE_LIMIT &&
		(hasMore || shouldProbeForMore)
	) {
		const remaining = requestedLimit - merged.length;
		const page = await getEmbeddings(true, {
			limit: remaining,
			offset,
		});

		if (page.error) {
			return buildEmbeddingsResponse(
				requestedLimit,
				merged,
				total,
				hasMore,
				page.error,
			);
		}

		const rows = page.embeddings ?? [];
		const added = mergeUniqueEmbeddings(merged, seen, rows);

		if (page.total > total) total = page.total;
		hasMore = page.hasMore || total > merged.length;

		if (rows.length === 0 || added === 0) break;

		offset += rows.length;
		shouldProbeForMore =
			!hasMore && merged.length < requestedLimit;
		probeCount += 1;
	}

	return buildEmbeddingsResponse(
		requestedLimit,
		merged.slice(0, requestedLimit),
		total,
		hasMore,
	);
}

// -----------------------------------------------------------------------
// Graph initialization
// -----------------------------------------------------------------------

async function initGraph(): Promise<void> {
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

		embeddings = (result.embeddings ?? []).filter(
			hasEmbeddingVector,
		);
		embeddingsTotal = result.total || embeddings.length;
		embeddingsHasMore = Boolean(result.hasMore);
		embeddingById = new Map(
			embeddings.map((item) => [item.id, item]),
		);
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
			.filter(
				(vector): vector is number[] => Array.isArray(vector),
			);
		const umap = new UMAP({
			nComponents: 2,
			nNeighbors: Math.min(
				15,
				Math.max(2, vectors.length - 1),
			),
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

		let minX = Infinity,
			maxX = -Infinity,
			minY = Infinity,
			maxY = -Infinity;
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
			x:
				((projected[index][0] - minX) / rangeX - 0.5) *
				scale,
			y:
				((projected[index][1] - minY) / rangeY - 0.5) *
				scale,
			radius: 2.3 + (embedding.importance ?? 0.5) * 2.8,
			color: sourceColorRgba(embedding.who, 0.85),
			data: embedding,
		}));

		edges = buildKnnEdges(projected, GRAPH_K).map(
			([source, target]) => ({ source, target }),
		);

		graphStatus = "";
		await tick();
		if (loadId !== graphLoadId) return;

		canvas2d?.startSimulation(nodes, edges);
		canvas2d?.startRendering();
	} catch (error) {
		graphError =
			(error as Error).message || "Failed to load embeddings";
		graphStatus = "";
	}
}

// -----------------------------------------------------------------------
// Relation computation
// -----------------------------------------------------------------------

function computeRelationsForSelection(
	selected: EmbeddingPoint | null,
): void {
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
		activeNeighbors =
			relationMode === "similar"
				? cached.similar
				: cached.dissimilar;
		relationLookup = new Map(
			activeNeighbors.map((item) => [item.id, item.kind]),
		);
		return;
	}

	const selectedNorm = embeddingNorm(selected, embeddingNormById);
	const similarScores: RelationScore[] = [];
	const dissimilarScores: RelationScore[] = [];

	for (const candidate of embeddings) {
		if (
			candidate.id === selected.id ||
			!hasEmbeddingVector(candidate)
		)
			continue;
		const score = cosineSimilarity(
			selected.vector,
			candidate.vector,
			selectedNorm,
			embeddingNorm(candidate, embeddingNormById),
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

	similarNeighbors = similarScores.map((item) => ({
		...item,
		kind: "similar" as const,
	}));
	dissimilarNeighbors = dissimilarScores.map((item) => ({
		...item,
		kind: "dissimilar" as const,
	}));
	relationCache.set(selected.id, {
		similar: similarNeighbors,
		dissimilar: dissimilarNeighbors,
	});

	activeNeighbors =
		relationMode === "similar"
			? similarNeighbors
			: dissimilarNeighbors;
	relationLookup = new Map(
		activeNeighbors.map((item) => [item.id, item.kind]),
	);
}

// -----------------------------------------------------------------------
// Actions
// -----------------------------------------------------------------------

function clearEmbeddingSelection(): void {
	graphSelected = null;
	graphHovered = null;
	globalSimilar = [];
}

function selectEmbeddingById(id: string): void {
	const next = embeddingById.get(id) ?? null;
	if (!next) return;
	graphSelected = next;
	focusEmbedding(id);
}

function focusEmbedding(id: string): void {
	if (graphMode === "2d") {
		canvas2d?.focusNode(id);
		return;
	}
	canvas3d?.focusNode(id);
}

async function loadGlobalSimilarForSelected(): Promise<void> {
	if (!graphSelected) return;
	loadingGlobalSimilar = true;
	try {
		globalSimilar = await getSimilarMemories(
			graphSelected.id,
			10,
			mem.filterType || undefined,
		);
	} finally {
		loadingGlobalSimilar = false;
	}
}

async function reloadEmbeddingsGraph(): Promise<void> {
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

	canvas2d?.stopSimulation();
	canvas2d?.stopRendering();
	canvas2d?.resetCamera();
	canvas3d?.destroy();
	graphMode = "2d";

	await tick();
	initGraph();
}

function applyEmbeddingLimit(): void {
	const parsed = Number.parseInt(embeddingLimitInput, 10);
	const next = clampEmbeddingLimit(
		Number.isFinite(parsed) ? parsed : embeddingLimit,
	);
	embeddingLimit = next;
	embeddingLimitInput = String(next);
	if (browser) {
		localStorage.setItem(
			EMBEDDING_LIMIT_STORAGE_KEY,
			String(next),
		);
	}
	reloadEmbeddingsGraph();
}

async function switchGraphMode(mode: "2d" | "3d"): Promise<void> {
	if (graphMode === mode) return;
	graphMode = mode;

	if (mode === "3d") {
		canvas2d?.stopRendering();
		if (!graphInitialized || embeddings.length === 0) return;

		if (!projected3dCache) {
			graphStatus = "Computing 3D layout...";
			await new Promise((resolve) => setTimeout(resolve, 30));

			const vectors = embeddings
				.map((entry) => entry.vector)
				.filter(
					(vector): vector is number[] =>
						Array.isArray(vector),
				);
			const umap3d = new UMAP({
				nComponents: 3,
				nNeighbors: Math.min(
					15,
					Math.max(2, vectors.length - 1),
				),
				minDist: 0.1,
				spread: 1.0,
			});

			try {
				projected3dCache = umap3d.fit(vectors);
			} catch (error) {
				graphError = `3D UMAP failed: ${(error as Error).message}`;
				graphStatus = "";
				graphMode = "2d";
				canvas2d?.resumeRendering();
				return;
			}
		}

		graphStatus = "";
		await tick();
		await canvas3d?.init();
		canvas3d?.refreshAppearance();
		if (graphSelected) canvas3d?.focusNode(graphSelected.id);
	} else {
		canvas3d?.destroy();
		await tick();
		canvas2d?.resumeRendering();
	}
}

// -----------------------------------------------------------------------
// Effects
// -----------------------------------------------------------------------

$effect(() => {
	const query = embeddingSearch.trim().toLowerCase();
	const rows = embeddings;
	if (!query) {
		embeddingFilterIds = null;
		embeddingSearchMatches = [];
		if (graphMode === "3d") canvas3d?.refreshAppearance();
		return;
	}

	const ids = new Set<string>();
	const matches: EmbeddingPoint[] = [];
	for (const row of rows) {
		const haystack = [
			row.content,
			row.text ?? "",
			row.who ?? "",
			row.type ?? "",
			row.sourceType ?? "",
			row.sourceId ?? "",
			...(row.tags ?? []),
		]
			.join(" ")
			.toLowerCase();
		if (haystack.includes(query)) {
			ids.add(row.id);
			matches.push(row);
		}
	}

	embeddingFilterIds = ids;
	embeddingSearchMatches = matches.slice(0, 50);
	if (graphMode === "3d") canvas3d?.refreshAppearance();
});

$effect(() => {
	computeRelationsForSelection(graphSelected);
});

$effect(() => {
	const mode = relationMode;
	const similar = similarNeighbors;
	const dissimilar = dissimilarNeighbors;
	activeNeighbors = mode === "similar" ? similar : dissimilar;
	relationLookup = new Map(
		activeNeighbors.map((item) => [item.id, item.kind]),
	);
	if (graphMode === "3d") canvas3d?.refreshAppearance();
});

// Kick off graph when component mounts (canvas becomes available)
$effect(() => {
	if (!graphInitialized) {
		initGraph();
	}
});
</script>

<div class="flex flex-1 min-h-0 bg-[#050505] max-lg:flex-col">
	<div class="flex-1 relative overflow-hidden bg-[#050505]">
		<div class="absolute top-2 left-3 right-3 z-[8] flex items-center gap-2 pointer-events-none">
			<input
				type="text"
				class="flex-1 max-w-[420px] pointer-events-auto font-[family-name:var(--font-mono)] text-[11px] text-[var(--sig-text-bright)] bg-[var(--sig-surface)] border border-[rgba(255,255,255,0.22)] px-[9px] py-[6px] outline-none"
				bind:value={embeddingSearch}
				placeholder="Filter embeddings (content, source, tags)..."
			/>
			{#if embeddingSearch}
				<span class="font-[family-name:var(--font-mono)] text-[10px] text-[rgba(220,220,220,0.75)] bg-[rgba(5,5,5,0.55)] border border-[rgba(255,255,255,0.16)] px-2 py-1">
					{embeddingSearchMatches.length} match{embeddingSearchMatches.length === 1 ? '' : 'es'}
				</span>
			{/if}
			{#if embeddingsHasMore}
				<span class="font-[family-name:var(--font-mono)] text-[10px] text-[rgba(220,220,220,0.75)] bg-[rgba(5,5,5,0.55)] border border-[rgba(255,255,255,0.16)] px-2 py-1">
					showing latest {embeddings.length} of {embeddingsTotal}
				</span>
			{/if}
		</div>

		{#if graphStatus}
			<div class="absolute inset-0 flex items-center justify-center bg-[var(--sig-bg)] z-10">
				<p>{graphStatus}</p>
			</div>
		{:else if graphError}
			<div class="absolute inset-0 flex items-center justify-center bg-[var(--sig-bg)] z-10">
				<p class="text-[var(--sig-danger)]">{graphError}</p>
			</div>
		{:else if graphInitialized && embeddings.length === 0}
			<div class="absolute inset-0 flex items-center justify-center bg-[var(--sig-bg)] z-10">
				<p>No embeddings found</p>
			</div>
		{:else if !graphInitialized}
			<div class="absolute inset-0 flex items-center justify-center bg-[var(--sig-bg)] z-10">
				<p>Loading...</p>
			</div>
		{/if}

		<div
			class="absolute left-[14px] top-[44px] z-[6] font-[family-name:var(--font-mono)] text-[10px] text-[var(--sig-text-muted)] tracking-[0.08em] uppercase pointer-events-none"
			aria-hidden="true"
		>:: &#9675; &#9675; 01 10 11 // latent topology</div>

		<div class="absolute inset-0 pointer-events-none z-[5]" aria-hidden="true">
			<span class="absolute top-[10px] left-[10px] w-[14px] h-[14px] border-[rgba(255,255,255,0.22)]" style="border-style:solid;border-width:1px 0 0 1px"></span>
			<span class="absolute top-[10px] right-[10px] w-[14px] h-[14px] border-[rgba(255,255,255,0.22)]" style="border-style:solid;border-width:1px 1px 0 0"></span>
			<span class="absolute bottom-[10px] left-[10px] w-[14px] h-[14px] border-[rgba(255,255,255,0.22)]" style="border-style:solid;border-width:0 0 1px 1px"></span>
			<span class="absolute bottom-[10px] right-[10px] w-[14px] h-[14px] border-[rgba(255,255,255,0.22)]" style="border-style:solid;border-width:0 1px 1px 0"></span>
		</div>

		<div style:display={graphMode === '2d' ? 'contents' : 'none'}>
			<EmbeddingCanvas2D
				bind:this={canvas2d}
				{nodes}
				{edges}
				{graphSelected}
				{graphHovered}
				{embeddingFilterIds}
				{relationLookup}
				onselectnode={(e) => graphSelected = e}
				onhovernode={(e) => graphHovered = e}
			/>
		</div>
		<div style:display={graphMode === '3d' ? 'contents' : 'none'}>
			<EmbeddingCanvas3D
				bind:this={canvas3d}
				{embeddings}
				projected3d={projected3dCache ?? []}
				{graphSelected}
				{embeddingFilterIds}
				{relationLookup}
				{embeddingById}
				onselectnode={(e) => { if (e) selectEmbeddingById(e.id); else graphSelected = null; }}
				onhovernode={(e) => graphHovered = e}
			/>
		</div>
	</div>

	<EmbeddingInspector
		{graphSelected}
		{embeddings}
		{embeddingById}
		{activeNeighbors}
		{relationMode}
		{loadingGlobalSimilar}
		{globalSimilar}
		{embeddingSearchMatches}
		{embeddingSearch}
		onselectembedding={selectEmbeddingById}
		onclearselection={clearEmbeddingSelection}
		onloadglobalsimilar={loadGlobalSimilarForSelected}
		{onopenglobalsimilar}
		onsetrelationmode={(mode) => relationMode = mode}
		onfocusembedding={() => graphSelected && focusEmbedding(graphSelected.id)}
	/>
</div>

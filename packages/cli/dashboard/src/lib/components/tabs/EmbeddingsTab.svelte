<script lang="ts">
import { tick } from "svelte";
import {
	getProjection,
	getSimilarMemories,
	type Memory,
	type EmbeddingPoint,
	type ProjectionNode,
} from "$lib/api";
import { mem } from "$lib/stores/memory.svelte";
import EmbeddingCanvas2D from "../embeddings/EmbeddingCanvas2D.svelte";
import EmbeddingCanvas3D from "../embeddings/EmbeddingCanvas3D.svelte";
import EmbeddingInspector from "../embeddings/EmbeddingInspector.svelte";
import {
	type RelationKind,
	type EmbeddingRelation,
	type GraphNode,
	type GraphEdge,
	sourceColorRgba,
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
// 3D projection coords in same order as `embeddings`, passed to Canvas3D
let projected3dCoords = $state<number[][]>([]);
let graphLoadId = 0;

let embeddingById = $state(new Map<string, EmbeddingPoint>());
let relationLookup = $state(new Map<string, RelationKind>());

// Sub-component references
let canvas2d = $state<EmbeddingCanvas2D | null>(null);
let canvas3d = $state<EmbeddingCanvas3D | null>(null);

// -----------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------

function projectionNodeToEmbeddingPoint(
	node: ProjectionNode,
): EmbeddingPoint {
	return {
		id: node.id,
		content: node.content,
		who: node.who,
		importance: node.importance,
		type: node.type,
		tags: node.tags,
		createdAt: node.createdAt,
	};
}

// -----------------------------------------------------------------------
// Graph initialization
// -----------------------------------------------------------------------

async function initGraph(): Promise<void> {
	if (graphInitialized) return;
	graphInitialized = true;
	graphError = "";
	graphStatus = "Loading projection...";
	const loadId = ++graphLoadId;

	try {
		let projection = await getProjection(2);
		let pollAttempts = 0;
		const MAX_POLL_ATTEMPTS = 30;

		while (projection.status === "computing") {
			if (loadId !== graphLoadId) return;
			pollAttempts++;
			if (pollAttempts >= MAX_POLL_ATTEMPTS) {
				graphError = "Projection timed out after 60s. Try refreshing.";
				return;
			}
			graphStatus = "Computing layout...";
			await new Promise<void>((resolve) => setTimeout(resolve, 2000));
			projection = await getProjection(2);
		}

		if (projection.status === "error") {
			graphError = projection.message ?? "Projection computation failed";
			return;
		}

		if (loadId !== graphLoadId) return;

		const projNodes = projection.nodes ?? [];

		embeddings = projNodes.map(projectionNodeToEmbeddingPoint);
		embeddingsTotal = projection.total ?? projNodes.length;
		embeddingsHasMore =
			(projection.count ?? projNodes.length) <
			(projection.total ?? projNodes.length);
		embeddingById = new Map(embeddings.map((item) => [item.id, item]));

		if (projNodes.length === 0) {
			graphStatus = "";
			return;
		}

		// Normalize coords to canvas space
		let minX = Infinity,
			maxX = -Infinity,
			minY = Infinity,
			maxY = -Infinity;
		for (const n of projNodes) {
			if (n.x < minX) minX = n.x;
			if (n.x > maxX) maxX = n.x;
			if (n.y < minY) minY = n.y;
			if (n.y > maxY) maxY = n.y;
		}
		const rangeX = maxX - minX || 1;
		const rangeY = maxY - minY || 1;
		const scale = 420;

		nodes = projNodes.map((node, index) => ({
			x: ((node.x - minX) / rangeX - 0.5) * scale,
			y: ((node.y - minY) / rangeY - 0.5) * scale,
			radius: 2.3 + (node.importance ?? 0.5) * 2.8,
			color: sourceColorRgba(node.who, 0.85),
			data: embeddings[index],
		}));

		edges = (projection.edges ?? []).map(([source, target]) => ({
			source,
			target,
		}));

		graphStatus = "";
		await tick();
		if (loadId !== graphLoadId) return;

		canvas2d?.startSimulation(nodes, edges);
		canvas2d?.startRendering();
	} catch (error) {
		graphError =
			(error as Error).message || "Failed to load projection";
		graphStatus = "";
	}
}

// -----------------------------------------------------------------------
// Relation computation (server-side via getSimilarMemories)
// -----------------------------------------------------------------------

async function computeRelationsForSelection(
	selected: EmbeddingPoint | null,
): Promise<void> {
	if (!selected) {
		similarNeighbors = [];
		dissimilarNeighbors = [];
		activeNeighbors = [];
		relationLookup = new Map();
		return;
	}

	const results = await getSimilarMemories(selected.id, 10);
	similarNeighbors = results.map((m) => ({
		id: m.id,
		score: m.score ?? 0,
		kind: "similar" as const,
	}));
	dissimilarNeighbors = [];
	activeNeighbors = similarNeighbors;
	relationLookup = new Map(
		similarNeighbors.map((item) => [item.id, item.kind]),
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
	projected3dCoords = [];
	graphSelected = null;
	graphHovered = null;
	globalSimilar = [];
	loadingGlobalSimilar = false;
	embeddingById = new Map();
	relationLookup = new Map();
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

async function switchGraphMode(mode: "2d" | "3d"): Promise<void> {
	if (graphMode === mode) return;
	graphMode = mode;

	if (mode === "3d") {
		canvas2d?.stopRendering();
		if (!graphInitialized || embeddings.length === 0) return;

		graphStatus = "Loading 3D projection...";
		const loadId = ++graphLoadId;
		let projection = await getProjection(3);

		while (projection.status === "computing") {
			if (loadId !== graphLoadId) return;
			await new Promise<void>((resolve) => setTimeout(resolve, 2000));
			projection = await getProjection(3);
		}

		if (loadId !== graphLoadId) return;

		const projNodes = projection.nodes ?? [];
		const nodeMap = new Map(projNodes.map((n) => [n.id, n]));

		// Build 3D coords in same order as `embeddings` for Canvas3D sync
		projected3dCoords = embeddings.map((emb) => {
			const n = nodeMap.get(emb.id);
			return n ? [n.x, n.y, n.z ?? 0] : [0, 0, 0];
		});

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
				projected3d={projected3dCoords}
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

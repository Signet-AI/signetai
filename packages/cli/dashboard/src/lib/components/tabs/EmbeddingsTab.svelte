<script lang="ts">
import { tick } from "svelte";
import {
	getProjection,
	getSimilarMemories,
	setMemoryPinned,
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
	embeddingLabel,
} from "../embeddings/embedding-graph";

interface Props {
	onopenglobalsimilar: (memory: Memory) => void;
}

interface FilterPreset {
	id: string;
	name: string;
	search: string;
	sources: string[];
	pinnedOnly: boolean;
	neighborhoodOnly: boolean;
	clusterLensMode: boolean;
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
let searchFilterIds = $state<Set<string> | null>(null);
let sourceFilterIds = $state<Set<string> | null>(null);
let selectedSources = $state<Set<string>>(new Set());
let sourceCounts = $state<Array<{ who: string; count: number }>>([]);
let showPinnedOnly = $state(false);
let showNeighborhoodOnly = $state(false);
let pinnedIds = $state<Set<string>>(new Set());
let pinBusy = $state(false);
let pinError = $state("");
let clusterLensMode = $state(false);
let lensIds = $state<Set<string>>(new Set());
let activePresetId = $state("all");
let customPresets = $state<FilterPreset[]>([]);
let presetsHydrated = $state(false);

let relationMode = $state<RelationKind>("similar");
let similarNeighbors = $state<EmbeddingRelation[]>([]);
let dissimilarNeighbors = $state<EmbeddingRelation[]>([]);
let activeNeighbors = $state<EmbeddingRelation[]>([]);
let loadingGlobalSimilar = $state(false);
let globalSimilar = $state<Memory[]>([]);

let nodes = $state<GraphNode[]>([]);
let edges = $state<GraphEdge[]>([]);
let nodeIdsByIndex = $state<string[]>([]);

let graphMode: "2d" | "3d" = $state("2d");
let projected3dCoords = $state<number[][]>([]);
let graphLoadId = 0;

let embeddingById = $state(new Map<string, EmbeddingPoint>());
let relationLookup = $state(new Map<string, RelationKind>());
let hoverNeighbors = $state<EmbeddingRelation[]>([]);
let hoverRelationLookup = $state(new Map<string, RelationKind>());
let hoverLockedId = $state<string | null>(null);
let hoverAdjacency = $state(new Map<string, Map<string, number>>());

let graphRegion = $state<HTMLDivElement | null>(null);

// Fix 1: hoverX/hoverY are plain vars; position set imperatively via DOM.
// hoverCardEl uses $state so bind:this populates it, but style mutations
// bypass reactivity entirely — no Svelte re-render on mouse move.
let hoverX = 0;
let hoverY = 0;
let hoverCardEl = $state<HTMLDivElement | null>(null);
let graphRegionRect = { left: 0, top: 0, width: 0, height: 0 };

let canvas2d = $state<EmbeddingCanvas2D | null>(null);
let canvas3d = $state<EmbeddingCanvas3D | null>(null);

// Fix 4: coalesce refreshAppearance() calls
let refresh3dQueued = false;

// Fix 5: debounced search
let debouncedSearch = $state("");
let searchTimer: ReturnType<typeof setTimeout> | null = null;

// -----------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------

function projectionNodeToEmbeddingPoint(node: ProjectionNode): EmbeddingPoint {
	return {
		id: node.id,
		content: node.content,
		who: node.who,
		importance: node.importance,
		type: node.type,
		tags: node.tags,
		pinned: node.pinned ?? false,
		sourceType: node.sourceType,
		sourceId: node.sourceId,
		createdAt: node.createdAt,
	};
}

function formatShortDate(dateLike: string | undefined): string {
	if (!dateLike) return "-";
	const date = new Date(dateLike);
	if (Number.isNaN(date.getTime())) return "-";
	return date.toLocaleString(undefined, {
		month: "short",
		day: "numeric",
		hour: "2-digit",
		minute: "2-digit",
	});
}

function intersectFilterSets(
	filters: Array<Set<string> | null>,
): Set<string> | null {
	let out: Set<string> | null = null;
	for (const filter of filters) {
		if (filter === null) continue;
		if (out === null) {
			out = new Set(filter);
			continue;
		}
		out = new Set([...out].filter((id) => filter.has(id)));
	}
	return out;
}

// Fix 6: targeted O(1) patch instead of three O(n) map copies
function updateEmbeddingInState(
	id: string,
	patch: (entry: EmbeddingPoint) => EmbeddingPoint,
): void {
	const idx = embeddings.findIndex((e) => e.id === id);
	if (idx === -1) return;
	const patched = patch(embeddings[idx]);

	const nextEmbeddings = embeddings.slice();
	nextEmbeddings[idx] = patched;
	embeddings = nextEmbeddings;

	const nextMap = new Map(embeddingById);
	nextMap.set(id, patched);
	embeddingById = nextMap;

	const nodeIdx = nodes.findIndex((n) => n.data.id === id);
	if (nodeIdx !== -1) {
		const nextNodes = nodes.slice();
		nextNodes[nodeIdx] = { ...nextNodes[nodeIdx], data: patched };
		nodes = nextNodes;
	}

	if (graphSelected?.id === id) graphSelected = patched;
	if (graphHovered?.id === id) graphHovered = patched;
}

function toggleSource(who: string): void {
	const next = new Set(selectedSources);
	if (next.has(who)) {
		next.delete(who);
	} else {
		next.add(who);
	}
	selectedSources = next;
}

// Fix 1: position hover card directly via transform, no reactive state
function handleGraphMouseMove(event: MouseEvent): void {
	if (!graphRegion) return;
	hoverX = event.clientX - graphRegionRect.left;
	hoverY = event.clientY - graphRegionRect.top;
	positionHoverCard();
}

function positionHoverCard(): void {
	if (!hoverCardEl) return;
	const maxX = Math.max(12, graphRegionRect.width - 334);
	const maxY = Math.max(12, graphRegionRect.height - 170);
	const left = Math.min(Math.max(12, hoverX + 14), maxX);
	const top = Math.min(Math.max(12, hoverY + 14), maxY);
	hoverCardEl.style.transform = `translate3d(${left}px, ${top}px, 0)`;
}

function updateGraphHover(next: EmbeddingPoint | null): void {
	if (hoverLockedId) return;
	if (!next && !graphHovered) return;
	if (next && graphHovered && next.id === graphHovered.id) return;
	graphHovered = next;
}

function lockHoverPreview(): void {
	if (graphSelected) return;
	if (!graphHovered) return;
	hoverLockedId = graphHovered.id;
}

function unlockHoverPreview(): void {
	hoverLockedId = null;
}

function getEdgeEndpointId(endpoint: GraphEdge["source"]): string | null {
	if (typeof endpoint === "number") {
		return nodeIdsByIndex[endpoint] ?? null;
	}
	return endpoint?.data.id ?? null;
}

function computeHoverNeighbors(hovered: EmbeddingPoint | null): void {
	if (!hovered) {
		hoverNeighbors = [];
		hoverRelationLookup = new Map();
		return;
	}

	const ranked = hoverAdjacency.get(hovered.id);
	if (!ranked || ranked.size === 0) {
		hoverNeighbors = [];
		hoverRelationLookup = new Map();
		return;
	}

	const topNeighbors = [...ranked.entries()]
		.sort((left, right) => right[1] - left[1])
		.slice(0, 6);
	const topScore = topNeighbors[0]?.[1] ?? 1;
	hoverNeighbors = topNeighbors
		.map(([id, score]) => ({
			id,
			score: score / topScore,
			kind: "similar" as const,
		}));

	hoverRelationLookup = new Map(
		hoverNeighbors.map((neighbor) => [neighbor.id, "similar" as const]),
	);
}

function buildHoverAdjacency(): void {
	const adjacency = new Map<string, Map<string, number>>();
	for (const edge of edges) {
		const leftId = getEdgeEndpointId(edge.source);
		const rightId = getEdgeEndpointId(edge.target);
		if (!leftId || !rightId || leftId === rightId) continue;

		const leftNeighbors = adjacency.get(leftId) ?? new Map<string, number>();
		leftNeighbors.set(rightId, (leftNeighbors.get(rightId) ?? 0) + 1);
		adjacency.set(leftId, leftNeighbors);

		const rightNeighbors = adjacency.get(rightId) ?? new Map<string, number>();
		rightNeighbors.set(leftId, (rightNeighbors.get(leftId) ?? 0) + 1);
		adjacency.set(rightId, rightNeighbors);
	}
	hoverAdjacency = adjacency;
}

const FILTER_PRESET_STORAGE_KEY = "signet-embeddings-filter-presets";

const builtinPresets: FilterPreset[] = [
	{
		id: "all",
		name: "All",
		search: "",
		sources: [],
		pinnedOnly: false,
		neighborhoodOnly: false,
		clusterLensMode: false,
	},
	{
		id: "pinned",
		name: "Pinned",
		search: "",
		sources: [],
		pinnedOnly: true,
		neighborhoodOnly: false,
		clusterLensMode: false,
	},
	{
		id: "focus",
		name: "Focus",
		search: "",
		sources: [],
		pinnedOnly: false,
		neighborhoodOnly: true,
		clusterLensMode: true,
	},
];

function currentPresetSnapshot(name: string, id: string): FilterPreset {
	return {
		id,
		name,
		search: embeddingSearch,
		sources: [...selectedSources],
		pinnedOnly: showPinnedOnly,
		neighborhoodOnly: showNeighborhoodOnly,
		clusterLensMode,
	};
}

function applyPreset(preset: FilterPreset): void {
	embeddingSearch = preset.search;
	selectedSources = new Set(preset.sources);
	showPinnedOnly = preset.pinnedOnly;
	showNeighborhoodOnly = preset.neighborhoodOnly;
	clusterLensMode = preset.clusterLensMode;
	activePresetId = preset.id;
}

function saveCurrentPreset(): void {
	if (typeof window === "undefined") return;
	const suggested = graphSelected
		? `Cluster: ${graphSelected.who ?? "source"}`
		: "Custom preset";
	const raw = window.prompt("Preset name", suggested);
	const name = raw?.trim();
	if (!name) return;
	const id = `custom-${Date.now()}`;
	const preset = currentPresetSnapshot(name, id);
	customPresets = [preset, ...customPresets].slice(0, 8);
	activePresetId = id;
}

function removeCustomPreset(id: string): void {
	customPresets = customPresets.filter((preset) => preset.id !== id);
	if (activePresetId === id) {
		activePresetId = "all";
	}
}

// Fix 4: coalesced refreshAppearance — batches rapid reactive updates
function scheduleRefresh3d(): void {
	if (graphMode !== "3d" || refresh3dQueued) return;
	refresh3dQueued = true;
	queueMicrotask(() => {
		refresh3dQueued = false;
		canvas3d?.refreshAppearance();
	});
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
		const maxPollAttempts = 30;

		while (projection.status === "computing") {
			if (loadId !== graphLoadId) return;
			pollAttempts++;
			if (pollAttempts >= maxPollAttempts) {
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

		let minX = Infinity;
		let maxX = -Infinity;
		let minY = Infinity;
		let maxY = -Infinity;
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
		nodeIdsByIndex = embeddings.map((embedding) => embedding.id);

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
		graphError = (error as Error).message || "Failed to load projection";
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
	relationLookup = new Map(similarNeighbors.map((item) => [item.id, item.kind]));
}

// -----------------------------------------------------------------------
// Actions
// -----------------------------------------------------------------------

function clearEmbeddingSelection(): void {
	graphSelected = null;
	graphHovered = null;
	hoverLockedId = null;
	globalSimilar = [];
	pinError = "";
}

function selectEmbeddingById(id: string): void {
	const next = embeddingById.get(id) ?? null;
	if (!next) return;
	hoverLockedId = null;
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

async function togglePinForSelected(): Promise<void> {
	if (!graphSelected || pinBusy) return;
	pinBusy = true;
	pinError = "";
	const id = graphSelected.id;
	const nextPinned = !(graphSelected.pinned ?? false);
	const result = await setMemoryPinned(id, nextPinned);
	if (!result.success) {
		pinError = result.error ?? "Failed to update pin state";
		pinBusy = false;
		return;
	}
	updateEmbeddingInState(id, (entry) => ({ ...entry, pinned: nextPinned }));
	if (graphMode === "3d") {
		canvas3d?.refreshAppearance();
	}
	pinBusy = false;
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
	hoverLockedId = null;
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
	nodeIdsByIndex = [];
	pinError = "";

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
	const rows = embeddings;
	pinnedIds = new Set(rows.filter((row) => row.pinned).map((row) => row.id));

	const counts = new Map<string, number>();
	for (const row of rows) {
		const key = row.who ?? "unknown";
		counts.set(key, (counts.get(key) ?? 0) + 1);
	}
	sourceCounts = [...counts.entries()]
		.sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
		.map(([who, count]) => ({ who, count }));

	if (selectedSources.size > 0) {
		const next = new Set(
			[...selectedSources].filter((who) => counts.has(who)),
		);
		if (next.size !== selectedSources.size) {
			selectedSources = next;
		}
	}
});

// Fix 5: debounce embeddingSearch into debouncedSearch
$effect(() => {
	const q = embeddingSearch;
	if (searchTimer !== null) clearTimeout(searchTimer);
	if (!q) {
		debouncedSearch = "";
		return;
	}
	searchTimer = setTimeout(() => {
		debouncedSearch = q;
	}, 180);
});

// Fix 5: use debouncedSearch for actual filtering
$effect(() => {
	const query = debouncedSearch.trim().toLowerCase();
	const rows = embeddings;
	if (!query) {
		searchFilterIds = null;
		embeddingSearchMatches = [];
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

	searchFilterIds = ids;
	embeddingSearchMatches = matches.slice(0, 50);
});

$effect(() => {
	const selected = selectedSources;
	if (selected.size === 0) {
		sourceFilterIds = null;
		return;
	}
	sourceFilterIds = new Set(
		embeddings
			.filter((row) => selected.has(row.who ?? "unknown"))
			.map((row) => row.id),
	);
});

$effect(() => {
	if (typeof window === "undefined" || presetsHydrated) return;
	try {
		const raw = window.localStorage.getItem(FILTER_PRESET_STORAGE_KEY);
		if (raw) {
			const parsed = JSON.parse(raw) as unknown;
			if (Array.isArray(parsed)) {
				const loaded = parsed.filter((entry): entry is FilterPreset => {
					if (typeof entry !== "object" || entry === null) return false;
					const candidate = entry as Record<string, unknown>;
					return (
						typeof candidate.id === "string" &&
						typeof candidate.name === "string" &&
						typeof candidate.search === "string" &&
						Array.isArray(candidate.sources) &&
						typeof candidate.pinnedOnly === "boolean" &&
						typeof candidate.neighborhoodOnly === "boolean" &&
						typeof candidate.clusterLensMode === "boolean"
					);
				});
				customPresets = loaded.slice(0, 8);
			}
		}
	} catch {
		customPresets = [];
	}
	presetsHydrated = true;
});

$effect(() => {
	if (typeof window === "undefined" || !presetsHydrated) return;
	window.localStorage.setItem(
		FILTER_PRESET_STORAGE_KEY,
		JSON.stringify(customPresets),
	);
});

$effect(() => {
	const ids = new Set<string>();
	if (clusterLensMode) {
		const seed = graphSelected ?? previewHovered;
		if (seed) {
			ids.add(seed.id);
			const neighborhood =
				graphSelected !== null ? activeNeighbors : hoverNeighbors;
			for (const neighbor of neighborhood) {
				ids.add(neighbor.id);
			}
		}
	}
	lensIds = ids;
});

// Fix 4: coalesced — these three effects fire often together
$effect(() => {
	clusterLensMode;
	lensIds;
	scheduleRefresh3d();
});

$effect(() => {
	nodeIdsByIndex;
	edges;
	buildHoverAdjacency();
});

$effect(() => {
	previewHovered;
	computeHoverNeighbors(previewHovered);
});

$effect(() => {
	const pinnedFilterIds =
		showPinnedOnly === true ? new Set(pinnedIds) : null;
	const neighborhoodFilterIds =
		showNeighborhoodOnly === true && graphSelected
			? new Set([graphSelected.id, ...activeNeighbors.map((n) => n.id)])
			: null;

	embeddingFilterIds = intersectFilterSets([
		searchFilterIds,
		sourceFilterIds,
		pinnedFilterIds,
		neighborhoodFilterIds,
	]);
	// Fix 4: coalesced
	scheduleRefresh3d();
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
	// Fix 4: coalesced
	scheduleRefresh3d();
});

const effectiveRelationLookup = $derived(
	graphSelected ? relationLookup : hoverRelationLookup,
);

const effectiveHoverNeighbors = $derived(
	graphSelected ? [] : hoverNeighbors,
);

const previewHovered = $derived(
	hoverLockedId ? (embeddingById.get(hoverLockedId) ?? null) : graphHovered,
);

$effect(() => {
	if (graphSelected && hoverLockedId) {
		hoverLockedId = null;
	}
});

$effect(() => {
	const lockedId = hoverLockedId;
	if (!lockedId) return;
	if (!embeddingById.has(lockedId)) {
		hoverLockedId = null;
	}
});

$effect(() => {
	if (typeof window === "undefined") return;
	const onKeyDown = (event: KeyboardEvent): void => {
		if (event.key === "Shift") {
			lockHoverPreview();
			return;
		}
		if (event.key === "Escape") {
			unlockHoverPreview();
		}
	};

	window.addEventListener("keydown", onKeyDown);
	return () => {
		window.removeEventListener("keydown", onKeyDown);
	};
});

$effect(() => {
	if (!graphInitialized) {
		initGraph();
	}
});

// Fix 1: cache graphRegion dimensions via ResizeObserver
$effect(() => {
	const el = graphRegion;
	if (!el) return;
	const updateRect = () => {
		const r = el.getBoundingClientRect();
		graphRegionRect = { left: r.left, top: r.top, width: r.width, height: r.height };
	};
	updateRect();
	const ro = new ResizeObserver(updateRect);
	ro.observe(el);
	window.addEventListener("scroll", updateRect, { passive: true });
	return () => {
		ro.disconnect();
		window.removeEventListener("scroll", updateRect);
	};
});

// Position the hover card as soon as it mounts (bind:this fires)
$effect(() => {
	if (hoverCardEl) positionHoverCard();
});
</script>

<div class="flex flex-1 min-h-0 bg-[#050505] max-lg:flex-col">
	<div
		bind:this={graphRegion}
		class="flex-1 relative overflow-hidden bg-[#050505]"
		role="presentation"
		onmousemove={handleGraphMouseMove}
		onmouseleave={() => {
			if (!hoverLockedId) graphHovered = null;
		}}
	>
		<div class="absolute top-2 left-3 right-3 z-[8] flex items-center gap-2 pointer-events-none">
			<input
				type="text"
				class="flex-1 max-w-[420px] pointer-events-auto font-[family-name:var(--font-mono)] text-[11px] text-[var(--sig-text-bright)] bg-[var(--sig-surface)] border border-[rgba(255,255,255,0.22)] px-[9px] py-[6px] outline-none"
				bind:value={embeddingSearch}
				oninput={() => (activePresetId = "custom-live")}
				placeholder="Filter embeddings (content, source, tags)..."
			/>
			{#if embeddingSearch}
				<span class="font-[family-name:var(--font-mono)] text-[10px] text-[rgba(220,220,220,0.75)] bg-[rgba(5,5,5,0.55)] border border-[rgba(255,255,255,0.16)] px-2 py-1">
					{embeddingSearchMatches.length} match{embeddingSearchMatches.length === 1 ? "" : "es"}
				</span>
			{/if}
			{#if embeddingsHasMore}
				<span class="font-[family-name:var(--font-mono)] text-[10px] text-[rgba(220,220,220,0.75)] bg-[rgba(5,5,5,0.55)] border border-[rgba(255,255,255,0.16)] px-2 py-1">
					showing latest {embeddings.length} of {embeddingsTotal}
				</span>
			{/if}
		</div>

		<div class="absolute top-[38px] left-3 right-3 z-[8] flex items-center gap-2 flex-wrap pointer-events-none">
			<div class="pointer-events-auto flex items-center gap-1 flex-wrap border border-[rgba(255,255,255,0.2)] bg-[rgba(5,5,5,0.6)] px-1.5 py-1">
				{#each builtinPresets as preset}
					<button
						class="px-2 py-[2px] font-[family-name:var(--font-mono)] text-[10px] uppercase border border-[rgba(255,255,255,0.18)] {activePresetId === preset.id ? 'text-[var(--sig-text-bright)] bg-[rgba(255,255,255,0.1)]' : 'text-[var(--sig-text-muted)] bg-transparent'}"
						onclick={() => applyPreset(preset)}
					>
						{preset.name}
					</button>
				{/each}
				{#each customPresets as preset}
					<div class="inline-flex items-center border border-[rgba(255,255,255,0.18)] bg-transparent">
						<button
							class="px-2 py-[2px] font-[family-name:var(--font-mono)] text-[10px] {activePresetId === preset.id ? 'text-[var(--sig-text-bright)] bg-[rgba(255,255,255,0.1)]' : 'text-[var(--sig-text-muted)] bg-transparent'}"
							onclick={() => applyPreset(preset)}
						>
							{preset.name}
						</button>
						<button
							class="px-1.5 py-[2px] font-[family-name:var(--font-mono)] text-[10px] text-[var(--sig-text-muted)] hover:text-[var(--sig-text-bright)]"
							onclick={() => removeCustomPreset(preset.id)}
							aria-label={`Delete ${preset.name} preset`}
						>
							×
						</button>
					</div>
				{/each}
				<button
					class="px-2 py-[2px] font-[family-name:var(--font-mono)] text-[10px] uppercase border border-[rgba(255,255,255,0.18)] text-[var(--sig-text-muted)] hover:text-[var(--sig-text-bright)]"
					onclick={saveCurrentPreset}
				>
					Save preset
				</button>
			</div>
		</div>

		<div class="absolute top-[66px] left-3 right-3 z-[8] flex items-center gap-2 flex-wrap pointer-events-none">
			<div class="pointer-events-auto flex items-center gap-1 border border-[rgba(255,255,255,0.2)] bg-[rgba(5,5,5,0.6)] px-1.5 py-1">
				<button
					class="px-2 py-[2px] font-[family-name:var(--font-mono)] text-[10px] uppercase border border-[rgba(255,255,255,0.18)] {showPinnedOnly ? 'text-[var(--sig-text-bright)] bg-[rgba(255,255,255,0.1)]' : 'text-[var(--sig-text-muted)] bg-transparent'}"
					onclick={() => {
						showPinnedOnly = !showPinnedOnly;
						activePresetId = "custom-live";
					}}
				>
					Pinned only ({pinnedIds.size})
				</button>
				<button
					class="px-2 py-[2px] font-[family-name:var(--font-mono)] text-[10px] uppercase border border-[rgba(255,255,255,0.18)] {showNeighborhoodOnly ? 'text-[var(--sig-text-bright)] bg-[rgba(255,255,255,0.1)]' : 'text-[var(--sig-text-muted)] bg-transparent'}"
					onclick={() => {
						showNeighborhoodOnly = !showNeighborhoodOnly;
						activePresetId = "custom-live";
					}}
					disabled={!graphSelected}
				>
					Neighborhood
				</button>
				<button
					class="px-2 py-[2px] font-[family-name:var(--font-mono)] text-[10px] uppercase border border-[rgba(255,255,255,0.18)] {clusterLensMode ? 'text-[var(--sig-text-bright)] bg-[rgba(255,255,255,0.1)]' : 'text-[var(--sig-text-muted)] bg-transparent'}"
					onclick={() => {
						clusterLensMode = !clusterLensMode;
						activePresetId = "custom-live";
					}}
					disabled={!graphSelected && !previewHovered}
				>
					Cluster lens
				</button>
			</div>
			<div class="pointer-events-auto flex items-center gap-1 flex-wrap border border-[rgba(255,255,255,0.2)] bg-[rgba(5,5,5,0.6)] px-1.5 py-1 max-w-[calc(100%-300px)]">
				{#if sourceCounts.length === 0}
					<span class="font-[family-name:var(--font-mono)] text-[10px] text-[var(--sig-text-muted)] uppercase">No sources</span>
				{:else}
					{#each sourceCounts as source}
						<button
							class="px-2 py-[2px] font-[family-name:var(--font-mono)] text-[10px] border border-[rgba(255,255,255,0.18)] {selectedSources.has(source.who) ? 'text-[var(--sig-text-bright)] bg-[rgba(255,255,255,0.1)]' : 'text-[var(--sig-text-muted)] bg-transparent'}"
							onclick={() => {
								toggleSource(source.who);
								activePresetId = "custom-live";
							}}
						>
							{source.who} {source.count}
						</button>
					{/each}
				{/if}
			</div>
		</div>
		{#if hoverLockedId}
			<div class="absolute top-[96px] right-3 z-[9] pointer-events-none">
				<button
					type="button"
					class="pointer-events-auto px-2 py-[2px] font-[family-name:var(--font-mono)] text-[10px] uppercase border border-[var(--sig-text-bright)] text-[var(--sig-text-bright)] bg-[rgba(5,5,5,0.74)] hover:bg-[var(--sig-text-bright)] hover:text-[var(--sig-bg)]"
					onclick={unlockHoverPreview}
				>
					Unlock preview
				</button>
			</div>
		{/if}

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
			class="absolute left-[14px] top-[100px] z-[6] font-[family-name:var(--font-mono)] text-[10px] text-[var(--sig-text-muted)] tracking-[0.08em] uppercase pointer-events-none"
			aria-hidden="true"
		>:: &#9675; &#9675; 01 10 11 // latent topology</div>

		<div class="absolute inset-0 pointer-events-none z-[5]" aria-hidden="true">
			<span class="absolute top-[10px] left-[10px] w-[14px] h-[14px] border-[rgba(255,255,255,0.22)]" style="border-style:solid;border-width:1px 0 0 1px"></span>
			<span class="absolute top-[10px] right-[10px] w-[14px] h-[14px] border-[rgba(255,255,255,0.22)]" style="border-style:solid;border-width:1px 1px 0 0"></span>
			<span class="absolute bottom-[10px] left-[10px] w-[14px] h-[14px] border-[rgba(255,255,255,0.22)]" style="border-style:solid;border-width:0 0 1px 1px"></span>
			<span class="absolute bottom-[10px] right-[10px] w-[14px] h-[14px] border-[rgba(255,255,255,0.22)]" style="border-style:solid;border-width:0 1px 1px 0"></span>
		</div>

		{#if previewHovered}
			<!-- Fix 1: position via imperative DOM transform; bind:this for direct style mutation -->
			<div
				bind:this={hoverCardEl}
				class="absolute z-[9] w-[320px] pointer-events-none border border-[rgba(255,255,255,0.26)] bg-[rgba(5,5,5,0.92)] px-2 py-2"
				style="position:absolute;top:0;left:0;will-change:transform;"
			>
				<div class="flex items-center gap-1.5 flex-wrap mb-1.5">
					<span class="font-[family-name:var(--font-mono)] text-[10px] text-[var(--sig-text)] border border-[var(--sig-border-strong)] px-1.5 py-[1px] bg-[rgba(255,255,255,0.04)]">{previewHovered.who ?? "unknown"}</span>
					{#if previewHovered.type}
						<span class="font-[family-name:var(--font-mono)] text-[10px] text-[var(--sig-text)] border border-[var(--sig-border-strong)] px-1.5 py-[1px] bg-[rgba(255,255,255,0.04)]">{previewHovered.type}</span>
					{/if}
					{#if previewHovered.pinned}
						<span class="font-[family-name:var(--font-mono)] text-[10px] text-[var(--sig-text-bright)] border border-[var(--sig-text-bright)] px-1.5 py-[1px] bg-[rgba(255,255,255,0.08)]">pinned</span>
					{/if}
					{#if hoverLockedId}
						<span class="font-[family-name:var(--font-mono)] text-[10px] text-[var(--sig-text-bright)] border border-[var(--sig-text-bright)] px-1.5 py-[1px] bg-[rgba(255,255,255,0.08)]">locked</span>
					{/if}
				</div>
				<div class="font-[family-name:var(--font-mono)] text-[10px] text-[var(--sig-text-muted)] mb-1.5">
					importance {Math.round((previewHovered.importance ?? 0) * 100)}% · {formatShortDate(previewHovered.createdAt)} · linked {effectiveHoverNeighbors.length}
				</div>
				<p class="m-0 text-[12px] leading-[1.45] text-[var(--sig-text-bright)] line-clamp-3">
					{embeddingLabel(previewHovered)}
				</p>
				<div class="mt-1 text-[10px] text-[var(--sig-text-muted)]">
					{hoverLockedId ? "ESC or Unlock Preview button" : "Hold Shift to lock preview"}
				</div>
				{#if effectiveHoverNeighbors.length > 0}
					<div class="mt-2 pt-2 border-t border-[rgba(255,255,255,0.14)]">
						<div class="font-[family-name:var(--font-mono)] text-[10px] text-[var(--sig-text-muted)] uppercase tracking-[0.06em] mb-1">Local neighbors</div>
						<div class="space-y-1">
							{#each effectiveHoverNeighbors as relation}
								{@const item = embeddingById.get(relation.id)}
								{#if item}
									<div class="grid grid-cols-[1fr_auto] items-start gap-2 border border-[rgba(255,255,255,0.14)] bg-[rgba(255,255,255,0.02)] px-1.5 py-1">
										<span class="text-[10px] leading-[1.35] text-[var(--sig-text)] line-clamp-1">{embeddingLabel(item)}</span>
										<span class="text-[10px] text-[var(--sig-text-muted)]">{Math.round(relation.score * 100)}%</span>
									</div>
								{/if}
							{/each}
						</div>
					</div>
				{/if}
			</div>
		{/if}

		<div style:display={graphMode === "2d" ? "contents" : "none"}>
			<EmbeddingCanvas2D
				bind:this={canvas2d}
				{nodes}
				{edges}
				{graphSelected}
				graphHovered={previewHovered}
				{embeddingFilterIds}
				relationLookup={effectiveRelationLookup}
				{pinnedIds}
				{lensIds}
				clusterLensMode={clusterLensMode && lensIds.size > 0}
				onselectnode={(e) => {
					if (e) selectEmbeddingById(e.id);
					else graphSelected = null;
				}}
				onhovernode={updateGraphHover}
			/>
		</div>
		<div style:display={graphMode === "3d" ? "contents" : "none"}>
			<EmbeddingCanvas3D
				bind:this={canvas3d}
				{embeddings}
				projected3d={projected3dCoords}
				{graphSelected}
				{embeddingFilterIds}
				relationLookup={effectiveRelationLookup}
				{pinnedIds}
				{lensIds}
				clusterLensMode={clusterLensMode && lensIds.size > 0}
				{embeddingById}
				onselectnode={(e) => {
					if (e) selectEmbeddingById(e.id);
					else graphSelected = null;
				}}
				onhovernode={updateGraphHover}
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
		{pinBusy}
		{pinError}
		onselectembedding={selectEmbeddingById}
		onclearselection={clearEmbeddingSelection}
		onloadglobalsimilar={loadGlobalSimilarForSelected}
		{onopenglobalsimilar}
		onsetrelationmode={(mode) => (relationMode = mode)}
		onfocusembedding={() => graphSelected && focusEmbedding(graphSelected.id)}
		onpintoggle={togglePinForSelected}
	/>
</div>

<script lang="ts">
import { tick } from "svelte";
import { onMount } from "svelte";
import {
	getProjection,
	getSimilarMemories,
	setMemoryPinned,
	getEmbeddingHealth,
	repairCleanOrphans,
	repairReEmbed,
	getDistinctWho,
	type Memory,
	type EmbeddingPoint,
	type ProjectionNode,
	type EmbeddingHealthReport,
	type EmbeddingCheckResult,
	type ProjectionQueryOptions,
} from "$lib/api";
import { mem } from "$lib/stores/memory.svelte";
import { ActionLabels } from "$lib/ui/action-labels";
import { workspaceLayout, syncLayoutToStorage } from "$lib/stores/workspace-layout.svelte";
import EmbeddingCanvas2D from "../embeddings/EmbeddingCanvas2D.svelte";
import EmbeddingCanvas3D from "../embeddings/EmbeddingCanvas3D.svelte";
import EmbeddingInspector from "../embeddings/EmbeddingInspector.svelte";
import * as Collapsible from "$lib/components/ui/collapsible/index.js";
import ChevronDown from "@lucide/svelte/icons/chevron-down";
import {
	type RelationKind,
	type EmbeddingRelation,
	type GraphNode,
	type GraphEdge,
	sourceColorRgba,
	embeddingLabel,
	DEFAULT_EMBEDDING_LIMIT,
	MAX_EMBEDDING_LIMIT,
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
let debouncedSearch = $state("");
let searchDebounceTimer = 0;
let embeddingSearchMatches = $state<EmbeddingPoint[]>([]);
let embeddingFilterIds = $state<Set<string> | null>(null);
let searchFilterIds = $state<Set<string> | null>(null);
let sourceFilterIds = $state<Set<string> | null>(null);
let selectedSources = $state<Set<string>>(new Set());
let sourceCounts = $state<Array<{ who: string; count: number }>>([]);
let showPinnedOnly = $state(false);
let showNeighborhoodOnly = $state(true);
let pinnedIds = $state<Set<string>>(new Set());
let pinBusy = $state(false);
let pinError = $state("");
let clusterLensMode = $state(true);
let lensIds = $state<Set<string>>(new Set());
let activePresetId = $state("focus");
let customPresets = $state<FilterPreset[]>([]);
let presetsHydrated = $state(false);
let showAdvancedFilters = $state(false);
let controlsMenuOpen = $state(true);
let presetsMenuOpen = $state(false);
let sourcesMenuOpen = $state(true);

const LEGEND_PRIORITY_SOURCES = ["daemon", "user", "opencode"] as const;
const LEGEND_PRIORITY_SOURCE_SET = new Set<string>(LEGEND_PRIORITY_SOURCES);

type TimeFilterPreset = "all" | "24h" | "7d" | "30d" | "90d" | "custom";

let projectionRangeMin = $state(0);
let projectionRangeMax = $state(DEFAULT_EMBEDDING_LIMIT);
let projectionTimePreset = $state<TimeFilterPreset>("all");
let projectionTimeAnchorMs = $state(Date.now());
let projectionSinceDate = $state("");
let projectionUntilDate = $state("");
let projectionSearch = $state("");
let projectionTagFilter = $state("");
let projectionPinnedFilter = $state<"all" | "pinned" | "unpinned">("all");
let projectionImportanceMin = $state("");
let projectionImportanceMax = $state("");
let harnessOptions = $state<string[]>([]);
let selectedHarnesses = $state<Set<string>>(new Set());
let typeCounts = $state<Array<{ value: string; count: number }>>([]);
let sourceTypeCounts = $state<Array<{ value: string; count: number }>>([]);
let selectedServerTypes = $state<Set<string>>(new Set());
let selectedServerSourceTypes = $state<Set<string>>(new Set());
let lastAppliedProjectionKey = $state("");
let projectionReloadTimer = 0;

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
let hoverLockedId = $state<string | null>(null);

let graphRegion = $state<HTMLDivElement | null>(null);
let hoverCardEl = $state<HTMLDivElement | null>(null);
let hoverX = 0;
let hoverY = 0;
let cachedRegionRect: DOMRect | null = null;

let canvas2d = $state<EmbeddingCanvas2D | null>(null);
let canvas3d = $state<EmbeddingCanvas3D | null>(null);

let healthReport = $state<EmbeddingHealthReport | null>(null);
let healthExpanded = $state(false);
let healthFixBusy = $state(false);
let healthTimer: ReturnType<typeof setInterval> | undefined;

onMount(() => {
	controlsMenuOpen = workspaceLayout.embeddings.controlsOpen;
	presetsMenuOpen = workspaceLayout.embeddings.presetsOpen;
	sourcesMenuOpen = workspaceLayout.embeddings.sourcesOpen;
});

async function fetchHealth(): Promise<void> {
	healthReport = await getEmbeddingHealth();
}

async function runFix(check: EmbeddingCheckResult): Promise<void> {
	if (healthFixBusy) return;
	healthFixBusy = true;
	try {
		if (check.name === "orphaned-embeddings") {
			await repairCleanOrphans();
		} else if (check.name === "coverage" || check.name === "null-vectors") {
			await repairReEmbed();
		}
		await fetchHealth();
	} finally {
		healthFixBusy = false;
	}
}

function healthDotColor(status: "healthy" | "degraded" | "unhealthy"): string {
	if (status === "healthy") return "#4a7a5e";
	if (status === "degraded") return "#c4a24a";
	return "#8a4a48";
}

function checkDotColor(status: "ok" | "warn" | "fail"): string {
	if (status === "ok") return "#4a7a5e";
	if (status === "warn") return "#c4a24a";
	return "#8a4a48";
}

$effect(() => {
	fetchHealth();
	healthTimer = setInterval(fetchHealth, 60000);
	return () => {
		if (healthTimer) clearInterval(healthTimer);
	};
});

let refresh3dQueued = false;
function scheduleRefresh3d(): void {
	if (refresh3dQueued) return;
	refresh3dQueued = true;
	queueMicrotask(() => {
		refresh3dQueued = false;
		if (graphMode === "3d") canvas3d?.refreshAppearance();
	});
}

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

function normalizeProjectionWindow(): { offset: number; limit: number } {
	const offset = Number.isFinite(projectionRangeMin)
		? Math.max(0, Math.trunc(projectionRangeMin))
		: 0;
	const requestedMax = Number.isFinite(projectionRangeMax)
		? Math.max(1, Math.trunc(projectionRangeMax))
		: DEFAULT_EMBEDDING_LIMIT;
	const maxExclusive = Math.max(
		offset + 1,
		Math.min(requestedMax, offset + MAX_EMBEDDING_LIMIT),
	);
	return { offset, limit: maxExclusive - offset };
}

function syncProjectionWindowInputs(): void {
	const { offset, limit } = normalizeProjectionWindow();
	projectionRangeMin = offset;
	projectionRangeMax = offset + limit;
}

function parseLocalDateToIso(
	dateValue: string,
	endOfDay: boolean,
): string | undefined {
	const trimmed = dateValue.trim();
	if (!trimmed) return undefined;
	const suffix = endOfDay ? "T23:59:59.999" : "T00:00:00.000";
	const localDate = new Date(`${trimmed}${suffix}`);
	if (Number.isNaN(localDate.getTime())) return undefined;
	return localDate.toISOString();
}

function parseImportanceBound(raw: string): number | undefined {
	const trimmed = raw.trim();
	if (!trimmed) return undefined;
	const parsed = Number.parseFloat(trimmed);
	if (!Number.isFinite(parsed)) return undefined;
	return Math.min(1, Math.max(0, parsed));
}

function timePresetSinceIso(
	preset: TimeFilterPreset,
	anchorMs: number,
): string | undefined {
	if (preset === "all" || preset === "custom") return undefined;
	const spanMs =
		preset === "24h"
			? 24 * 60 * 60 * 1000
			: preset === "7d"
				? 7 * 24 * 60 * 60 * 1000
				: preset === "30d"
					? 30 * 24 * 60 * 60 * 1000
					: 90 * 24 * 60 * 60 * 1000;
	return new Date(anchorMs - spanMs).toISOString();
}

function buildProjectionQueryOptions(): ProjectionQueryOptions {
	const { offset, limit } = normalizeProjectionWindow();
	const options: ProjectionQueryOptions = { offset, limit };
	const search = projectionSearch.trim();
	if (search.length > 0) options.q = search;

	const harnesses = [...selectedHarnesses];
	if (harnesses.length > 0) options.who = harnesses;
	const types = [...selectedServerTypes];
	if (types.length > 0) options.types = types;
	const sourceTypes = [...selectedServerSourceTypes];
	if (sourceTypes.length > 0) options.sourceTypes = sourceTypes;

	const tags = projectionTagFilter
		.split(",")
		.map((tag) => tag.trim())
		.filter((tag) => tag.length > 0);
	if (tags.length > 0) options.tags = tags;

	if (projectionPinnedFilter === "pinned") options.pinned = true;
	if (projectionPinnedFilter === "unpinned") options.pinned = false;

	let since: string | undefined;
	let until: string | undefined;
	if (projectionTimePreset === "custom") {
		since = parseLocalDateToIso(projectionSinceDate, false);
		until = parseLocalDateToIso(projectionUntilDate, true);
	} else {
		since = timePresetSinceIso(projectionTimePreset, projectionTimeAnchorMs);
	}
	if (since) options.since = since;
	if (until) options.until = until;

	let importanceMin = parseImportanceBound(projectionImportanceMin);
	let importanceMax = parseImportanceBound(projectionImportanceMax);
	if (
		typeof importanceMin === "number" &&
		typeof importanceMax === "number" &&
		importanceMin > importanceMax
	) {
		const swap = importanceMin;
		importanceMin = importanceMax;
		importanceMax = swap;
	}
	if (typeof importanceMin === "number") options.importanceMin = importanceMin;
	if (typeof importanceMax === "number") options.importanceMax = importanceMax;

	return options;
}

function projectionQueryKey(options: ProjectionQueryOptions): string {
	return JSON.stringify({
		offset: options.offset ?? 0,
		limit: options.limit ?? DEFAULT_EMBEDDING_LIMIT,
		q: options.q ?? "",
		who: [...(options.who ?? [])].sort(),
		types: [...(options.types ?? [])].sort(),
		sourceTypes: [...(options.sourceTypes ?? [])].sort(),
		tags: [...(options.tags ?? [])].sort(),
		pinned: options.pinned ?? "all",
		since: options.since ?? "",
		until: options.until ?? "",
		importanceMin:
			typeof options.importanceMin === "number" ? options.importanceMin : "",
		importanceMax:
			typeof options.importanceMax === "number" ? options.importanceMax : "",
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

function updateEmbeddingInState(
	id: string,
	patch: (entry: EmbeddingPoint) => EmbeddingPoint,
): void {
	embeddings = embeddings.map((entry) =>
		entry.id === id ? patch(entry) : entry,
	);
	embeddingById = new Map(embeddings.map((entry) => [entry.id, entry]));
	nodes = nodes.map((node) =>
		node.data.id === id ? { ...node, data: patch(node.data) } : node,
	);
	if (graphSelected?.id === id) {
		const next = embeddingById.get(id) ?? null;
		graphSelected = next;
	}
	if (graphHovered?.id === id) {
		const next = embeddingById.get(id) ?? null;
		graphHovered = next;
	}
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

function toggleHarness(who: string): void {
	const next = new Set(selectedHarnesses);
	if (next.has(who)) {
		next.delete(who);
	} else {
		next.add(who);
	}
	selectedHarnesses = next;
}

function toggleServerType(value: string): void {
	const next = new Set(selectedServerTypes);
	if (next.has(value)) {
		next.delete(value);
	} else {
		next.add(value);
	}
	selectedServerTypes = next;
}

function toggleServerSourceType(value: string): void {
	const next = new Set(selectedServerSourceTypes);
	if (next.has(value)) {
		next.delete(value);
	} else {
		next.add(value);
	}
	selectedServerSourceTypes = next;
}

function resetProjectionFilters(): void {
	projectionRangeMin = 0;
	projectionRangeMax = DEFAULT_EMBEDDING_LIMIT;
	projectionTimePreset = "all";
	projectionSinceDate = "";
	projectionUntilDate = "";
	projectionSearch = "";
	projectionTagFilter = "";
	projectionPinnedFilter = "all";
	projectionImportanceMin = "";
	projectionImportanceMax = "";
	selectedHarnesses = new Set();
	selectedServerTypes = new Set();
	selectedServerSourceTypes = new Set();
	syncProjectionWindowInputs();
}

function togglePinnedOnly(): void {
	showPinnedOnly = !showPinnedOnly;
	activePresetId = "custom-live";
}

function ensureConstellationSeed(): EmbeddingPoint | null {
	if (graphSelected) return graphSelected;
	if (previewHovered) {
		graphSelected = previewHovered;
		return previewHovered;
	}
	const fallback = embeddings[0] ?? null;
	if (fallback) {
		graphSelected = fallback;
	}
	return fallback;
}

function toggleNeighborhoodOnly(): void {
	if (!showNeighborhoodOnly) {
		const seed = ensureConstellationSeed();
		if (!seed) return;
	}
	showNeighborhoodOnly = !showNeighborhoodOnly;
	activePresetId = "custom-live";
}

function toggleClusterLens(): void {
	if (!clusterLensMode) {
		const seed = ensureConstellationSeed();
		if (!seed) return;
	}
	clusterLensMode = !clusterLensMode;
	activePresetId = "custom-live";
}

function toggleSourceFromPanel(who: string): void {
	toggleSource(who);
	activePresetId = "custom-live";
}

function positionHoverCard(): void {
	if (!hoverCardEl || !cachedRegionRect) return;
	const maxX = Math.max(12, cachedRegionRect.width - 334);
	const maxY = Math.max(12, cachedRegionRect.height - 170);
	const left = Math.min(Math.max(12, hoverX + 14), maxX);
	const top = Math.min(Math.max(12, hoverY + 14), maxY);
	hoverCardEl.style.transform = `translate3d(${left}px, ${top}px, 0)`;
}

function handleGraphMouseMove(event: MouseEvent): void {
	if (!cachedRegionRect) return;
	hoverX = event.clientX - cachedRegionRect.left;
	hoverY = event.clientY - cachedRegionRect.top;
	positionHoverCard();
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

// -----------------------------------------------------------------------
// Graph initialization
// -----------------------------------------------------------------------

async function initGraph(): Promise<void> {
	if (graphInitialized) return;
	graphInitialized = true;
	graphError = "";
	graphStatus = "Loading projection...";
	const loadId = ++graphLoadId;
	const requestOptions = buildProjectionQueryOptions();
	const requestKey = projectionQueryKey(requestOptions);

	try {
		let projection = await getProjection(2, requestOptions);
		let pollAttempts = 0;
		const maxPollAttempts = 30;

		while (projection.status === "computing") {
			if (loadId !== graphLoadId) return;
			pollAttempts++;
			if (pollAttempts >= maxPollAttempts) {
				graphError = "Projection timed out after 60s. Try refreshing.";
				lastAppliedProjectionKey = requestKey;
				return;
			}
			graphStatus = "Computing layout...";
			await new Promise<void>((resolve) => setTimeout(resolve, 2000));
			projection = await getProjection(2, requestOptions);
		}

		if (projection.status === "error") {
			graphError = projection.message ?? "Projection computation failed";
			lastAppliedProjectionKey = requestKey;
			return;
		}

		if (loadId !== graphLoadId) return;

		const projNodes = projection.nodes ?? [];

		embeddings = projNodes.map(projectionNodeToEmbeddingPoint);
		embeddingsTotal = projection.total ?? projNodes.length;
		embeddingsHasMore = Boolean(
			projection.hasMore ??
				(projection.count ?? projNodes.length) <
					(projection.total ?? projNodes.length),
		);
		lastAppliedProjectionKey = requestKey;
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
		const scale = 560;

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
		lastAppliedProjectionKey = requestKey;
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
	hoverLockedId = null;
	globalSimilar = [];
	pinError = "";
}

function selectEmbeddingById(id: string): void {
	const next = embeddingById.get(id) ?? null;
	if (!next) return;
	hoverLockedId = null;
	graphSelected = next;
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
		const requestOptions = buildProjectionQueryOptions();
		let projection = await getProjection(3, requestOptions);

		while (projection.status === "computing") {
			if (loadId !== graphLoadId) return;
			await new Promise<void>((resolve) => setTimeout(resolve, 2000));
			projection = await getProjection(3, requestOptions);
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
	const typeMap = new Map<string, number>();
	const sourceTypeMap = new Map<string, number>();
	for (const row of rows) {
		const key = row.who ?? "unknown";
		counts.set(key, (counts.get(key) ?? 0) + 1);
		if (typeof row.type === "string" && row.type.length > 0) {
			typeMap.set(row.type, (typeMap.get(row.type) ?? 0) + 1);
		}
		const sourceType = row.sourceType ?? "memory";
		sourceTypeMap.set(
			sourceType,
			(sourceTypeMap.get(sourceType) ?? 0) + 1,
		);
	}
	sourceCounts = [...counts.entries()]
		.sort(
			(left, right) => right[1] - left[1] || left[0].localeCompare(right[0]),
		)
		.map(([who, count]) => ({ who, count }));
	typeCounts = [...typeMap.entries()]
		.sort(
			(left, right) => right[1] - left[1] || left[0].localeCompare(right[0]),
		)
		.map(([value, count]) => ({ value, count }));
	sourceTypeCounts = [...sourceTypeMap.entries()]
		.sort(
			(left, right) => right[1] - left[1] || left[0].localeCompare(right[0]),
		)
		.map(([value, count]) => ({ value, count }));

	if (selectedSources.size > 0) {
		const next = new Set([...selectedSources].filter((who) => counts.has(who)));
		if (next.size !== selectedSources.size) {
			selectedSources = next;
		}
	}
});

$effect(() => {
	let cancelled = false;
	void (async () => {
		const values = await getDistinctWho();
		if (cancelled) return;
		harnessOptions = values.filter((value) => value.trim().length > 0);
	})();
	return () => {
		cancelled = true;
	};
});

$effect(() => {
	if (selectedHarnesses.size === 0 || harnessOptions.length === 0) return;
	const available = new Set(harnessOptions);
	const next = new Set(
		[...selectedHarnesses].filter((value) => available.has(value)),
	);
	if (next.size !== selectedHarnesses.size) {
		selectedHarnesses = next;
	}
});

$effect(() => {
	const preset = projectionTimePreset;
	if (preset === "all" || preset === "custom") return;
	projectionTimeAnchorMs = Date.now();
});

$effect(() => {
	const raw = embeddingSearch;
	if (!raw.trim()) {
		clearTimeout(searchDebounceTimer);
		debouncedSearch = "";
		searchFilterIds = null;
		embeddingSearchMatches = [];
		return;
	}
	const timer = window.setTimeout(() => {
		debouncedSearch = raw;
	}, 180);
	searchDebounceTimer = timer;
	return () => clearTimeout(timer);
});

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

$effect(() => {
	clusterLensMode;
	lensIds;
	scheduleRefresh3d();
});

const projectionRequestKey = $derived(
	projectionQueryKey(buildProjectionQueryOptions()),
);

$effect(() => {
	const nextKey = projectionRequestKey;
	if (!graphInitialized) return;
	if (graphStatus.length > 0) return;
	if (nextKey === lastAppliedProjectionKey) return;

	clearTimeout(projectionReloadTimer);
	const timer = window.setTimeout(() => {
		void reloadEmbeddingsGraph();
	}, 220);
	projectionReloadTimer = timer;
	return () => clearTimeout(timer);
});


$effect(() => {
	const pinnedFilterIds = showPinnedOnly === true ? new Set(pinnedIds) : null;
	const neighborhoodSeed = graphSelected ?? previewHovered;
	const neighborhoodNeighbors = graphSelected ? activeNeighbors : hoverNeighbors;
	const neighborhoodFilterIds =
		showNeighborhoodOnly === true && neighborhoodSeed
			? new Set([
					neighborhoodSeed.id,
					...neighborhoodNeighbors.map((n) => n.id),
				])
			: null;

	embeddingFilterIds = intersectFilterSets([
		searchFilterIds,
		sourceFilterIds,
		pinnedFilterIds,
		neighborhoodFilterIds,
	]);
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
	scheduleRefresh3d();
});

const previewHovered = $derived(
	hoverLockedId ? (embeddingById.get(hoverLockedId) ?? null) : graphHovered,
);

const activeProjectionWindow = $derived(normalizeProjectionWindow());

const hoverAdjacency = $derived.by(() => {
	const ids = nodeIdsByIndex;
	const edgeList = edges;
	const adjacency = new Map<string, Map<string, number>>();
	for (const edge of edgeList) {
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
	return adjacency;
});

const hoverNeighbors: EmbeddingRelation[] = $derived.by(() => {
	const hovered = previewHovered;
	if (!hovered) return [];
	const ranked = hoverAdjacency.get(hovered.id);
	if (!ranked || ranked.size === 0) return [];
	const topNeighbors = [...ranked.entries()]
		.sort((l, r) => r[1] - l[1])
		.slice(0, 6);
	const topScore = topNeighbors[0]?.[1] ?? 1;
	return topNeighbors.map(([id, score]) => ({
		id,
		score: score / topScore,
		kind: "similar" as const,
	}));
});

const hoverRelationLookup = $derived(
	new Map(hoverNeighbors.map((n) => [n.id, "similar" as const])),
);

const effectiveRelationLookup = $derived(
	graphSelected ? relationLookup : hoverRelationLookup,
);

const effectiveHoverNeighbors = $derived(graphSelected ? [] : hoverNeighbors);

const legendSourceCounts = $derived.by(() => {
	const byName = new Map(sourceCounts.map((entry) => [entry.who, entry]));
	const prioritized = LEGEND_PRIORITY_SOURCES.map((name) => byName.get(name)).filter(
		(entry): entry is { who: string; count: number } => Boolean(entry),
	);
	const rest = sourceCounts.filter(
		(entry) => !LEGEND_PRIORITY_SOURCE_SET.has(entry.who),
	);
	return [...prioritized, ...rest].slice(0, 8);
});

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
	const el = graphRegion;
	if (!el) return;
	cachedRegionRect = el.getBoundingClientRect();
	const ro = new ResizeObserver(() => {
		cachedRegionRect = el.getBoundingClientRect();
	});
	ro.observe(el);
	return () => ro.disconnect();
});

$effect(() => {
	const el = hoverCardEl;
	if (el) positionHoverCard();
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

$effect(() => {
	workspaceLayout.embeddings.controlsOpen = controlsMenuOpen;
	syncLayoutToStorage();
});

$effect(() => {
	workspaceLayout.embeddings.presetsOpen = presetsMenuOpen;
	syncLayoutToStorage();
});

$effect(() => {
	workspaceLayout.embeddings.sourcesOpen = sourcesMenuOpen;
	syncLayoutToStorage();
});
</script>

<div class="flex h-full flex-col overflow-hidden">
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

		{#if hoverLockedId}
			<div
				class="absolute right-3 z-[9] pointer-events-none"
				style:top="52px"
			>
				<button
					type="button"
					class="pointer-events-auto px-2 py-[2px] font-[family-name:var(--font-mono)] text-[10px] uppercase border border-[var(--sig-text-bright)] text-[var(--sig-text-bright)] bg-[rgba(5,5,5,0.74)] hover:bg-[var(--sig-text-bright)] hover:text-[var(--sig-bg)]"
					onclick={unlockHoverPreview}
				>
					{ActionLabels.Unlock} preview
				</button>
			</div>
		{/if}

		{#if healthReport}
			<div class="absolute top-2 right-3 z-[8] pointer-events-none">
				<div class="pointer-events-auto">
					<button
						type="button"
						class="flex items-center gap-1.5 px-2 py-[4px] font-[family-name:var(--font-mono)] text-[10px] uppercase border border-[rgba(255,255,255,0.22)] bg-[rgba(5,5,5,0.75)] text-[var(--sig-text-muted)] hover:text-[var(--sig-text-bright)]"
						onclick={() => (healthExpanded = !healthExpanded)}
					>
						<span
							class="inline-block w-[7px] h-[7px] rounded-full shrink-0"
							style="background:{healthDotColor(healthReport.status)}"
						></span>
						{healthReport.status}
						<span class="text-[var(--sig-text-muted)]">{Math.round(healthReport.score * 100)}%</span>
					</button>
					{#if healthExpanded}
						<div class="mt-1 border border-[rgba(255,255,255,0.22)] bg-[rgba(5,5,5,0.92)] px-2 py-2 w-[320px]">
							<div class="flex items-center justify-between mb-2">
								<span class="font-[family-name:var(--font-mono)] text-[10px] text-[var(--sig-text-muted)] uppercase tracking-[0.06em]">Constellation Health</span>
								<span class="font-[family-name:var(--font-mono)] text-[10px] text-[var(--sig-text-muted)]">{healthReport.config.provider}/{healthReport.config.model}</span>
							</div>
							<div class="space-y-1">
								{#each healthReport.checks as check}
									<div class="flex items-start gap-1.5 px-1.5 py-1 border border-[rgba(255,255,255,0.1)] bg-[rgba(255,255,255,0.02)]">
										<span
											class="inline-block w-[6px] h-[6px] rounded-full shrink-0 mt-[4px]"
											style="background:{checkDotColor(check.status)}"
										></span>
										<div class="flex-1 min-w-0">
											<div class="flex items-center justify-between gap-2">
												<span class="font-[family-name:var(--font-mono)] text-[10px] text-[var(--sig-text)]">{check.name}</span>
												<span class="font-[family-name:var(--font-mono)] text-[9px] text-[var(--sig-text-muted)] uppercase">{check.status}</span>
											</div>
											<div class="font-[family-name:var(--font-mono)] text-[9px] text-[var(--sig-text-muted)] leading-[1.3] mt-0.5">{check.message}</div>
											{#if check.fix && check.status !== "ok"}
												<button
													type="button"
													class="mt-1 font-[family-name:var(--font-mono)] text-[9px] text-[#c4a24a] hover:text-[var(--sig-text-bright)] underline underline-offset-2 disabled:opacity-40 disabled:no-underline"
													disabled={healthFixBusy}
													onclick={() => runFix(check)}
												>
													{healthFixBusy ? "running..." : check.fix}
												</button>
											{/if}
										</div>
									</div>
								{/each}
							</div>
						</div>
					{/if}
				</div>
			</div>
		{/if}

		<div class="absolute left-3 bottom-3 z-[8] pointer-events-none space-y-2 max-w-[320px]">
			<div class="pointer-events-auto border border-[rgba(255,255,255,0.2)] bg-[rgba(5,5,5,0.72)] px-2 py-1.5">
				<div class="text-[10px] font-[family-name:var(--font-mono)] uppercase tracking-[0.06em] text-[var(--sig-text-muted)] mb-1">Legend</div>
				<div class="text-[10px] text-[var(--sig-text-muted)] leading-[1.35] mb-1">
					<span class="text-[var(--sig-text)]">Color</span> = source
				</div>
				<div class="flex flex-wrap gap-1 mb-1.5">
					{#each legendSourceCounts as source}
						<span class="h-5 inline-flex items-center gap-1 px-1.5 py-0 font-[family-name:var(--font-mono)] text-[10px] border border-[rgba(255,255,255,0.14)] {selectedSources.size === 0 || selectedSources.has(source.who) ? 'bg-[rgba(255,255,255,0.08)] text-[var(--sig-text-bright)]' : 'bg-transparent text-[var(--sig-text-muted)]'}">
							<span class="inline-block w-[6px] h-[6px] rounded-full" style={`background:${sourceColorRgba(source.who, 1)}`}></span>
							{source.who} {source.count}
						</span>
					{/each}
				</div>
				<div class="text-[10px] text-[var(--sig-text-muted)] leading-[1.35] mb-1">
					<span class="text-[var(--sig-text)]">Radius</span> = importance
				</div>
				<div class="flex items-center gap-2 text-[10px] text-[var(--sig-text-muted)] mb-1.5">
					<span class="inline-block w-[6px] h-[6px] rounded-full border border-[rgba(255,255,255,0.24)]"></span>
					<span class="inline-block w-[9px] h-[9px] rounded-full border border-[rgba(255,255,255,0.28)]"></span>
					<span class="inline-block w-[12px] h-[12px] rounded-full border border-[rgba(255,255,255,0.32)]"></span>
					<span>low to high</span>
				</div>
				<div class="text-[10px] text-[var(--sig-text-muted)] leading-[1.35]">
					<span class="text-[var(--sig-text)]">Relation highlight</span> = selected node neighborhood emphasis
				</div>
			</div>
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
				<p>No memories found</p>
			</div>
		{:else if !graphInitialized}
			<div class="absolute inset-0 flex items-center justify-center bg-[var(--sig-bg)] z-10">
				<p>Loading...</p>
			</div>
		{/if}

		<div
			class="absolute left-[14px] z-[6] font-[family-name:var(--font-mono)] text-[10px] text-[var(--sig-text-muted)] tracking-[0.08em] uppercase pointer-events-none"
			style:top="20px"
			aria-hidden="true"
		>:: &#9675; &#9675; 01 10 11 // latent topology</div>

		<div class="absolute inset-0 pointer-events-none z-[5]" aria-hidden="true">
			<span class="absolute top-[10px] left-[10px] w-[14px] h-[14px] border-[rgba(255,255,255,0.22)]" style="border-style:solid;border-width:1px 0 0 1px"></span>
			<span class="absolute top-[10px] right-[10px] w-[14px] h-[14px] border-[rgba(255,255,255,0.22)]" style="border-style:solid;border-width:1px 1px 0 0"></span>
			<span class="absolute bottom-[10px] left-[10px] w-[14px] h-[14px] border-[rgba(255,255,255,0.22)]" style="border-style:solid;border-width:0 0 1px 1px"></span>
			<span class="absolute bottom-[10px] right-[10px] w-[14px] h-[14px] border-[rgba(255,255,255,0.22)]" style="border-style:solid;border-width:0 1px 1px 0"></span>
		</div>

		{#if previewHovered}
			<div
				bind:this={hoverCardEl}
				class="z-[9] w-[320px] pointer-events-none border border-[rgba(255,255,255,0.26)] bg-[rgba(5,5,5,0.92)] px-2 py-2"
				style="position:absolute;top:0;left:0;will-change:transform"
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

		<div class="w-[360px] min-w-[320px] border-l border-[var(--sig-border)] bg-[var(--sig-surface)] flex flex-col min-h-0 max-lg:w-full max-lg:min-w-0 max-lg:max-h-[48%] max-lg:border-l-0 max-lg:border-t max-lg:border-t-[var(--sig-border)]">
			<div class="p-3 border-b border-[var(--sig-border)] space-y-2 overflow-y-auto">
				<Collapsible.Root bind:open={controlsMenuOpen} class="border border-[var(--sig-border)]">
					<Collapsible.Trigger class="flex w-full items-center justify-between px-2 py-1.5 bg-transparent border-none text-[10px] uppercase tracking-[0.08em] font-[family-name:var(--font-mono)] text-[var(--sig-text)] hover:bg-[var(--sig-surface-raised)]">
						<span>View Controls</span>
						<ChevronDown class={`size-3 text-[var(--sig-text-muted)] transition-transform ${controlsMenuOpen ? 'rotate-180' : ''}`} />
					</Collapsible.Trigger>
					<Collapsible.Content>
						<div class="p-2 space-y-2 border-t border-[var(--sig-border)]">
							<div class="flex items-center gap-2">
								<input
									type="text"
									class="flex-1 font-[family-name:var(--font-mono)] text-[11px] text-[var(--sig-text-bright)] bg-[var(--sig-surface)] border border-[var(--sig-border-strong)] px-[9px] py-[6px] outline-none"
									bind:value={embeddingSearch}
									oninput={() => (activePresetId = "custom-live")}
									placeholder="Search constellation"
								/>
								{#if embeddingSearch}
									<span class="font-[family-name:var(--font-mono)] text-[10px] text-[var(--sig-text-muted)] border border-[var(--sig-border)] px-2 py-1">{embeddingSearchMatches.length}</span>
								{/if}
							</div>
							<div class="text-[10px] font-[family-name:var(--font-mono)] text-[var(--sig-text-muted)]">Window {activeProjectionWindow.offset + 1}-{activeProjectionWindow.offset + embeddings.length} / {embeddingsTotal}</div>
							<div class="flex flex-wrap gap-1">
								<button class="px-2 py-[2px] font-[family-name:var(--font-mono)] text-[10px] uppercase border border-[var(--sig-border-strong)] {showPinnedOnly ? 'text-[var(--sig-text-bright)] bg-[var(--sig-surface-raised)]' : 'text-[var(--sig-text-muted)] bg-transparent'}" onclick={togglePinnedOnly}>Pinned</button>
								<button class="px-2 py-[2px] font-[family-name:var(--font-mono)] text-[10px] uppercase border border-[var(--sig-border-strong)] {showNeighborhoodOnly ? 'text-[var(--sig-text-bright)] bg-[var(--sig-surface-raised)]' : 'text-[var(--sig-text-muted)] bg-transparent'}" onclick={toggleNeighborhoodOnly}>Neighborhood</button>
								<button class="px-2 py-[2px] font-[family-name:var(--font-mono)] text-[10px] uppercase border border-[var(--sig-border-strong)] {clusterLensMode ? 'text-[var(--sig-text-bright)] bg-[var(--sig-surface-raised)]' : 'text-[var(--sig-text-muted)] bg-transparent'}" onclick={toggleClusterLens}>Lens</button>
								<button class="px-2 py-[2px] font-[family-name:var(--font-mono)] text-[10px] uppercase border border-[var(--sig-border-strong)] text-[var(--sig-text-muted)] hover:text-[var(--sig-text-bright)]" onclick={resetProjectionFilters}>{ActionLabels.Reset}</button>
							</div>
						</div>
					</Collapsible.Content>
				</Collapsible.Root>

				<Collapsible.Root bind:open={presetsMenuOpen} class="border border-[var(--sig-border)]">
					<Collapsible.Trigger class="flex w-full items-center justify-between px-2 py-1.5 bg-transparent border-none text-[10px] uppercase tracking-[0.08em] font-[family-name:var(--font-mono)] text-[var(--sig-text)] hover:bg-[var(--sig-surface-raised)]">
						<span>Presets</span>
						<ChevronDown class={`size-3 text-[var(--sig-text-muted)] transition-transform ${presetsMenuOpen ? 'rotate-180' : ''}`} />
					</Collapsible.Trigger>
					<Collapsible.Content>
						<div class="p-2 border-t border-[var(--sig-border)] flex flex-wrap gap-1">
							{#each builtinPresets as preset}
								<button class="px-2 py-[2px] font-[family-name:var(--font-mono)] text-[10px] uppercase border border-[var(--sig-border-strong)] {activePresetId === preset.id ? 'text-[var(--sig-text-bright)] bg-[var(--sig-surface-raised)]' : 'text-[var(--sig-text-muted)] bg-transparent'}" onclick={() => applyPreset(preset)}>{preset.name}</button>
							{/each}
							{#each customPresets as preset}
								<div class="inline-flex items-center border border-[var(--sig-border-strong)]">
									<button class="px-2 py-[2px] font-[family-name:var(--font-mono)] text-[10px] {activePresetId === preset.id ? 'text-[var(--sig-text-bright)] bg-[var(--sig-surface-raised)]' : 'text-[var(--sig-text-muted)] bg-transparent'}" onclick={() => applyPreset(preset)}>{preset.name}</button>
									<button class="px-1.5 py-[2px] font-[family-name:var(--font-mono)] text-[10px] text-[var(--sig-text-muted)] hover:text-[var(--sig-text-bright)]" onclick={() => removeCustomPreset(preset.id)} aria-label={`Delete ${preset.name} preset`}>×</button>
								</div>
							{/each}
							<button class="px-2 py-[2px] font-[family-name:var(--font-mono)] text-[10px] uppercase border border-[var(--sig-border-strong)] text-[var(--sig-text-muted)] hover:text-[var(--sig-text-bright)]" onclick={saveCurrentPreset}>{ActionLabels.Save}</button>
						</div>
					</Collapsible.Content>
				</Collapsible.Root>

				<Collapsible.Root bind:open={sourcesMenuOpen} class="border border-[var(--sig-border)]">
					<Collapsible.Trigger class="flex w-full items-center justify-between px-2 py-1.5 bg-transparent border-none text-[10px] uppercase tracking-[0.08em] font-[family-name:var(--font-mono)] text-[var(--sig-text)] hover:bg-[var(--sig-surface-raised)]">
						<span>Sources</span>
						<ChevronDown class={`size-3 text-[var(--sig-text-muted)] transition-transform ${sourcesMenuOpen ? 'rotate-180' : ''}`} />
					</Collapsible.Trigger>
					<Collapsible.Content>
						<div class="p-2 border-t border-[var(--sig-border)] flex flex-wrap gap-1">
							{#if sourceCounts.length === 0}
								<span class="text-[10px] text-[var(--sig-text-muted)]">No sources</span>
							{:else}
								{#each sourceCounts as source}
									<button class="px-2 py-[2px] font-[family-name:var(--font-mono)] text-[10px] border border-[var(--sig-border-strong)] {selectedSources.size === 0 || selectedSources.has(source.who) ? 'text-[var(--sig-text-bright)] bg-[var(--sig-surface-raised)]' : 'text-[var(--sig-text-muted)] bg-transparent'}" onclick={() => toggleSourceFromPanel(source.who)}>{source.who} {source.count}</button>
								{/each}
							{/if}
						</div>
					</Collapsible.Content>
				</Collapsible.Root>

				<Collapsible.Root bind:open={showAdvancedFilters} class="border border-[var(--sig-border)]">
					<Collapsible.Trigger class="flex w-full items-center justify-between px-2 py-1.5 bg-transparent border-none text-[10px] uppercase tracking-[0.08em] font-[family-name:var(--font-mono)] text-[var(--sig-text)] hover:bg-[var(--sig-surface-raised)]">
						<span>Advanced</span>
						<ChevronDown class={`size-3 text-[var(--sig-text-muted)] transition-transform ${showAdvancedFilters ? 'rotate-180' : ''}`} />
					</Collapsible.Trigger>
					<Collapsible.Content>
						<div class="p-2 border-t border-[var(--sig-border)] space-y-2">
							<div class="flex items-center gap-1 flex-wrap">
								<span class="px-1 text-[10px] text-[var(--sig-text-muted)] uppercase font-[family-name:var(--font-mono)]">Window</span>
								<input type="number" min="0" max="100000" class="w-[70px] font-[family-name:var(--font-mono)] text-[10px] text-[var(--sig-text-bright)] bg-[var(--sig-bg)] border border-[var(--sig-border-strong)] px-1.5 py-[2px] outline-none" bind:value={projectionRangeMin} onblur={syncProjectionWindowInputs} />
								<span class="text-[10px] text-[var(--sig-text-muted)] font-[family-name:var(--font-mono)]">to</span>
								<input type="number" min="1" max="100000" class="w-[70px] font-[family-name:var(--font-mono)] text-[10px] text-[var(--sig-text-bright)] bg-[var(--sig-bg)] border border-[var(--sig-border-strong)] px-1.5 py-[2px] outline-none" bind:value={projectionRangeMax} onblur={syncProjectionWindowInputs} />
								<select class="font-[family-name:var(--font-mono)] text-[10px] text-[var(--sig-text-bright)] bg-[var(--sig-bg)] border border-[var(--sig-border-strong)] px-1.5 py-[2px] outline-none" bind:value={projectionTimePreset}>
									<option value="all">time: all</option>
									<option value="24h">time: 24h</option>
									<option value="7d">time: 7d</option>
									<option value="30d">time: 30d</option>
									<option value="90d">time: 90d</option>
									<option value="custom">time: custom</option>
								</select>
							</div>
							{#if projectionTimePreset === "custom"}
								<div class="flex items-center gap-1 flex-wrap">
									<input type="date" class="font-[family-name:var(--font-mono)] text-[10px] text-[var(--sig-text-bright)] bg-[var(--sig-bg)] border border-[var(--sig-border-strong)] px-1.5 py-[2px] outline-none" bind:value={projectionSinceDate} />
									<input type="date" class="font-[family-name:var(--font-mono)] text-[10px] text-[var(--sig-text-bright)] bg-[var(--sig-bg)] border border-[var(--sig-border-strong)] px-1.5 py-[2px] outline-none" bind:value={projectionUntilDate} />
								</div>
							{/if}
							<div class="flex items-center gap-1 flex-wrap">
								<select class="font-[family-name:var(--font-mono)] text-[10px] text-[var(--sig-text-bright)] bg-[var(--sig-bg)] border border-[var(--sig-border-strong)] px-1.5 py-[2px] outline-none" bind:value={projectionPinnedFilter}>
									<option value="all">pins: all</option>
									<option value="pinned">pins: pinned</option>
									<option value="unpinned">pins: unpinned</option>
								</select>
								<input type="text" class="w-[140px] font-[family-name:var(--font-mono)] text-[10px] text-[var(--sig-text-bright)] bg-[var(--sig-bg)] border border-[var(--sig-border-strong)] px-1.5 py-[2px] outline-none" bind:value={projectionSearch} placeholder="server query" />
								<input type="text" class="w-[110px] font-[family-name:var(--font-mono)] text-[10px] text-[var(--sig-text-bright)] bg-[var(--sig-bg)] border border-[var(--sig-border-strong)] px-1.5 py-[2px] outline-none" bind:value={projectionTagFilter} placeholder="tags csv" />
								<input type="text" class="w-[60px] font-[family-name:var(--font-mono)] text-[10px] text-[var(--sig-text-bright)] bg-[var(--sig-bg)] border border-[var(--sig-border-strong)] px-1.5 py-[2px] outline-none" bind:value={projectionImportanceMin} placeholder="imp>" />
								<input type="text" class="w-[60px] font-[family-name:var(--font-mono)] text-[10px] text-[var(--sig-text-bright)] bg-[var(--sig-bg)] border border-[var(--sig-border-strong)] px-1.5 py-[2px] outline-none" bind:value={projectionImportanceMax} placeholder="imp<" />
							</div>
							<div class="flex items-center gap-1 flex-wrap">
								<span class="px-1 text-[10px] text-[var(--sig-text-muted)] uppercase font-[family-name:var(--font-mono)]">Harness</span>
								{#if harnessOptions.length === 0}
									<span class="text-[10px] text-[var(--sig-text-muted)] font-[family-name:var(--font-mono)]">none</span>
								{:else}
									{#each harnessOptions as harness}
										<button class="px-2 py-[2px] font-[family-name:var(--font-mono)] text-[10px] border border-[var(--sig-border-strong)] {selectedHarnesses.has(harness) ? 'text-[var(--sig-text-bright)] bg-[var(--sig-surface-raised)]' : 'text-[var(--sig-text-muted)] bg-transparent'}" onclick={() => toggleHarness(harness)}>{harness}</button>
									{/each}
								{/if}
							</div>
							{#if typeCounts.length > 0 || selectedServerTypes.size > 0}
								<div class="flex items-center gap-1 flex-wrap">
									<span class="px-1 text-[10px] text-[var(--sig-text-muted)] uppercase font-[family-name:var(--font-mono)]">Type</span>
									{#each [...new Set([...selectedServerTypes, ...typeCounts.map((entry) => entry.value)])] as value}
										{@const count = typeCounts.find((entry) => entry.value === value)?.count ?? 0}
										<button class="px-2 py-[2px] font-[family-name:var(--font-mono)] text-[10px] border border-[var(--sig-border-strong)] {selectedServerTypes.has(value) ? 'text-[var(--sig-text-bright)] bg-[var(--sig-surface-raised)]' : 'text-[var(--sig-text-muted)] bg-transparent'}" onclick={() => toggleServerType(value)}>{value}{count > 0 ? ` ${count}` : ""}</button>
									{/each}
								</div>
							{/if}
							{#if sourceTypeCounts.length > 0 || selectedServerSourceTypes.size > 0}
								<div class="flex items-center gap-1 flex-wrap">
									<span class="px-1 text-[10px] text-[var(--sig-text-muted)] uppercase font-[family-name:var(--font-mono)]">Source type</span>
									{#each [...new Set([...selectedServerSourceTypes, ...sourceTypeCounts.map((entry) => entry.value)])] as value}
										{@const count = sourceTypeCounts.find((entry) => entry.value === value)?.count ?? 0}
										<button class="px-2 py-[2px] font-[family-name:var(--font-mono)] text-[10px] border border-[var(--sig-border-strong)] {selectedServerSourceTypes.has(value) ? 'text-[var(--sig-text-bright)] bg-[var(--sig-surface-raised)]' : 'text-[var(--sig-text-muted)] bg-transparent'}" onclick={() => toggleServerSourceType(value)}>{value}{count > 0 ? ` ${count}` : ""}</button>
									{/each}
								</div>
							{/if}
						</div>
					</Collapsible.Content>
				</Collapsible.Root>
			</div>

			<EmbeddingInspector
				containerClass="flex-1 min-h-0 w-full min-w-0 border-l-0 border-t-0 max-lg:max-h-none"
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
	</div>
</div>

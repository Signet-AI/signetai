<script lang="ts">
import PageBanner from "$lib/components/layout/PageBanner.svelte";
import {
	type ConstellationGraph,
	type EmbeddingCheckResult,
	type EmbeddingHealthReport,
	type EmbeddingPoint,
	type Memory,
	type ProjectionNode,
	type ProjectionQueryOptions,
	type RepairActionResult,
	getConstellationOverlay,
	getDistinctWho,
	getEmbeddingGapStats,
	getEmbeddingHealth,
	getProjection,
	getSimilarMemories,
	repairCleanOrphans,
	repairReEmbed,
	repairResyncVectorIndex,
	setMemoryPinned,
} from "$lib/api";
import * as Collapsible from "$lib/components/ui/collapsible/index.js";
import { nav, setTab } from "$lib/stores/navigation.svelte";
import TabGroupBar from "$lib/components/layout/TabGroupBar.svelte";
import { MEMORY_TAB_ITEMS } from "$lib/components/layout/page-headers";
import { focusMemoryTab } from "$lib/stores/tab-group-focus.svelte";
import { mem } from "$lib/stores/memory.svelte";
import { toast } from "$lib/stores/toast.svelte";
import { syncLayoutToStorage, workspaceLayout } from "$lib/stores/workspace-layout.svelte";
import { ActionLabels } from "$lib/ui/action-labels";
import ChevronDown from "@lucide/svelte/icons/chevron-down";
import { tick } from "svelte";
import { onMount } from "svelte";
// biome-ignore lint/style/useImportType: Svelte component tags need value imports.
import EmbeddingCanvas2D from "../embeddings/EmbeddingCanvas2D.svelte";
import EmbeddingInspector from "../embeddings/EmbeddingInspector.svelte";
import {
	DEFAULT_EMBEDDING_LIMIT,
	DEFAULT_GRAPH_PHYSICS,
	type EmbeddingRelation,
	GRAPH_PHYSICS_STORAGE_KEY,
	type GraphEdge,
	type GraphNode,
	type GraphPhysicsConfig,
	MAX_EMBEDDING_LIMIT,
	type NodeColorMode,
	type RelationKind,
	aspectRadius,
	attributeRadius,
	clampGraphPhysics,
	embeddingLabel,
	entityFillStyle,
	entityRadius,
	entityTypeColors,
	newnessFillStyle,
	newnessIntensity,
	parseCreatedMs,
	sourceColorRgba,
	sourceRgbaFast,
	tierChargeStrength,
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

const { onopenglobalsimilar }: Props = $props();

// -----------------------------------------------------------------------
// State
// -----------------------------------------------------------------------

let legendOpen = $state(false);
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
let searchInputEl: HTMLInputElement | undefined;
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
// biome-ignore lint/style/useConst: Mutated by Svelte bind:open.
let showAdvancedFilters = $state(false);
let controlsMenuOpen = $state(true);
let presetsMenuOpen = $state(false);
let sourcesMenuOpen = $state(true);

const LEGEND_PRIORITY_SOURCES = ["daemon", "user", "opencode"] as const;
const LEGEND_PRIORITY_SOURCE_SET = new Set<string>(LEGEND_PRIORITY_SOURCES);

const NODE_COLOR_MODE_SESSION_STORAGE_KEY = "signet-constellation-color-mode-session";
const NEW_SINCE_SESSION_STORAGE_KEY = "signet-constellation-new-since-session";
const LEGACY_NODE_COLOR_MODE_STORAGE_KEY = "signet-constellation-color-mode";
const LEGACY_NEW_SINCE_STORAGE_KEY = "signet-constellation-new-since";
const LAST_SEEN_STORAGE_KEY = "signet-constellation-last-seen";

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

// biome-ignore lint/style/useConst: Mutated from template callback.
let relationMode = $state<RelationKind>("similar");
let similarNeighbors = $state<EmbeddingRelation[]>([]);
let dissimilarNeighbors = $state<EmbeddingRelation[]>([]);
let activeNeighbors = $state<EmbeddingRelation[]>([]);
let loadingGlobalSimilar = $state(false);
let globalSimilar = $state<Memory[]>([]);

let nodeColorMode = $state<NodeColorMode>("source");
let showNewSinceLastSeen = $state(false);
let lastSeenMs = $state<number | null>(null);
let lastSeenWriteMs = $state<number | null>(null);
let viewSettingsHydrated = $state(false);
let newnessNowMs = $state(Date.now());

let nodes = $state<GraphNode[]>([]);
let edges = $state<GraphEdge[]>([]);
let nodeIdsByIndex = $state<string[]>([]);

let showEntityOverlay = $state(false);
let constellationOverlay = $state<ConstellationGraph | null>(null);
let entityOverlayLoading = $state(false);

const ENTITY_OVERLAY_STORAGE_KEY = "signet-constellation-entity-overlay";

let graphMode: "2d" | "3d" = $state("2d");
let projected3dCoords = $state<number[][]>([]);
let graphLoadId = 0;
let graphPhysics = $state<GraphPhysicsConfig>(DEFAULT_GRAPH_PHYSICS);
let graphPhysicsHydrated = $state(false);

let embeddingById = $state(new Map<string, EmbeddingPoint>());
let searchIndex = $state(new Map<string, string>());
let relationLookup = $state(new Map<string, RelationKind>());
let hoverLockedId = $state<string | null>(null);

// biome-ignore lint/style/useConst: Mutated by bind:this.
let graphRegion = $state<HTMLDivElement | null>(null);
// biome-ignore lint/style/useConst: Mutated by bind:this.
let hoverCardEl = $state<HTMLDivElement | null>(null);
let hoverX = 0;
let hoverY = 0;
let cachedRegionRect: DOMRect | null = null;

// biome-ignore lint/style/useConst: Mutated by bind:this.
let canvas2d = $state<EmbeddingCanvas2D | null>(null);
// biome-ignore lint/style/useConst: Mutated by bind:this.
let canvas3d = $state<any>(null);
let Canvas3D = $state<any>(null);
let canvas3dLoading = $state(false);
let graphRegionVisible = $state(false);

let healthReport = $state<EmbeddingHealthReport | null>(null);
// biome-ignore lint/style/useConst: Mutated from template callback.
let healthExpanded = $state(false);
let healthFixBusy = $state(false);
let healthTimer: ReturnType<typeof setInterval> | undefined;
let healthFixStatus = $state<string | null>(null);
let healthFixDetails = $state<string | null>(null);
let healthFixProgress = $state<{
	baseline: number;
	completed: number;
	remaining: number;
	percent: number;
	coverage: string;
} | null>(null);
let healthFixTimer: ReturnType<typeof setInterval> | undefined;

onMount(() => {
	controlsMenuOpen = workspaceLayout.embeddings.controlsOpen;
	presetsMenuOpen = workspaceLayout.embeddings.presetsOpen;
	sourcesMenuOpen = workspaceLayout.embeddings.sourcesOpen;
});

// Keyboard navigation for sub-tabs
function handleKeydown(event: KeyboardEvent): void {
	// Only handle events when Embeddings tab is active
	if (nav.activeTab !== "embeddings") return;

	if (event.defaultPrevented) return;

	const target = event.target;
	const isInput = target instanceof HTMLElement && (
		target.tagName === "INPUT" ||
		target.tagName === "TEXTAREA" ||
		target.tagName === "SELECT" ||
		target.isContentEditable
	);

	// Arrow Down from the embeddings tab trigger button to focus search input
	const isTabButton = target instanceof HTMLElement &&
		target.getAttribute("data-memory-tab") === "embeddings";
	if (event.key === "ArrowDown" && isTabButton) {
		event.preventDefault();
		if (!controlsMenuOpen) {
			controlsMenuOpen = true;
			void tick().then(() => searchInputEl?.focus());
		} else {
			searchInputEl?.focus();
		}
		return;
	}

	// Arrow Up from search input to return to tab bar
	if (event.key === "ArrowUp" && target === searchInputEl) {
		event.preventDefault();
		const embeddingsTabButton = document.querySelector('[data-memory-tab="embeddings"]') as HTMLElement;
		if (embeddingsTabButton) {
			embeddingsTabButton.focus();
		} else {
			searchInputEl?.blur();
		}
		return;
	}

	// Don't process other keys when in input
	if (isInput) return;
}

async function fetchHealth(): Promise<void> {
	healthReport = await getEmbeddingHealth();
}

function parseCooldownMs(message: string): number | null {
	const match = message.match(/cooldown active,\s*(\d+)ms remaining/i);
	if (!match?.[1]) return null;
	const parsed = Number.parseInt(match[1], 10);
	return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function formatCooldown(ms: number): string {
	const totalSeconds = Math.ceil(ms / 1000);
	if (totalSeconds < 60) return `${totalSeconds}s`;
	const minutes = Math.floor(totalSeconds / 60);
	const seconds = totalSeconds % 60;
	return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
}

function parseMissingFromCheckMessage(message: string): number | null {
	const match = message.match(/([\d,]+)\s+memories?\s+missing\s+embeddings/i);
	if (!match?.[1]) return null;
	const parsed = Number.parseInt(match[1].replaceAll(",", ""), 10);
	return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function clearHealthFixProgressTimer(): void {
	if (healthFixTimer) {
		clearInterval(healthFixTimer);
		healthFixTimer = undefined;
	}
}

function formatElapsed(ms: number): string {
	const seconds = Math.max(1, Math.floor(ms / 1000));
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	const remainder = seconds % 60;
	return remainder > 0 ? `${minutes}m ${remainder}s` : `${minutes}m`;
}

function startReembedProgress(initialMissing: number | null): void {
	clearHealthFixProgressTimer();
	const startedAt = Date.now();
	let baselineMissing: number | null = initialMissing;
	let pollInFlight = false;
	let pollCount = 0;

	healthFixStatus = "Re-embedding in progress";
	healthFixDetails =
		initialMissing === null ? "Collecting progress..." : `${initialMissing.toLocaleString()} missing at start`;
	healthFixProgress = null;

	const poll = async (): Promise<void> => {
		if (pollInFlight) return;
		pollInFlight = true;
		try {
			const gaps = await getEmbeddingGapStats();
			const elapsed = formatElapsed(Date.now() - startedAt);
			healthFixStatus = `Re-embedding in progress (${elapsed})`;
			if (gaps) {
				if (baselineMissing === null) {
					baselineMissing = gaps.unembedded;
				}
				const baseline = Math.max(0, baselineMissing ?? gaps.unembedded);
				const completed = Math.max(0, baseline - gaps.unembedded);
				const percent = baseline > 0 ? Math.min(100, (completed / baseline) * 100) : 100;
				healthFixProgress = {
					baseline,
					completed,
					remaining: gaps.unembedded,
					percent,
					coverage: gaps.coverage,
				};
				healthFixDetails =
					baselineMissing === null
						? `${gaps.unembedded.toLocaleString()} still missing (${gaps.coverage} coverage)`
						: `${completed.toLocaleString()} completed, ${gaps.unembedded.toLocaleString()} remaining (${gaps.coverage} coverage)`;
			}
			if (pollCount % 2 === 0) {
				await fetchHealth();
			}
			pollCount++;
		} finally {
			pollInFlight = false;
		}
	};

	void poll();
	healthFixTimer = setInterval(() => {
		void poll();
	}, 3000);
}

async function runFix(check: EmbeddingCheckResult): Promise<void> {
	if (healthFixBusy) return;
	healthFixBusy = true;
	const isReembedCheck = check.name === "coverage" || check.name === "null-vectors";
	if (!isReembedCheck) {
		healthFixStatus = `Running ${check.name} repair...`;
		healthFixDetails = null;
		healthFixProgress = null;
	}
	if (isReembedCheck) {
		const initialMissingFromCheck = parseMissingFromCheckMessage(check.message);
		if (initialMissingFromCheck !== null) {
			startReembedProgress(initialMissingFromCheck);
		} else {
			const gaps = await getEmbeddingGapStats();
			startReembedProgress(gaps?.unembedded ?? null);
		}
	}
	try {
		let result: RepairActionResult;
		if (check.name === "orphaned-embeddings") {
			result = await repairCleanOrphans();
		} else if (check.name === "vec-table-sync") {
			result = await repairResyncVectorIndex();
		} else if (check.name === "coverage" || check.name === "null-vectors") {
			result = await repairReEmbed();
		} else {
			toast(`Repair action not wired for ${check.name}`, "warning");
			return;
		}

		if (!result.success) {
			clearHealthFixProgressTimer();
			if (result.status === 429) {
				const cooldownMs = parseCooldownMs(result.message);
				if (cooldownMs !== null) {
					healthFixStatus = "Repair blocked by cooldown";
					healthFixDetails = `Try again in ${formatCooldown(cooldownMs)}.`;
					toast(`Repair on cooldown. Try again in ${formatCooldown(cooldownMs)}.`, "warning", 4500);
				} else {
					healthFixStatus = "Repair blocked by policy";
					healthFixDetails = result.message;
					toast(`Repair temporarily blocked: ${result.message}`, "warning", 5000);
				}
				await fetchHealth();
				return;
			}
			healthFixStatus = "Repair failed";
			healthFixDetails = result.message;
			healthFixProgress = null;
			toast(`Repair failed: ${result.message}`, "error", 5000);
			return;
		}

		clearHealthFixProgressTimer();
		healthFixStatus = "Repair completed";
		healthFixDetails = result.message;
		if (isReembedCheck) {
			const gaps = await getEmbeddingGapStats();
			if (gaps && healthFixProgress) {
				const baseline = healthFixProgress.baseline;
				const completed = Math.max(0, baseline - gaps.unembedded);
				healthFixProgress = {
					baseline,
					completed,
					remaining: gaps.unembedded,
					percent: baseline > 0 ? Math.min(100, (completed / baseline) * 100) : 100,
					coverage: gaps.coverage,
				};
			}
		}

		if (result.affected > 0) {
			toast(result.message, "success", 4500);
		} else {
			toast(result.message, "info", 4500);
		}
		await fetchHealth();
		if (isReembedCheck && result.affected > 0) {
			await reloadEmbeddingsGraph();
		}
	} finally {
		clearHealthFixProgressTimer();
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
		clearHealthFixProgressTimer();
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

function newnessLegendColor(ageMs: number, alpha: number): string {
	const createdAt = new Date(newnessNowMs - ageMs).toISOString();
	return newnessFillStyle(newnessIntensity(createdAt, newnessNowMs), alpha);
}

function normalizeProjectionWindow(): { offset: number; limit: number } {
	const offset = Number.isFinite(projectionRangeMin) ? Math.max(0, Math.trunc(projectionRangeMin)) : 0;
	const requestedMax = Number.isFinite(projectionRangeMax)
		? Math.max(1, Math.trunc(projectionRangeMax))
		: DEFAULT_EMBEDDING_LIMIT;
	const maxExclusive = Math.max(offset + 1, Math.min(requestedMax, offset + MAX_EMBEDDING_LIMIT));
	return { offset, limit: maxExclusive - offset };
}

function syncProjectionWindowInputs(): void {
	const { offset, limit } = normalizeProjectionWindow();
	projectionRangeMin = offset;
	projectionRangeMax = offset + limit;
}

function parseLocalDateToIso(dateValue: string, endOfDay: boolean): string | undefined {
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

function readInputNumber(event: Event, fallback: number): number {
	const target = event.currentTarget;
	if (!(target instanceof HTMLInputElement)) return fallback;
	const parsed = Number.parseFloat(target.value);
	return Number.isFinite(parsed) ? parsed : fallback;
}

function updateGraphPhysics(patch: Partial<GraphPhysicsConfig>): void {
	graphPhysics = clampGraphPhysics({ ...graphPhysics, ...patch });
}

function timePresetSinceIso(preset: TimeFilterPreset, anchorMs: number): string | undefined {
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
	if (typeof importanceMin === "number" && typeof importanceMax === "number" && importanceMin > importanceMax) {
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
		importanceMin: typeof options.importanceMin === "number" ? options.importanceMin : "",
		importanceMax: typeof options.importanceMax === "number" ? options.importanceMax : "",
	});
}

function intersectFilterSets(filters: Array<Set<string> | null>): Set<string> | null {
	let out: Set<string> | null = null;
	for (const filter of filters) {
		if (filter === null) continue;
		if (out === null) {
			out = new Set(filter);
			continue;
		}
		// Iterate smaller set, check against larger — avoids spread+filter+new Set
		if (out.size <= filter.size) {
			for (const id of out) {
				if (!filter.has(id)) out.delete(id);
			}
		} else {
			const next = new Set<string>();
			for (const id of filter) {
				if (out.has(id)) next.add(id);
			}
			out = next;
		}
	}
	return out;
}

function updateEmbeddingInState(id: string, patch: (entry: EmbeddingPoint) => EmbeddingPoint): void {
	const idx = embeddings.findIndex((entry) => entry.id === id);
	if (idx < 0) return;
	const patched = patch(embeddings[idx]);
	embeddings[idx] = patched;
	embeddings = embeddings;
	embeddingById.set(id, patched);
	embeddingById = embeddingById;
	const nodeIdx = nodes.findIndex((n) => n.data.id === id);
	if (nodeIdx >= 0) {
		nodes[nodeIdx] = { ...nodes[nodeIdx], data: patched };
		nodes = nodes;
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
	const suggested = graphSelected ? `Cluster: ${graphSelected.who ?? "source"}` : "Custom preset";
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
			projection.hasMore ?? (projection.count ?? projNodes.length) < (projection.total ?? projNodes.length),
		);
		lastAppliedProjectionKey = requestKey;
		embeddingById = new Map(embeddings.map((item) => [item.id, item]));

		if (projNodes.length === 0) {
			graphStatus = "";
			return;
		}

		let minX = Number.POSITIVE_INFINITY;
		let maxX = Number.NEGATIVE_INFINITY;
		let minY = Number.POSITIVE_INFINITY;
		let maxY = Number.NEGATIVE_INFINITY;
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
			color: sourceRgbaFast(node.who, 0.85),
			data: embeddings[index],
			createdMs: parseCreatedMs(node.createdAt),
		}));
		nodeIdsByIndex = embeddings.map((embedding) => embedding.id);

		edges = (projection.edges ?? []).map(([source, target]) => ({
			source,
			target,
			edgeType: "knn" as const,
		}));

		// When entity overlay is ON, build knowledge graph (replaces nodes/edges)
		if (showEntityOverlay) {
			await buildKnowledgeGraph();
		}

		graphStatus = "";
		await tick();
		if (loadId !== graphLoadId) return;

		if (showEntityOverlay) {
			// Tier-aware force simulation for hierarchical layout
			canvas2d?.startKnowledgeGraphSimulation(nodes, edges);
			canvas2d?.startRendering(true);
		} else {
			canvas2d?.startSimulation(nodes, edges, graphPhysics);
			canvas2d?.startRendering();
		}
	} catch (error) {
		graphError = (error as Error).message || "Failed to load projection";
		graphStatus = "";
		lastAppliedProjectionKey = requestKey;
	}
}

// -----------------------------------------------------------------------
// Knowledge graph builder (entity-first hierarchical view)
// -----------------------------------------------------------------------

async function buildKnowledgeGraph(): Promise<void> {
	entityOverlayLoading = true;
	try {
		const graph = await getConstellationOverlay();
		if (!graph) {
			constellationOverlay = null;
			return;
		}
		constellationOverlay = graph;

		// Build the existing memory node lookup for leaf linking
		const memoryNodeMap = new Map<string, GraphNode>();
		for (const node of nodes) {
			memoryNodeMap.set(node.data.id, node);
		}

		const kgNodes: GraphNode[] = [];
		const kgEdges: GraphEdge[] = [];
		const kgNodeIds: string[] = [];
		const kgEmbeddingById = new Map<string, EmbeddingPoint>();
		const entityNodeIndices = new Map<string, number>();

		const spread = 400;

		for (const entity of graph.entities) {
			// Create entity node
			const eId = `entity:${entity.id}`;
			const eRadius = entityRadius(entity);
			const ex = (Math.random() - 0.5) * spread;
			const ey = (Math.random() - 0.5) * spread;
			const eData: EmbeddingPoint = {
				id: eId,
				content: entity.name,
				who: entity.entityType,
				importance: 0.9,
				pinned: entity.pinned,
				tags: [],
				createdAt: undefined,
			};
			const entityIdx = kgNodes.length;
			entityNodeIndices.set(entity.id, entityIdx);
			kgNodes.push({
				x: ex, y: ey,
				radius: eRadius,
				color: entityFillStyle(entity.entityType, 0.7),
				data: eData,
				nodeType: "entity",
				entityData: entity,
			});
			kgNodeIds.push(eId);
			kgEmbeddingById.set(eId, eData);

			// Create aspect nodes orbiting entity
			for (const aspect of entity.aspects) {
				const aId = `aspect:${aspect.id}`;
				const aRadius = aspectRadius(aspect.weight);
				const aData: EmbeddingPoint = {
					id: aId,
					content: aspect.name,
					who: entity.entityType,
					importance: aspect.weight,
					pinned: false,
					tags: [],
					createdAt: undefined,
				};
				const aspectIdx = kgNodes.length;
				kgNodes.push({
					x: ex + (Math.random() - 0.5) * 80,
					y: ey + (Math.random() - 0.5) * 80,
					radius: aRadius,
					color: entityFillStyle(entity.entityType, 0.5),
					data: aData,
					nodeType: "aspect",
					aspectData: aspect,
					parentEntityId: entity.id,
				});
				kgNodeIds.push(aId);
				kgEmbeddingById.set(aId, aData);

				// Hierarchy edge: entity -> aspect
				kgEdges.push({
					source: entityIdx,
					target: aspectIdx,
					edgeType: "hierarchy",
				});

				// Create attribute nodes orbiting aspect
				for (const attr of aspect.attributes) {
					const atId = `attr:${attr.id}`;
					const atRadius = attributeRadius(attr.importance);
					const atData: EmbeddingPoint = {
						id: atId,
						content: attr.content,
						who: entity.entityType,
						importance: attr.importance,
						pinned: false,
						tags: [],
						createdAt: undefined,
					};
					const attrIdx = kgNodes.length;
					kgNodes.push({
						x: kgNodes[aspectIdx].x + (Math.random() - 0.5) * 40,
						y: kgNodes[aspectIdx].y + (Math.random() - 0.5) * 40,
						radius: atRadius,
						color: entityFillStyle(entity.entityType, 0.3),
						data: atData,
						nodeType: "attribute",
						attributeData: attr,
						parentEntityId: entity.id,
						parentAspectId: aspect.id,
					});
					kgNodeIds.push(atId);
					kgEmbeddingById.set(atId, atData);

					// Hierarchy edge: aspect -> attribute
					kgEdges.push({
						source: aspectIdx,
						target: attrIdx,
						edgeType: "hierarchy",
					});

					// If attribute has a memoryId in the current projection, add memory leaf
					if (attr.memoryId) {
						const memNode = memoryNodeMap.get(attr.memoryId);
						if (memNode) {
							const memIdx = kgNodes.length;
							kgNodes.push({
								x: kgNodes[attrIdx].x + (Math.random() - 0.5) * 25,
								y: kgNodes[attrIdx].y + (Math.random() - 0.5) * 25,
								radius: 2,
								color: memNode.color,
								data: memNode.data,
								nodeType: "memory",
							});
							kgNodeIds.push(memNode.data.id);
							kgEmbeddingById.set(memNode.data.id, memNode.data);

							// Hierarchy edge: attribute -> memory
							kgEdges.push({
								source: attrIdx,
								target: memIdx,
								edgeType: "hierarchy",
							});
						}
					}
				}
			}
		}

		// Performance cap: drop memory leaf nodes if > 3000 total
		if (kgNodes.length > 3000) {
			// Build index remapping in a single pass — O(n) with no intermediate arrays
			const indexMap = new Map<number, number>();
			let writeIdx = 0;
			for (let i = 0; i < kgNodes.length; i++) {
				if (kgNodes[i].nodeType === "memory") continue;
				indexMap.set(i, writeIdx);
				kgNodes[writeIdx] = kgNodes[i];
				kgNodeIds[writeIdx] = kgNodeIds[i];
				writeIdx++;
			}
			kgNodes.length = writeIdx;
			kgNodeIds.length = writeIdx;
			// Remap edges in place
			let edgeWrite = 0;
			for (const edge of kgEdges) {
				const ms = indexMap.get(edge.source as number);
				const mt = indexMap.get(edge.target as number);
				if (ms !== undefined && mt !== undefined) {
					kgEdges[edgeWrite] = { ...edge, source: ms, target: mt };
					edgeWrite++;
				}
			}
			kgEdges.length = edgeWrite;
			kgEmbeddingById.clear();
			for (const n of kgNodes) {
				kgEmbeddingById.set(n.data.id, n.data);
			}
		}

		// Dependency edges between entity nodes
		for (const dep of graph.dependencies) {
			const si = entityNodeIndices.get(dep.sourceEntityId);
			const ti = entityNodeIndices.get(dep.targetEntityId);
			if (si !== undefined && ti !== undefined) {
				kgEdges.push({
					source: si,
					target: ti,
					edgeType: "dependency",
					dependencyType: dep.dependencyType,
					strength: dep.strength,
				});
			}
		}

		// Replace graph state entirely
		nodes = kgNodes;
		nodeIdsByIndex = kgNodeIds;
		edges = kgEdges;
		embeddingById = kgEmbeddingById;
	} finally {
		entityOverlayLoading = false;
	}
}

// -----------------------------------------------------------------------
// Relation computation (server-side via getSimilarMemories)
// -----------------------------------------------------------------------

async function computeRelationsForSelection(selected: EmbeddingPoint | null): Promise<void> {
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
		globalSimilar = await getSimilarMemories(graphSelected.id, 10, mem.filterType || undefined);
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

		canvas3dLoading = true;
		graphStatus = "Loading 3D...";

		if (!Canvas3D) {
			const mod = await import("../embeddings/EmbeddingCanvas3D.svelte");
			Canvas3D = mod.default;
		}

		graphStatus = "Loading 3D projection...";
		const loadId = ++graphLoadId;
		const requestOptions = buildProjectionQueryOptions();
		let projection = await getProjection(3, requestOptions);

		while (projection.status === "computing") {
			if (loadId !== graphLoadId) {
				canvas3dLoading = false;
				return;
			}
			await new Promise<void>((resolve) => setTimeout(resolve, 2000));
			projection = await getProjection(3, requestOptions);
		}

		if (loadId !== graphLoadId) {
			canvas3dLoading = false;
			return;
		}

		const projNodes = projection.nodes ?? [];
		const nodeMap = new Map(projNodes.map((n) => [n.id, n]));

		projected3dCoords = embeddings.map((emb) => {
			const n = nodeMap.get(emb.id);
			return n ? [n.x, n.y, n.z ?? 0] : [0, 0, 0];
		});

		graphStatus = "";
		canvas3dLoading = false;
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
	const pinned = new Set<string>();
	const counts = new Map<string, number>();
	const typeMap = new Map<string, number>();
	const sourceTypeMap = new Map<string, number>();
	const index = new Map<string, string>();

	for (const row of rows) {
		if (row.pinned) pinned.add(row.id);
		const key = row.who ?? "unknown";
		counts.set(key, (counts.get(key) ?? 0) + 1);
		if (typeof row.type === "string" && row.type.length > 0) {
			typeMap.set(row.type, (typeMap.get(row.type) ?? 0) + 1);
		}
		const sourceType = row.sourceType ?? "memory";
		sourceTypeMap.set(sourceType, (sourceTypeMap.get(sourceType) ?? 0) + 1);
		// Phase 6: Pre-build search index
		index.set(row.id, [
			row.content, row.text ?? "", row.who ?? "",
			row.type ?? "", row.sourceType ?? "",
			row.sourceId ?? "", ...(row.tags ?? []),
		].join(" ").toLowerCase());
	}

	pinnedIds = pinned;
	searchIndex = index;
	sourceCounts = [...counts.entries()]
		.sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
		.map(([who, count]) => ({ who, count }));
	typeCounts = [...typeMap.entries()]
		.sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
		.map(([value, count]) => ({ value, count }));
	sourceTypeCounts = [...sourceTypeMap.entries()]
		.sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
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
	const next = new Set([...selectedHarnesses].filter((value) => available.has(value)));
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
	// Phase 6: Use pre-built search index instead of per-search string construction
	for (const row of rows) {
		const haystack = searchIndex.get(row.id);
		if (haystack && haystack.includes(query)) {
			ids.add(row.id);
			matches.push(row);
		}
	}

	// When entity overlay is active, also search KG nodes (entity:/aspect:/attr: IDs)
	if (showEntityOverlay) {
		for (const [id, point] of embeddingById) {
			if (ids.has(id)) continue;
			const haystack = [point.content, point.who ?? "", ...(point.tags ?? [])].join(" ").toLowerCase();
			if (haystack.includes(query)) {
				ids.add(id);
				matches.push(point);
			}
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
	sourceFilterIds = new Set(embeddings.filter((row) => selected.has(row.who ?? "unknown")).map((row) => row.id));
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
	window.localStorage.setItem(FILTER_PRESET_STORAGE_KEY, JSON.stringify(customPresets));
});

$effect(() => {
	if (typeof window === "undefined" || graphPhysicsHydrated) return;
	try {
		const raw = window.localStorage.getItem(GRAPH_PHYSICS_STORAGE_KEY);
		if (raw) {
			const parsed = JSON.parse(raw) as unknown;
			if (typeof parsed === "object" && parsed !== null) {
				const candidate = parsed as Record<string, unknown>;
				graphPhysics = clampGraphPhysics({
					centerForce:
						typeof candidate.centerForce === "number" ? candidate.centerForce : DEFAULT_GRAPH_PHYSICS.centerForce,
					repelForce:
						typeof candidate.repelForce === "number" ? candidate.repelForce : DEFAULT_GRAPH_PHYSICS.repelForce,
					linkForce: typeof candidate.linkForce === "number" ? candidate.linkForce : DEFAULT_GRAPH_PHYSICS.linkForce,
					linkDistance:
						typeof candidate.linkDistance === "number" ? candidate.linkDistance : DEFAULT_GRAPH_PHYSICS.linkDistance,
				});
			}
		}
	} finally {
		graphPhysicsHydrated = true;
	}
});

$effect(() => {
	if (typeof window === "undefined" || !graphPhysicsHydrated) return;
	window.localStorage.setItem(GRAPH_PHYSICS_STORAGE_KEY, JSON.stringify(graphPhysics));
});

$effect(() => {
	if (typeof window === "undefined" || viewSettingsHydrated) return;
	try {
		const rawMode = window.sessionStorage.getItem(NODE_COLOR_MODE_SESSION_STORAGE_KEY);
		if (rawMode === "source" || rawMode === "newness" || rawMode === "none") nodeColorMode = rawMode;
		const rawNewSince = window.sessionStorage.getItem(NEW_SINCE_SESSION_STORAGE_KEY);
		if (rawNewSince === "true") {
			showNewSinceLastSeen = true;
		}
	} catch {
		// Ignore sessionStorage read failures and keep in-memory defaults.
	}
	try {
		const rawLastSeen = window.localStorage.getItem(LAST_SEEN_STORAGE_KEY);
		if (rawLastSeen) {
			const parsed = Number.parseInt(rawLastSeen, 10);
			if (!Number.isNaN(parsed)) lastSeenMs = parsed;
		}
	} catch {
		// Ignore localStorage read failures and keep in-memory defaults.
	}
	try {
		window.localStorage.removeItem(LEGACY_NODE_COLOR_MODE_STORAGE_KEY);
		window.localStorage.removeItem(LEGACY_NEW_SINCE_STORAGE_KEY);
	} catch {
		// Ignore storage cleanup failures.
	}
	viewSettingsHydrated = true;
});

$effect(() => {
	if (typeof window === "undefined" || !viewSettingsHydrated) return;
	try {
		if (nodeColorMode === "source") {
			window.sessionStorage.removeItem(NODE_COLOR_MODE_SESSION_STORAGE_KEY);
		} else {
			window.sessionStorage.setItem(NODE_COLOR_MODE_SESSION_STORAGE_KEY, nodeColorMode);
		}
	} catch {
		// Ignore sessionStorage write failures and keep in-memory state.
	}
	try {
		if (showNewSinceLastSeen && nodeColorMode !== "none") {
			window.sessionStorage.setItem(NEW_SINCE_SESSION_STORAGE_KEY, "true");
		} else {
			window.sessionStorage.removeItem(NEW_SINCE_SESSION_STORAGE_KEY);
		}
	} catch {
		// Ignore sessionStorage write failures and keep in-memory state.
	}
	try {
		if (lastSeenWriteMs !== null) {
			window.localStorage.setItem(LAST_SEEN_STORAGE_KEY, String(lastSeenWriteMs));
		}
	} catch {
		// Ignore localStorage write failures and keep in-memory state.
	}
});

// Entity overlay persistence
$effect(() => {
	if (typeof window === "undefined") return;
	try {
		const raw = window.sessionStorage.getItem(ENTITY_OVERLAY_STORAGE_KEY);
		if (raw === "true") showEntityOverlay = true;
	} catch {
		// Ignore read failures.
	}
});

$effect(() => {
	if (typeof window === "undefined") return;
	try {
		if (showEntityOverlay) {
			window.sessionStorage.setItem(ENTITY_OVERLAY_STORAGE_KEY, "true");
		} else {
			window.sessionStorage.removeItem(ENTITY_OVERLAY_STORAGE_KEY);
		}
	} catch {
		// Ignore write failures.
	}
});

$effect(() => {
	if (typeof window === "undefined") return;
	const timer = window.setInterval(() => {
		newnessNowMs = Date.now();
	}, 60000);
	return () => window.clearInterval(timer);
});

$effect(() => {
	const ids = new Set<string>();
	if (clusterLensMode) {
		const seed = graphSelected ?? previewHovered;
		if (seed) {
			ids.add(seed.id);
			const neighborhood = graphSelected !== null ? activeNeighbors : hoverNeighbors;
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

$effect(() => {
	nodeColorMode;
	showNewSinceLastSeen;
	newnessNowMs;
	lastSeenMs;
	if (graphMode === "2d") canvas2d?.requestRedraw();
	scheduleRefresh3d();
});

$effect(() => {
	if (!graphInitialized || typeof window === "undefined") return;
	if (lastSeenWriteMs !== null) return;
	lastSeenWriteMs = Date.now();
});

$effect(() => {
	graphPhysics;
	if (!graphInitialized) return;
	if (graphMode === "2d") {
		canvas2d?.updatePhysics(graphPhysics);
	}
});

const projectionRequestKey = $derived(projectionQueryKey(buildProjectionQueryOptions()));

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
			? new Set([neighborhoodSeed.id, ...neighborhoodNeighbors.map((n) => n.id)])
			: null;

	embeddingFilterIds = intersectFilterSets([searchFilterIds, sourceFilterIds, pinnedFilterIds, neighborhoodFilterIds]);
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

const previewHovered = $derived(hoverLockedId ? (embeddingById.get(hoverLockedId) ?? null) : graphHovered);

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
	const topNeighbors = [...ranked.entries()].sort((l, r) => r[1] - l[1]).slice(0, 6);
	const topScore = topNeighbors[0]?.[1] ?? 1;
	return topNeighbors.map(([id, score]) => ({
		id,
		score: score / topScore,
		kind: "similar" as const,
	}));
});

const hoverRelationLookup = $derived(new Map(hoverNeighbors.map((n) => [n.id, "similar" as const])));

const effectiveRelationLookup = $derived(graphSelected ? relationLookup : hoverRelationLookup);

const selectedNode = $derived.by(() => {
	const sel = graphSelected;
	if (!sel) return null;
	return nodes.find((n) => n.data.id === sel.id) ?? null;
});

const effectiveHoverNeighbors = $derived(graphSelected ? [] : hoverNeighbors);

const legendSourceCounts = $derived.by(() => {
	const byName = new Map(sourceCounts.map((entry) => [entry.who, entry]));
	const prioritized = LEGEND_PRIORITY_SOURCES.map((name) => byName.get(name)).filter(
		(entry): entry is { who: string; count: number } => Boolean(entry),
	);
	const rest = sourceCounts.filter((entry) => !LEGEND_PRIORITY_SOURCE_SET.has(entry.who));
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
	if (!graphRegion) return;

	const observer = new IntersectionObserver(
		(entries) => {
			if (entries[0].isIntersecting && !graphInitialized && !graphRegionVisible) {
				graphRegionVisible = true;
				initGraph();
			}
		},
		{ threshold: 0.1 },
	);

	observer.observe(graphRegion);
	return () => observer.disconnect();
});

$effect(() => {
	workspaceLayout.embeddings.controlsOpen = controlsMenuOpen;
	workspaceLayout.embeddings.presetsOpen = presetsMenuOpen;
	workspaceLayout.embeddings.sourcesOpen = sourcesMenuOpen;
	syncLayoutToStorage();
});
</script>

<div class="flex flex-col flex-1 min-h-0 overflow-hidden">
	<PageBanner title="Constellation">
		<TabGroupBar
			group="memory"
			tabs={MEMORY_TAB_ITEMS}
			activeTab={nav.activeTab}
			onselect={(_tab, index) => focusMemoryTab(index)}
		/>
	</PageBanner>
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
						{#if healthFixBusy && healthFixProgress}
							<span class="text-[#c4a24a]">{Math.round(healthFixProgress.percent)}%</span>
						{/if}
					</button>
					{#if healthExpanded}
						<div class="mt-1 border border-[rgba(255,255,255,0.22)] bg-[rgba(5,5,5,0.92)] px-2 py-2 w-[320px]">
							<div class="flex items-center justify-between mb-2">
								<span class="font-[family-name:var(--font-mono)] text-[10px] text-[var(--sig-text-muted)] uppercase tracking-[0.06em]">Constellation Health</span>
								<span class="font-[family-name:var(--font-mono)] text-[10px] text-[var(--sig-text-muted)]">{healthReport.config.provider}/{healthReport.config.model}</span>
							</div>
							{#if healthFixStatus}
								<div class="mb-2 border border-[rgba(255,255,255,0.14)] bg-[rgba(255,255,255,0.03)] px-1.5 py-1.5">
									<div class="font-[family-name:var(--font-mono)] text-[9px] text-[var(--sig-text)] leading-[1.3]">{healthFixStatus}</div>
									{#if healthFixDetails}
										<div class="mt-0.5 font-[family-name:var(--font-mono)] text-[9px] text-[var(--sig-text-muted)] leading-[1.3]">{healthFixDetails}</div>
									{/if}
									{#if healthFixProgress}
										<div class="mt-1">
											<div class="flex items-center justify-between font-[family-name:var(--font-mono)] text-[9px] text-[var(--sig-text-muted)]">
												<span>{healthFixProgress.completed.toLocaleString()} / {healthFixProgress.baseline.toLocaleString()}</span>
												<span>{Math.round(healthFixProgress.percent)}%</span>
											</div>
											<div class="mt-1 h-[5px] border border-[rgba(255,255,255,0.2)] bg-[rgba(255,255,255,0.05)]">
												<div class="h-full bg-[#c4a24a]" style={`width:${Math.max(0, Math.min(100, healthFixProgress.percent))}%`}></div>
											</div>
											<div class="mt-1 font-[family-name:var(--font-mono)] text-[9px] text-[var(--sig-text-muted)]">
												{healthFixProgress.remaining.toLocaleString()} remaining · {healthFixProgress.coverage} coverage
											</div>
										</div>
									{/if}
								</div>
							{/if}
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

			<div class="absolute left-3 top-3 bottom-3 z-[8] pointer-events-none flex flex-col justify-end items-start max-w-[220px]">
				<Collapsible.Root bind:open={legendOpen} class="pointer-events-auto flex min-w-[180px] max-h-full flex-col-reverse">
					<Collapsible.Trigger class="flex w-full items-center gap-2 px-3 py-1.5 min-w-[180px] border border-[var(--sig-border)] text-[10px] font-[family-name:var(--font-mono)] uppercase tracking-[0.06em] text-[var(--sig-text-muted)] bg-transparent" aria-expanded={legendOpen}>
						<span>Legend</span>
						<ChevronDown class={`size-3 text-[var(--sig-text-muted)] transition-transform ${legendOpen ? 'rotate-180' : ''}`} />
					</Collapsible.Trigger>
					<Collapsible.Content class="min-h-0 max-h-[min(40vh,24rem)] overflow-y-auto border border-[var(--sig-border)] bg-[rgba(5,5,5,0.88)] px-3 py-2">
						<div class="text-[10px] text-[var(--sig-text-muted)] leading-[1.35] mb-1">
							<span class="text-[var(--sig-text)]">Color</span> = {nodeColorMode === "none" ? "off" : nodeColorMode === "newness" ? "by recency" : "by source"}
						</div>
						{#if nodeColorMode === "newness"}
							<div class="flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] text-[var(--sig-text-muted)] mb-1.5">
								<span class="inline-flex items-center gap-1"><span class="inline-block w-[8px] h-[8px] rounded-full" style={`background:${newnessLegendColor(5 * 60 * 1000, 0.95)}`}></span>last few minutes</span>
								<span class="inline-flex items-center gap-1"><span class="inline-block w-[8px] h-[8px] rounded-full" style={`background:${newnessLegendColor(3 * 60 * 60 * 1000, 0.9)}`}></span>last few hours</span>
								<span class="inline-flex items-center gap-1"><span class="inline-block w-[8px] h-[8px] rounded-full" style={`background:${newnessLegendColor(3 * 24 * 60 * 60 * 1000, 0.85)}`}></span>last week</span>
								<span class="inline-flex items-center gap-1"><span class="inline-block w-[8px] h-[8px] rounded-full" style={`background:${newnessLegendColor(30 * 24 * 60 * 60 * 1000, 0.85)}`}></span>older</span>
							</div>
							<div class="flex flex-wrap gap-1 mb-1.5">
								{#each legendSourceCounts as source}
									<span class="h-5 inline-flex items-center gap-1 px-1.5 py-0 font-[family-name:var(--font-mono)] text-[10px] border border-[rgba(255,255,255,0.14)] {selectedSources.size === 0 || selectedSources.has(source.who) ? 'bg-[rgba(255,255,255,0.08)] text-[var(--sig-text-bright)]' : 'bg-transparent text-[var(--sig-text-muted)]'}">
										{source.who} {source.count}
									</span>
								{/each}
							</div>
						{:else if nodeColorMode === "source"}
							<div class="flex flex-wrap gap-1 mb-1.5">
								{#each legendSourceCounts as source}
									<span class="h-5 inline-flex items-center gap-1 px-1.5 py-0 font-[family-name:var(--font-mono)] text-[10px] border border-[rgba(255,255,255,0.14)] {selectedSources.size === 0 || selectedSources.has(source.who) ? 'bg-[rgba(255,255,255,0.08)] text-[var(--sig-text-bright)]' : 'bg-transparent text-[var(--sig-text-muted)]'}">
										<span class="inline-block w-[6px] h-[6px] rounded-full" style={`background:${sourceColorRgba(source.who, 1)}`}></span>
										{source.who} {source.count}
									</span>
								{/each}
							</div>
						{:else}
							<div class="text-[10px] text-[var(--sig-text-muted)] leading-[1.35] mb-1.5">
								No color applied - all nodes are shown in gray.
							</div>
						{/if}
						<div class="text-[10px] text-[var(--sig-text-muted)] leading-[1.35] mb-1">
							<span class="text-[var(--sig-text)]">Radius</span> = importance
						</div>
						<div class="flex items-center gap-2 text-[10px] text-[var(--sig-text-muted)] mb-1.5">
							<span class="inline-block w-[6px] h-[6px] rounded-full border border-[rgba(255,255,255,0.24)]"></span>
							<span class="inline-block w-[9px] h-[9px] rounded-full border border-[rgba(255,255,255,0.28)]"></span>
							<span class="inline-block w-[12px] h-[12px] rounded-full border border-[rgba(255,255,255,0.32)]"></span>
							<span>low to high</span>
						</div>
						{#if showNewSinceLastSeen && nodeColorMode !== "none"}
							<div class="text-[10px] text-[var(--sig-text-muted)] leading-[1.35] mb-1">
								<span class="text-[var(--sig-text)]">Outline</span> = new since last seen
							</div>
						{/if}
						<div class="text-[10px] text-[var(--sig-text-muted)] leading-[1.35]">
							<span class="text-[var(--sig-text)]">Relation highlight</span> = selected node neighborhood emphasis
						</div>
						{#if showEntityOverlay}
							<div class="mt-2 pt-2 border-t border-[rgba(255,255,255,0.1)]">
								<div class="text-[10px] font-[family-name:var(--font-mono)] uppercase tracking-[0.06em] text-[var(--sig-text-muted)] mb-1">Knowledge Graph</div>
								<div class="flex flex-wrap gap-1 mb-1.5">
									{#each Object.entries(entityTypeColors) as [type, color]}
										{#if type !== "unknown"}
											<span class="h-5 inline-flex items-center gap-1 px-1.5 py-0 font-[family-name:var(--font-mono)] text-[10px] text-[var(--sig-text-muted)] border border-[rgba(255,255,255,0.14)] bg-transparent">
												<span class="inline-block w-[8px] h-[8px]" style={`background:${color}; clip-path: polygon(50% 0%, 100% 25%, 100% 75%, 50% 100%, 0% 75%, 0% 25%);`}></span>
												{type}
											</span>
										{/if}
									{/each}
								</div>
								<div class="text-[10px] text-[var(--sig-text-muted)] leading-[1.35] space-y-0.5">
									<div><span class="text-[var(--sig-text)]">Hexagon</span> = entity (large, labeled)</div>
									<div><span class="text-[var(--sig-text)]">Circle</span> = aspect (medium, orbits entity)</div>
									<div><span class="text-[var(--sig-text)]">Small dot</span> = attribute (orbits aspect)</div>
									<div><span class="text-[var(--sig-text)]">Tiny dot</span> = linked memory (leaf node)</div>
									<div><span class="text-[var(--sig-text)]">Faint lines</span> = parent-child hierarchy</div>
									<div><span class="text-[var(--sig-text)]">Styled line</span> = entity dependency</div>
								</div>
							</div>
						{/if}
					</Collapsible.Content>
				</Collapsible.Root>
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
			{#if graphInitialized}
				<EmbeddingCanvas2D
					bind:this={canvas2d}
					{nodes}
					{edges}
					{graphPhysics}
					{graphSelected}
					graphHovered={previewHovered}
					{embeddingFilterIds}
					relationLookup={effectiveRelationLookup}
					{pinnedIds}
					{lensIds}
					clusterLensMode={clusterLensMode && lensIds.size > 0}
					colorMode={nodeColorMode}
					nowMs={newnessNowMs}
					showNewSinceLastSeen={showNewSinceLastSeen}
					lastSeenMs={lastSeenMs}
					sourceFocusSources={selectedSources.size > 0 ? selectedSources : null}
					onselectnode={(e: EmbeddingPoint | null) => {
						if (e) selectEmbeddingById(e.id);
						else graphSelected = null;
					}}
					onhovernode={updateGraphHover}
				/>
			{:else if graphStatus}
				<div class="absolute inset-0 flex items-center justify-center bg-[#050505]">
					<span class="text-[var(--sig-text-muted)] font-[family-name:var(--font-mono)] text-[11px]">{graphStatus}</span>
				</div>
			{:else if graphError}
				<div class="absolute inset-0 flex items-center justify-center bg-[#050505]">
					<span class="text-[var(--sig-danger)] font-[family-name:var(--font-mono)] text-[11px]">{graphError}</span>
				</div>
			{/if}
		</div>
		<div style:display={graphMode === "3d" ? "contents" : "none"}>
			{#if Canvas3D && !canvas3dLoading}
				<Canvas3D
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
					colorMode={nodeColorMode}
					nowMs={newnessNowMs}
					showNewSinceLastSeen={showNewSinceLastSeen}
					lastSeenMs={lastSeenMs}
					sourceFocusSources={selectedSources.size > 0 ? selectedSources : null}
					onselectnode={(e: EmbeddingPoint | null) => {
						if (e) selectEmbeddingById(e.id);
						else graphSelected = null;
					}}
						onhovernode={updateGraphHover}
				/>
			{:else if canvas3dLoading}
				<div class="absolute inset-0 flex items-center justify-center bg-[#050505]">
					<span class="text-[var(--sig-text-muted)] font-[family-name:var(--font-mono)] text-[11px]">{graphStatus || "Loading 3D..."}</span>
				</div>
			{/if}
		</div>
		</div>

		<div class="w-[360px] min-w-[320px] border-l border-[var(--sig-border)] bg-[var(--sig-surface)] flex flex-col min-h-0 max-lg:w-full max-lg:min-w-0 max-lg:max-h-[48%] max-lg:border-l-0 max-lg:border-t max-lg:border-t-[var(--sig-border)]">
			<div class="p-3 border-b border-[var(--sig-border)] space-y-2 overflow-y-auto">
				<Collapsible.Root bind:open={controlsMenuOpen} class="border border-[var(--sig-border)]">
					<Collapsible.Trigger class="flex w-full items-center justify-between px-2 py-1.5 border-none text-[10px] uppercase tracking-[0.08em] font-[family-name:var(--font-mono)] text-[var(--sig-highlight)]" style="background: color-mix(in srgb, var(--sig-highlight), var(--sig-bg) 94%);">
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
									bind:this={searchInputEl}
									oninput={() => (activePresetId = "custom-live")}
									placeholder="Search constellation"
								/>
								{#if embeddingSearch}
									<span class="font-[family-name:var(--font-mono)] text-[10px] text-[var(--sig-text-muted)] border border-[var(--sig-border)] px-2 py-1">{embeddingSearchMatches.length}</span>
								{/if}
							</div>
							<div class="text-[10px] font-[family-name:var(--font-mono)] text-[var(--sig-text-muted)]">Window {activeProjectionWindow.offset + 1}-{activeProjectionWindow.offset + embeddings.length} / {embeddingsTotal}</div>
							<div class="flex flex-wrap gap-1">
								<button class="px-2 py-[2px] font-[family-name:var(--font-mono)] text-[10px] uppercase border border-[var(--sig-border-strong)] {showPinnedOnly ? 'text-[var(--sig-highlight)] bg-[color-mix(in_srgb,var(--sig-highlight),var(--sig-bg)_90%)]' : 'text-[var(--sig-text-muted)] bg-transparent'}" onclick={togglePinnedOnly}>Pinned</button>
								<button class="px-2 py-[2px] font-[family-name:var(--font-mono)] text-[10px] uppercase border border-[var(--sig-border-strong)] {showNeighborhoodOnly ? 'text-[var(--sig-highlight)] bg-[color-mix(in_srgb,var(--sig-highlight),var(--sig-bg)_90%)]' : 'text-[var(--sig-text-muted)] bg-transparent'}" onclick={toggleNeighborhoodOnly}>Neighborhood</button>
								<button class="px-2 py-[2px] font-[family-name:var(--font-mono)] text-[10px] uppercase border border-[var(--sig-border-strong)] {clusterLensMode ? 'text-[var(--sig-highlight)] bg-[color-mix(in_srgb,var(--sig-highlight),var(--sig-bg)_90%)]' : 'text-[var(--sig-text-muted)] bg-transparent'}" onclick={toggleClusterLens}>Lens</button>
								<button class="px-2 py-[2px] font-[family-name:var(--font-mono)] text-[10px] uppercase border border-[var(--sig-border-strong)] text-[var(--sig-text-muted)] hover:text-[var(--sig-text-bright)]" onclick={resetProjectionFilters}>{ActionLabels.Reset}</button>
							</div>
							<div class="border border-[var(--sig-border)] px-2 py-2 space-y-1.5">
								<div class="font-[family-name:var(--font-mono)] text-[10px] uppercase tracking-[0.08em] text-[var(--sig-text-muted)]">Color Mode</div>
								<div class="flex flex-wrap gap-1">
									<button class="px-2 py-[2px] font-[family-name:var(--font-mono)] text-[10px] uppercase border border-[var(--sig-border-strong)] {nodeColorMode === 'newness' ? 'text-[var(--sig-highlight)] bg-[color-mix(in_srgb,var(--sig-highlight),var(--sig-bg)_90%)]' : 'text-[var(--sig-text-muted)] bg-transparent'}" onclick={() => (nodeColorMode = "newness")}>Newness</button>
									<button class="px-2 py-[2px] font-[family-name:var(--font-mono)] text-[10px] uppercase border border-[var(--sig-border-strong)] {nodeColorMode === 'source' ? 'text-[var(--sig-highlight)] bg-[color-mix(in_srgb,var(--sig-highlight),var(--sig-bg)_90%)]' : 'text-[var(--sig-text-muted)] bg-transparent'}" onclick={() => (nodeColorMode = "source")}>Source</button>
									<button
										class="px-2 py-[2px] font-[family-name:var(--font-mono)] text-[10px] uppercase border border-[var(--sig-border-strong)] {nodeColorMode === 'none' ? 'text-[var(--sig-highlight)] bg-[color-mix(in_srgb,var(--sig-highlight),var(--sig-bg)_90%)]' : 'text-[var(--sig-text-muted)] bg-transparent'}"
										onclick={() => {
											nodeColorMode = "none";
											showNewSinceLastSeen = false;
										}}
									>
										None
									</button>
								</div>
							</div>
							<div class="border border-[var(--sig-border)] px-2 py-2 space-y-1.5">
								<div class="font-[family-name:var(--font-mono)] text-[10px] uppercase tracking-[0.08em] text-[var(--sig-text-muted)]">Overlays</div>
								<div class="flex flex-wrap gap-1">
									<button class="px-2 py-[2px] font-[family-name:var(--font-mono)] text-[10px] uppercase border border-[var(--sig-border-strong)] {showNewSinceLastSeen && nodeColorMode !== 'none' ? 'text-[var(--sig-highlight)] bg-[color-mix(in_srgb,var(--sig-highlight),var(--sig-bg)_90%)]' : 'text-[var(--sig-text-muted)] bg-transparent'} {nodeColorMode === 'none' ? 'opacity-60 cursor-not-allowed' : ''}" onclick={() => (showNewSinceLastSeen = !showNewSinceLastSeen)} disabled={nodeColorMode === "none"}>New since last seen</button>
									<button
										class="px-2 py-[2px] font-[family-name:var(--font-mono)] text-[10px] uppercase border border-[var(--sig-border-strong)] {showEntityOverlay ? 'text-[var(--sig-highlight)] bg-[color-mix(in_srgb,var(--sig-highlight),var(--sig-bg)_90%)]' : 'text-[var(--sig-text-muted)] bg-transparent'}"
										onclick={() => { showEntityOverlay = !showEntityOverlay; if (graphInitialized) reloadEmbeddingsGraph(); }}
									>
										{entityOverlayLoading ? 'Loading...' : 'Entities'}
									</button>
								</div>
							</div>
							<div class="border border-[var(--sig-border)] px-2 py-2 space-y-1.5" style="accent-color: var(--sig-highlight);">
								<div class="font-[family-name:var(--font-mono)] text-[10px] uppercase tracking-[0.08em] text-[var(--sig-text-muted)]">Graph Physics</div>
								<label class="block">
									<div class="flex items-center justify-between text-[10px] font-[family-name:var(--font-mono)] text-[var(--sig-text-muted)]">
										<span>center force</span>
										<span>{graphPhysics.centerForce.toFixed(2)}</span>
									</div>
									<input
										type="range"
										min="0"
										max="1"
										step="0.01"
										value={graphPhysics.centerForce}
										oninput={(event) => updateGraphPhysics({ centerForce: readInputNumber(event, graphPhysics.centerForce) })}
									/>
								</label>
								<label class="block">
									<div class="flex items-center justify-between text-[10px] font-[family-name:var(--font-mono)] text-[var(--sig-text-muted)]">
										<span>repel force</span>
										<span>{Math.round(graphPhysics.repelForce)}</span>
									</div>
									<input
										type="range"
										min="-600"
										max="-10"
										step="5"
										value={graphPhysics.repelForce}
										oninput={(event) => updateGraphPhysics({ repelForce: readInputNumber(event, graphPhysics.repelForce) })}
									/>
								</label>
								<label class="block">
									<div class="flex items-center justify-between text-[10px] font-[family-name:var(--font-mono)] text-[var(--sig-text-muted)]">
										<span>link force</span>
										<span>{graphPhysics.linkForce.toFixed(2)}</span>
									</div>
									<input
										type="range"
										min="0.01"
										max="1"
										step="0.01"
										value={graphPhysics.linkForce}
										oninput={(event) => updateGraphPhysics({ linkForce: readInputNumber(event, graphPhysics.linkForce) })}
									/>
								</label>
								<label class="block">
									<div class="flex items-center justify-between text-[10px] font-[family-name:var(--font-mono)] text-[var(--sig-text-muted)]">
										<span>link distance</span>
										<span>{Math.round(graphPhysics.linkDistance)}</span>
									</div>
									<input
										type="range"
										min="12"
										max="280"
										step="1"
										value={graphPhysics.linkDistance}
										oninput={(event) => updateGraphPhysics({ linkDistance: readInputNumber(event, graphPhysics.linkDistance) })}
									/>
								</label>
								<button
									type="button"
									class="px-2 py-[2px] font-[family-name:var(--font-mono)] text-[10px] uppercase border border-[var(--sig-border-strong)] text-[var(--sig-text-muted)] hover:text-[var(--sig-text-bright)]"
									onclick={() => updateGraphPhysics(DEFAULT_GRAPH_PHYSICS)}
								>
									Physics Reset
								</button>
							</div>
						</div>
					</Collapsible.Content>
				</Collapsible.Root>

				<Collapsible.Root bind:open={presetsMenuOpen} class="border border-[var(--sig-border)]">
					<Collapsible.Trigger class="flex w-full items-center justify-between px-2 py-1.5 border-none text-[10px] uppercase tracking-[0.08em] font-[family-name:var(--font-mono)] text-[var(--sig-highlight)]" style="background: color-mix(in srgb, var(--sig-highlight), var(--sig-bg) 94%);">
						<span>Presets</span>
						<ChevronDown class={`size-3 text-[var(--sig-text-muted)] transition-transform ${presetsMenuOpen ? 'rotate-180' : ''}`} />
					</Collapsible.Trigger>
					<Collapsible.Content>
						<div class="p-2 border-t border-[var(--sig-border)] flex flex-wrap gap-1">
							{#each builtinPresets as preset}
								<button class="px-2 py-[2px] font-[family-name:var(--font-mono)] text-[10px] uppercase border border-[var(--sig-border-strong)] {activePresetId === preset.id ? 'text-[var(--sig-highlight)] bg-[color-mix(in_srgb,var(--sig-highlight),var(--sig-bg)_90%)]' : 'text-[var(--sig-text-muted)] bg-transparent'}" onclick={() => applyPreset(preset)}>{preset.name}</button>
							{/each}
							{#each customPresets as preset}
								<div class="inline-flex items-center border border-[var(--sig-border-strong)]">
									<button class="px-2 py-[2px] font-[family-name:var(--font-mono)] text-[10px] {activePresetId === preset.id ? 'text-[var(--sig-highlight)] bg-[color-mix(in_srgb,var(--sig-highlight),var(--sig-bg)_90%)]' : 'text-[var(--sig-text-muted)] bg-transparent'}" onclick={() => applyPreset(preset)}>{preset.name}</button>
									<button class="px-1.5 py-[2px] font-[family-name:var(--font-mono)] text-[10px] text-[var(--sig-text-muted)] hover:text-[var(--sig-text-bright)]" onclick={() => removeCustomPreset(preset.id)} aria-label={`Delete ${preset.name} preset`}>×</button>
								</div>
							{/each}
							<button class="px-2 py-[2px] font-[family-name:var(--font-mono)] text-[10px] uppercase border border-[var(--sig-border-strong)] text-[var(--sig-text-muted)] hover:text-[var(--sig-text-bright)]" onclick={saveCurrentPreset}>{ActionLabels.Save}</button>
						</div>
					</Collapsible.Content>
				</Collapsible.Root>

				<Collapsible.Root bind:open={sourcesMenuOpen} class="border border-[var(--sig-border)]">
					<Collapsible.Trigger class="flex w-full items-center justify-between px-2 py-1.5 border-none text-[10px] uppercase tracking-[0.08em] font-[family-name:var(--font-mono)] text-[var(--sig-highlight)]" style="background: color-mix(in srgb, var(--sig-highlight), var(--sig-bg) 94%);">
						<span>Sources</span>
						<ChevronDown class={`size-3 text-[var(--sig-text-muted)] transition-transform ${sourcesMenuOpen ? 'rotate-180' : ''}`} />
					</Collapsible.Trigger>
					<Collapsible.Content>
						<div class="p-2 border-t border-[var(--sig-border)] flex flex-wrap gap-1">
							{#if sourceCounts.length === 0}
								<span class="text-[10px] text-[var(--sig-text-muted)]">No sources</span>
							{:else}
								{#each sourceCounts as source}
									<button class="px-2 py-[2px] font-[family-name:var(--font-mono)] text-[10px] border border-[var(--sig-border-strong)] {selectedSources.size === 0 || selectedSources.has(source.who) ? 'text-[var(--sig-highlight)] bg-[color-mix(in_srgb,var(--sig-highlight),var(--sig-bg)_90%)]' : 'text-[var(--sig-text-muted)] bg-transparent'}" onclick={() => toggleSourceFromPanel(source.who)}>{source.who} {source.count}</button>
								{/each}
							{/if}
						</div>
					</Collapsible.Content>
				</Collapsible.Root>

				<Collapsible.Root bind:open={showAdvancedFilters} class="border border-[var(--sig-border)]">
					<Collapsible.Trigger class="flex w-full items-center justify-between px-2 py-1.5 border-none text-[10px] uppercase tracking-[0.08em] font-[family-name:var(--font-mono)] text-[var(--sig-highlight)]" style="background: color-mix(in srgb, var(--sig-highlight), var(--sig-bg) 94%);">
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
										<button class="px-2 py-[2px] font-[family-name:var(--font-mono)] text-[10px] border border-[var(--sig-border-strong)] {selectedHarnesses.has(harness) ? 'text-[var(--sig-highlight)] bg-[color-mix(in_srgb,var(--sig-highlight),var(--sig-bg)_90%)]' : 'text-[var(--sig-text-muted)] bg-transparent'}" onclick={() => toggleHarness(harness)}>{harness}</button>
									{/each}
								{/if}
							</div>
							{#if typeCounts.length > 0 || selectedServerTypes.size > 0}
								<div class="flex items-center gap-1 flex-wrap">
									<span class="px-1 text-[10px] text-[var(--sig-text-muted)] uppercase font-[family-name:var(--font-mono)]">Type</span>
									{#each [...new Set([...selectedServerTypes, ...typeCounts.map((entry) => entry.value)])] as value}
										{@const count = typeCounts.find((entry) => entry.value === value)?.count ?? 0}
										<button class="px-2 py-[2px] font-[family-name:var(--font-mono)] text-[10px] border border-[var(--sig-border-strong)] {selectedServerTypes.has(value) ? 'text-[var(--sig-highlight)] bg-[color-mix(in_srgb,var(--sig-highlight),var(--sig-bg)_90%)]' : 'text-[var(--sig-text-muted)] bg-transparent'}" onclick={() => toggleServerType(value)}>{value}{count > 0 ? ` ${count}` : ""}</button>
									{/each}
								</div>
							{/if}
							{#if sourceTypeCounts.length > 0 || selectedServerSourceTypes.size > 0}
								<div class="flex items-center gap-1 flex-wrap">
									<span class="px-1 text-[10px] text-[var(--sig-text-muted)] uppercase font-[family-name:var(--font-mono)]">Source type</span>
									{#each [...new Set([...selectedServerSourceTypes, ...sourceTypeCounts.map((entry) => entry.value)])] as value}
										{@const count = sourceTypeCounts.find((entry) => entry.value === value)?.count ?? 0}
										<button class="px-2 py-[2px] font-[family-name:var(--font-mono)] text-[10px] border border-[var(--sig-border-strong)] {selectedServerSourceTypes.has(value) ? 'text-[var(--sig-highlight)] bg-[color-mix(in_srgb,var(--sig-highlight),var(--sig-bg)_90%)]' : 'text-[var(--sig-text-muted)] bg-transparent'}" onclick={() => toggleServerSourceType(value)}>{value}{count > 0 ? ` ${count}` : ""}</button>
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
				selectedNodeType={selectedNode?.nodeType ?? undefined}
				selectedEntityData={selectedNode?.entityData ?? null}
				selectedAspectData={selectedNode?.aspectData ?? null}
				selectedAttributeData={selectedNode?.attributeData ?? null}
				parentEntityId={selectedNode?.parentEntityId ?? null}
				parentAspectId={selectedNode?.parentAspectId ?? null}
				{constellationOverlay}
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

<svelte:window onkeydown={handleKeydown} />

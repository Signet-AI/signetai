<script lang="ts">
import { tick } from "svelte";
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
	saveConfigFile,
	getEmbeddings,
	searchMemories,
	recallMemories,
	getSimilarMemories,
	getDistinctWho,
	regenerateHarnesses as apiRegenerateHarnesses,
	getSecrets,
	putSecret,
	deleteSecret,
	getSkills,
	searchSkills,
	installSkill,
	uninstallSkill,
	type Memory,
	type EmbeddingPoint,
	type EmbeddingsResponse,
	type Skill,
} from "$lib/api";

let { data } = $props();

// --- Theme ---
let theme = $state<"dark" | "light">("dark");

if (browser) {
	const stored = document.documentElement.dataset.theme;
	theme = stored === "light" || stored === "dark" ? stored : "dark";
}

function toggleTheme() {
	theme = theme === "dark" ? "light" : "dark";
	document.documentElement.dataset.theme = theme;
	localStorage.setItem("signet-theme", theme);
}

// --- Tabs ---
let activeTab = $state<
	"config" | "memory" | "embeddings" | "logs" | "secrets" | "skills"
>("config");

// --- Secrets ---
let secrets = $state<string[]>([]);
let secretsLoading = $state(false);
let newSecretName = $state("");
let newSecretValue = $state("");
let secretAdding = $state(false);
let secretDeleting = $state<string | null>(null);

async function fetchSecrets() {
	secretsLoading = true;
	secrets = await getSecrets();
	secretsLoading = false;
}

async function addSecret() {
	if (!newSecretName.trim() || !newSecretValue.trim()) return;
	secretAdding = true;
	const ok = await putSecret(newSecretName.trim(), newSecretValue);
	if (ok) {
		newSecretName = "";
		newSecretValue = "";
		await fetchSecrets();
	}
	secretAdding = false;
}

async function removeSecret(name: string) {
	secretDeleting = name;
	const ok = await deleteSecret(name);
	if (ok) {
		await fetchSecrets();
	}
	secretDeleting = null;
}

// --- Skills ---
let skills = $state<Skill[]>([]);
let skillsLoading = $state(false);
let skillSearchQuery = $state("");
let skillSearchResults = $state<
	Array<{ name: string; description: string; installed: boolean }>
>([]);
let skillSearching = $state(false);
let skillInstalling = $state<string | null>(null);
let skillUninstalling = $state<string | null>(null);
let selectedSkill = $state<Skill | null>(null);

async function fetchSkills() {
	skillsLoading = true;
	skills = await getSkills();
	skillsLoading = false;
}

async function doSkillSearch() {
	if (!skillSearchQuery.trim()) {
		skillSearchResults = [];
		return;
	}
	skillSearching = true;
	skillSearchResults = await searchSkills(skillSearchQuery.trim());
	skillSearching = false;
}

async function doInstallSkill(name: string) {
	skillInstalling = name;
	const result = await installSkill(name);
	if (result.success) {
		await fetchSkills();
		skillSearchResults = skillSearchResults.map((s) =>
			s.name === name ? { ...s, installed: true } : s,
		);
	}
	skillInstalling = null;
}

async function doUninstallSkill(name: string) {
	skillUninstalling = name;
	const result = await uninstallSkill(name);
	if (result.success) {
		await fetchSkills();
		skillSearchResults = skillSearchResults.map((s) =>
			s.name === name ? { ...s, installed: false } : s,
		);
		if (selectedSkill?.name === name) {
			selectedSkill = null;
		}
	}
	skillUninstalling = null;
}

// --- Logs viewer ---
interface LogEntry {
	timestamp: string;
	level: "debug" | "info" | "warn" | "error";
	category: string;
	message: string;
	data?: Record<string, unknown>;
	duration?: number;
	error?: { name: string; message: string };
}

let logs = $state<LogEntry[]>([]);
let logsLoading = $state(false);
let logsError = $state("");
let logsStreaming = $state(false);
let logEventSource: EventSource | null = null;
let logLevelFilter = $state<string>("");
let logCategoryFilter = $state<string>("");
let logAutoScroll = $state(true);
let logContainer = $state<HTMLDivElement | null>(null);

const logCategories = [
	"daemon",
	"api",
	"memory",
	"sync",
	"git",
	"watcher",
	"embedding",
	"harness",
	"system",
];
const logLevels = ["debug", "info", "warn", "error"];

async function fetchLogs() {
	logsLoading = true;
	logsError = "";
	try {
		const params = new URLSearchParams({ limit: "200" });
		if (logLevelFilter) params.set("level", logLevelFilter);
		if (logCategoryFilter) params.set("category", logCategoryFilter);

		const res = await fetch(`/api/logs?${params}`);
		const data = await res.json();
		logs = data.logs || [];
	} catch (e) {
		logsError = "Failed to fetch logs";
	} finally {
		logsLoading = false;
	}
}

function startLogStream() {
	if (logEventSource) {
		logEventSource.close();
	}

	logsStreaming = true;
	logEventSource = new EventSource("/api/logs/stream");

	logEventSource.onmessage = (event) => {
		try {
			const entry = JSON.parse(event.data);
			if (entry.type === "connected") return;

			// Apply filters
			if (logLevelFilter && entry.level !== logLevelFilter) return;
			if (logCategoryFilter && entry.category !== logCategoryFilter) return;

			logs = [...logs.slice(-499), entry]; // Keep last 500

			// Auto-scroll
			if (logAutoScroll && logContainer) {
				setTimeout(() => {
					logContainer?.scrollTo({
						top: logContainer.scrollHeight,
						behavior: "smooth",
					});
				}, 50);
			}
		} catch {
			// Ignore parse errors
		}
	};

	logEventSource.onerror = () => {
		logsStreaming = false;
		logEventSource?.close();
		logEventSource = null;
	};
}

function stopLogStream() {
	logsStreaming = false;
	logEventSource?.close();
	logEventSource = null;
}

function toggleLogStream() {
	if (logsStreaming) {
		stopLogStream();
	} else {
		startLogStream();
	}
}

function clearLogs() {
	logs = [];
}

function formatLogTime(timestamp: string): string {
	return timestamp.split("T")[1]?.slice(0, 8) || "";
}

// Fetch logs when tab becomes active
$effect(() => {
	if (activeTab === "logs" && logs.length === 0) {
		fetchLogs();
	}
});

// Fetch secrets when tab becomes active
$effect(() => {
	if (activeTab === "secrets" && secrets.length === 0) {
		fetchSecrets();
	}
});

// Fetch skills when tab becomes active
$effect(() => {
	if (activeTab === "skills" && skills.length === 0) {
		fetchSkills();
	}
});

// Cleanup on unmount
$effect(() => {
	return () => {
		if (logEventSource) {
			logEventSource.close();
		}
		if (memorySearchTimer) {
			clearTimeout(memorySearchTimer);
			memorySearchTimer = null;
		}
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

// --- Config editor ---
let selectedFile = $state("");
let editorContent = $state("");
let saving = $state(false);
let saved = $state(false);

$effect(() => {
	if (!selectedFile && data.configFiles?.length) {
		selectedFile = data.configFiles[0].name;
	}
});

$effect(() => {
	const file = data.configFiles?.find((f: any) => f.name === selectedFile);
	editorContent = file?.content ?? "";
	saved = false;
});

function selectFile(name: string) {
	selectedFile = name;
	activeTab = "config";
}

function ext(name: string): string {
	return name.split(".").pop() ?? "";
}

function fmtSize(bytes: number): string {
	if (bytes < 1024) return `${bytes}B`;
	return `${(bytes / 1024).toFixed(1)}KB`;
}

async function saveFile() {
	saving = true;
	saved = false;
	try {
		const success = await saveConfigFile(selectedFile, editorContent);
		if (success) {
			saved = true;
			setTimeout(() => (saved = false), 2000);
		}
	} finally {
		saving = false;
	}
}

function handleKeydown(e: KeyboardEvent) {
	if ((e.metaKey || e.ctrlKey) && e.key === "s") {
		e.preventDefault();
		saveFile();
	}
}

// --- Embeddings graph ---
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

let camX = 0,
	camY = 0,
	camZoom = 1;
let isPanning = false,
	isDragging = false;
let dragNode: GraphNode | null = null;
let panStartX = 0,
	panStartY = 0;
let panCamStartX = 0,
	panCamStartY = 0;

let nodes = $state<GraphNode[]>([]);
let edges = $state<GraphEdge[]>([]);
let simulation: any = null;
let animFrame = 0;

// 3D graph state
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
	embeddings: EmbeddingPoint[],
	total: number,
	hasMore: boolean,
	error?: string,
): EmbeddingsResponse {
	const normalizedTotal = total > 0 ? total : embeddings.length;
	return {
		embeddings,
		count: embeddings.length,
		total: normalizedTotal,
		limit: requestedLimit,
		offset: 0,
		hasMore: hasMore || normalizedTotal > embeddings.length,
		error,
	};
}

async function loadEmbeddingsForGraph(limit: number): Promise<EmbeddingsResponse> {
	const requestedLimit = clampEmbeddingLimit(limit);
	const firstPage = await getEmbeddings(true, { limit: requestedLimit, offset: 0 });

	if (firstPage.error) {
		return firstPage;
	}

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
	let shouldProbeForMore = requestedLimit > merged.length && merged.length > 0;

	while (
		merged.length < requestedLimit &&
		probeCount < EMBEDDING_PAGE_PROBE_LIMIT &&
		(hasMore || shouldProbeForMore)
	) {
		const remaining = requestedLimit - merged.length;
		const page = await getEmbeddings(true, { limit: remaining, offset });

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

		if (page.total > total) {
			total = page.total;
		}
		hasMore = page.hasMore || total > merged.length;

		if (rows.length === 0 || added === 0) {
			break;
		}

		offset += rows.length;
		shouldProbeForMore = !hasMore && merged.length < requestedLimit;
		probeCount += 1;
	}

	return buildEmbeddingsResponse(
		requestedLimit,
		merged.slice(0, requestedLimit),
		total,
		hasMore,
	);
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
	for (const value of vector) {
		sum += value * value;
	}
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
	if (leftNorm === 0 || rightNorm === 0 || left.length !== right.length) {
		return 0;
	}
	let dot = 0;
	for (let i = 0; i < left.length; i++) {
		dot += left[i] * right[i];
	}
	return dot / (leftNorm * rightNorm);
}

function insertTopScore(scores: RelationScore[], next: RelationScore) {
	let index = 0;
	while (index < scores.length && scores[index].score >= next.score) {
		index += 1;
	}
	if (index >= RELATION_LIMIT) return;
	scores.splice(index, 0, next);
	if (scores.length > RELATION_LIMIT) {
		scores.pop();
	}
}

function insertBottomScore(scores: RelationScore[], next: RelationScore) {
	let index = 0;
	while (index < scores.length && scores[index].score <= next.score) {
		index += 1;
	}
	if (index >= RELATION_LIMIT) return;
	scores.splice(index, 0, next);
	if (scores.length > RELATION_LIMIT) {
		scores.pop();
	}
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
		if (candidate.id === selected.id || !hasEmbeddingVector(candidate)) {
			continue;
		}
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

	similarNeighbors = similarScores
		.map((item) => ({ ...item, kind: "similar" }));
	dissimilarNeighbors = dissimilarScores
		.map((item) => ({ ...item, kind: "dissimilar" }));
	relationCache.set(selected.id, {
		similar: similarNeighbors,
		dissimilar: dissimilarNeighbors,
	});

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
	if (relation === "similar") {
		return dimmed ? "rgba(129, 180, 255, 0.35)" : "rgba(129, 180, 255, 0.9)";
	}
	if (relation === "dissimilar") {
		return dimmed ? "rgba(255, 146, 146, 0.35)" : "rgba(255, 146, 146, 0.9)";
	}
	if (dimmed) {
		return "rgba(120, 120, 120, 0.2)";
	}
	return sourceColorRgba(node.data.who, 0.85);
}

function edgeStrokeStyle(sourceId: string, targetId: string): string {
	const sourceDimmed = isFilteredOut(sourceId);
	const targetDimmed = isFilteredOut(targetId);
	if (sourceDimmed || targetDimmed) {
		return "rgba(120, 120, 120, 0.12)";
	}
	if (relationFor(sourceId) || relationFor(targetId)) {
		return "rgba(200, 200, 200, 0.6)";
	}
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
	if (projected.length <= 450) {
		return buildExactKnnEdges(projected, k);
	}
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
			simulation?.alphaTarget(0.3).restart();
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
			simulation?.alphaTarget(0);
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
	if (activeTab === "embeddings" && canvas) {
		initGraph();
	}
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

		let minX = Infinity;
		let maxX = -Infinity;
		let minY = Infinity;
		let maxY = -Infinity;
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
		if (graphSelected) {
			focusEmbedding3D(graphSelected.id);
		}
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
		globalSimilar = await getSimilarMemories(graphSelected.id, 10, filterType || undefined);
	} finally {
		loadingGlobalSimilar = false;
	}
}

function openGlobalSimilar(memory: Memory) {
	const local = getEmbeddingById(memory.id);
	if (local) {
		selectEmbeddingById(local.id, true);
		return;
	}
	memoryQuery = memory.content;
	queueMemorySearch();
}

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
	if (graphMode === "3d") {
		refresh3DAppearance();
	}
});

$effect(() => {
	if (activeTab === "embeddings" && canvas && !graphInitialized) {
		initGraph();
	}
});

$effect(() => {
	if (
		activeTab === "embeddings" &&
		canvas &&
		graphInitialized &&
		graphMode === "2d" &&
		nodes.length > 0
	) {
		tick().then(() => {
			resizeCanvas();
			cancelAnimationFrame(animFrame);
			const context = canvas?.getContext("2d");
			if (context) draw(context);
		});
	}
});

// Clean up when leaving the embeddings tab
$effect(() => {
	if (activeTab !== "embeddings") {
		cancelAnimationFrame(animFrame);
		if (graph3d) {
			graph3d._destructor?.();
			graph3d = null;
		}
		graphMode = "2d";
	}
});

// --- Memory workspace ---
let memoryQuery = $state("");
let memoryResults = $state<Memory[]>([]);
let memorySearched = $state(false);
let searchingMemory = $state(false);
let memorySearchTimer: ReturnType<typeof setTimeout> | null = null;

// Filter panel state
let filtersOpen = $state(false);
let filterType = $state("");
let filterTags = $state("");
let filterWho = $state("");
let filterPinned = $state(false);
let filterImportanceMin = $state("");
let filterSince = $state("");
let whoOptions = $state<string[]>([]);

// Similar-results state
let similarSourceId = $state<string | null>(null);
let similarSource = $state<Memory | null>(null);
let similarResults = $state<Memory[]>([]);
let loadingSimilar = $state(false);

let hasActiveFilters = $derived(
	!!(
		filterType ||
		filterTags ||
		filterWho ||
		filterPinned ||
		filterImportanceMin ||
		filterSince
	),
);

let memoryDocs = $derived((data.memories ?? []) as Memory[]);

let displayMemories = $derived(
	similarSourceId
		? similarResults
		: memorySearched || hasActiveFilters
			? memoryResults
			: memoryDocs,
);

function queueMemorySearch() {
	if (memorySearchTimer) {
		clearTimeout(memorySearchTimer);
	}

	memorySearchTimer = setTimeout(() => {
		doSearch();
	}, 150);
}

async function doSearch() {
	if (memorySearchTimer) {
		clearTimeout(memorySearchTimer);
		memorySearchTimer = null;
	}

	const query = memoryQuery.trim();
	if (!query && !hasActiveFilters) {
		memoryResults = [];
		memorySearched = false;
		similarSourceId = null;
		similarSource = null;
		similarResults = [];
		return;
	}

	similarSourceId = null;
	similarSource = null;
	similarResults = [];
	searchingMemory = true;

	const parsedImportance = filterImportanceMin
		? parseFloat(filterImportanceMin)
		: undefined;

	try {
		if (query) {
			memoryResults = await recallMemories(query, {
				type: filterType || undefined,
				tags: filterTags || undefined,
				who: filterWho || undefined,
				pinned: filterPinned || undefined,
				importance_min: parsedImportance,
				since: filterSince || undefined,
				limit: 120,
			});
		} else {
			memoryResults = await searchMemories("", {
				type: filterType || undefined,
				tags: filterTags || undefined,
				who: filterWho || undefined,
				pinned: filterPinned || undefined,
				importance_min: parsedImportance,
				since: filterSince || undefined,
				limit: 250,
			});
		}

		memorySearched = true;
	} finally {
		searchingMemory = false;
	}
}

async function findSimilar(id: string, sourceMemory: Memory) {
	similarSourceId = id;
	similarSource = sourceMemory;
	loadingSimilar = true;
	similarResults = [];
	try {
		const results = await getSimilarMemories(id, 10, filterType || undefined);
		similarResults = results;
	} finally {
		loadingSimilar = false;
	}
}

function clearAll() {
	memoryQuery = "";
	memoryResults = [];
	memorySearched = false;
	filterType = "";
	filterTags = "";
	filterWho = "";
	filterPinned = false;
	filterImportanceMin = "";
	filterSince = "";
	similarSourceId = null;
	similarSource = null;
	similarResults = [];
	if (memorySearchTimer) {
		clearTimeout(memorySearchTimer);
		memorySearchTimer = null;
	}
}

// Trigger search whenever filters change (without needing Enter)
$effect(() => {
	// Track all filter values to react to changes
	const _ = filterType,
		__ = filterTags,
		___ = filterWho,
		____ = filterPinned,
		_____ = filterImportanceMin,
		______ = filterSince;
	if (hasActiveFilters || memorySearched) {
		queueMemorySearch();
	}
});

$effect(() => {
	// Load who options once on mount
	getDistinctWho()
		.then((values) => {
			whoOptions = values;
		})
		.catch(() => {});
});

function parseMemoryTags(raw: Memory["tags"]): string[] {
	if (!raw) {
		return [];
	}

	if (Array.isArray(raw)) {
		return raw.filter((tag) => typeof tag === "string" && tag.trim().length > 0);
	}

	const trimmed = raw.trim();
	if (!trimmed) {
		return [];
	}

	if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
		try {
			const parsed = JSON.parse(trimmed) as unknown;
			if (Array.isArray(parsed)) {
				return parsed.filter(
					(tag): tag is string =>
						typeof tag === "string" && tag.trim().length > 0,
				);
			}
		} catch {
			// Fallback to comma split below
		}
	}

	return trimmed
		.split(",")
		.map((tag) => tag.trim())
		.filter(Boolean);
}

function memoryScoreLabel(memory: Memory): string | null {
	if (typeof memory.score !== "number") {
		return null;
	}

	const score = Math.round(memory.score * 100);
	const source = memory.source ?? "semantic";
	return `${source} ${score}%`;
}

function formatDate(dateStr: string): string {
	try {
		const date = new Date(dateStr);
		return date.toLocaleString("en-US", {
			month: "short",
			day: "numeric",
			hour: "numeric",
			minute: "2-digit",
		});
	} catch {
		return dateStr;
	}
}
</script>

<svelte:head>
  <title>Signet</title>
</svelte:head>

<svelte:window onkeydown={handleKeydown} />

<div class="app">
  <!-- Header - minimal -->
  <header class="header">
    <div class="brand">
      <svg class="brand-icon" width="14" height="14" viewBox="0 0 14 14" fill="none">
        <circle cx="7" cy="7" r="6" stroke="currentColor" stroke-width="1.2"/>
        <circle cx="7" cy="7" r="2" fill="currentColor"/>
      </svg>
      <span class="brand-name">signet // codex lab</span>
    </div>

    <div class="header-signals" aria-hidden="true">
      <span class="signal-chip">NODEMAP</span>
      <span class="signal-chip signal-chip-pop">ASCII FLOW</span>
    </div>
    
    <button class="btn-icon" onclick={toggleTheme} aria-label="Toggle theme">
      {#if theme === 'dark'}
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.2">
          <circle cx="7" cy="7" r="3"/>
          <path d="M7 1v1.5M7 11.5V13M1 7h1.5M11.5 7H13M3.05 3.05l1.06 1.06M9.9 9.9l1.06 1.06M3.05 10.95l1.06-1.06M9.9 4.1l1.06-1.06"/>
        </svg>
      {:else}
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.2">
          <path d="M12 7.5a5 5 0 11-6.5-6.5 5 5 0 006.5 6.5z"/>
        </svg>
      {/if}
    </button>
  </header>

  <div class="main">
    <!-- Left Sidebar -->
    <aside class="sidebar sidebar-left">
      <section class="section">
        <div class="section-header">
          <span class="section-title">Agent</span>
          <span class="seal-indicator"></span>
        </div>
        
        <div class="field">
          <span class="field-label">Name</span>
          <span class="field-value">{data.identity?.name ?? 'Unknown'}</span>
        </div>
        
        <div class="field">
          <span class="field-label">Creature</span>
          <span class="field-value">{data.identity?.creature ?? '—'}</span>
        </div>
        
        <div class="field">
          <span class="field-label">Memories</span>
          <span class="field-value field-value-accent">{data.memoryStats?.total ?? 0}</span>
        </div>
      </section>

      <div class="divider"></div>

      <section class="section">
        <div class="section-header">
          <span class="section-title">Harnesses</span>
        </div>
        
        {#each data.harnesses ?? [] as harness}
          <div class="field">
            <div class="seal-status" class:seal-status-active={harness.exists}></div>
            <span class="field-value">{harness.name}</span>
          </div>
        {/each}
      </section>

      <div class="divider"></div>

      <section class="section section-grow">
        <div class="section-header">
          <span class="section-title">Files</span>
        </div>
        
        <div class="file-list">
          {#each data.configFiles ?? [] as file}
            {@const active = selectedFile === file.name}
            <button
              class="file-item"
              class:file-item-active={active}
              onclick={() => selectFile(file.name)}
            >
              <span class="file-name">{file.name}</span>
              <span class="file-meta">{fmtSize(file.size)}</span>
            </button>
          {/each}
        </div>
      </section>
    </aside>

    <!-- Center Panel -->
    <main class="center">
      <!-- Tabs -->
      <div class="tabs">
        <div class="tab-group">
          <button
            class="tab"
            class:tab-active={activeTab === 'config'}
            onclick={() => activeTab = 'config'}
          >
            Config
          </button>
          <button
            class="tab"
            class:tab-active={activeTab === 'memory'}
            onclick={() => activeTab = 'memory'}
          >
            Memory
          </button>
          <button
            class="tab"
            class:tab-active={activeTab === 'embeddings'}
            onclick={() => activeTab = 'embeddings'}
          >
            Embeddings
          </button>
          <button
            class="tab"
            class:tab-active={activeTab === 'logs'}
            onclick={() => activeTab = 'logs'}
          >
            Logs
          </button>
          <button
            class="tab"
            class:tab-active={activeTab === 'secrets'}
            onclick={() => activeTab = 'secrets'}
          >
            Secrets
          </button>
          <button
            class="tab"
            class:tab-active={activeTab === 'skills'}
            onclick={() => activeTab = 'skills'}
          >
            Skills
          </button>
        </div>
        
        <div class="tab-info">
          {#if activeTab === 'config'}
            <span class="filename">{selectedFile}</span>
            {#if saved}
              <span class="status-text">Saved</span>
            {/if}
            <button class="btn-primary" onclick={saveFile} disabled={saving}>
              {saving ? 'Saving...' : 'Save'}
            </button>
          {:else if activeTab === 'memory'}
            <span class="status-text">{displayMemories.length} documents</span>
            {#if searchingMemory}
              <span class="status-text">searching embeddings...</span>
            {/if}
            {#if memorySearched || hasActiveFilters || similarSourceId}
              <button class="btn-text" onclick={clearAll}>Reset</button>
            {/if}
          {:else if activeTab === 'embeddings'}
            <span class="status-text">
              {embeddings.length} embeddings{#if embeddingsHasMore} / {embeddingsTotal}{/if}
            </span>
            <label class="embedding-limit-shell">
              <span>limit</span>
              <input
                type="number"
                class="embedding-limit-input"
                min={MIN_EMBEDDING_LIMIT}
                max={MAX_EMBEDDING_LIMIT}
                step="50"
                bind:value={embeddingLimitInput}
                onkeydown={(e) => e.key === 'Enter' && applyEmbeddingLimit()}
                onchange={applyEmbeddingLimit}
              />
            </label>
            <button class="btn-icon" onclick={reloadEmbeddingsGraph} title="Reload embeddings">
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.5">
                <path d="M2 7a5 5 0 019-3M12 7a5 5 0 01-9 3"/>
                <path d="M2 4v3h3M12 10v-3h-3"/>
              </svg>
            </button>
            {#if graphInitialized && embeddings.length > 0}
              <div class="mode-toggle">
                <button
                  class="mode-btn"
                  class:mode-btn-active={graphMode === '2d'}
                  onclick={() => switchGraphMode('2d')}
                >2D</button>
                <button
                  class="mode-btn"
                  class:mode-btn-active={graphMode === '3d'}
                  onclick={() => switchGraphMode('3d')}
                >3D</button>
              </div>
            {/if}
          {:else if activeTab === 'logs'}
            <span class="status-text">{logs.length} entries</span>
            <button 
              class="btn-icon" 
              class:streaming={logsStreaming}
              onclick={toggleLogStream}
              title={logsStreaming ? 'Stop streaming' : 'Start streaming'}
            >
              {#if logsStreaming}
                <svg width="14" height="14" viewBox="0 0 14 14" fill="currentColor">
                  <rect x="3" y="3" width="8" height="8" rx="1"/>
                </svg>
              {:else}
                <svg width="14" height="14" viewBox="0 0 14 14" fill="currentColor">
                  <path d="M4 3l7 4-7 4V3z"/>
                </svg>
              {/if}
            </button>
            <button class="btn-icon" onclick={fetchLogs} title="Refresh">
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.5">
                <path d="M2 7a5 5 0 019-3M12 7a5 5 0 01-9 3"/>
                <path d="M2 4v3h3M12 10v-3h-3"/>
              </svg>
            </button>
            <button class="btn-icon" onclick={clearLogs} title="Clear">
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.5">
                <path d="M3 3l8 8M11 3l-8 8"/>
              </svg>
            </button>
          {:else if activeTab === 'secrets'}
            <span class="status-text">{secrets.length} secrets</span>
            <button class="btn-icon" onclick={fetchSecrets} title="Refresh">
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.5">
                <path d="M2 7a5 5 0 019-3M12 7a5 5 0 01-9 3"/>
                <path d="M2 4v3h3M12 10v-3h-3"/>
              </svg>
            </button>
          {:else if activeTab === 'skills'}
            <span class="status-text">{skills.length} installed</span>
            <button class="btn-icon" onclick={fetchSkills} title="Refresh">
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.5">
                <path d="M2 7a5 5 0 019-3M12 7a5 5 0 01-9 3"/>
                <path d="M2 4v3h3M12 10v-3h-3"/>
              </svg>
            </button>
          {/if}
        </div>
      </div>

      <!-- Content -->
      <div class="content">
        {#if activeTab === 'config'}
          <textarea
            class="editor"
            bind:value={editorContent}
            spellcheck="false"
            placeholder="Empty file..."
          ></textarea>
        {:else if activeTab === 'memory'}
          <section class="memory-library">
            <div class="memory-library-toolbar">
              <label class="memory-search-shell">
                <span class="memory-search-glyph">◇</span>
                <input
                  type="text"
                  class="memory-library-search"
                  bind:value={memoryQuery}
                  oninput={queueMemorySearch}
                  onkeydown={(e) => e.key === 'Enter' && doSearch()}
                  placeholder="Search across embeddings..."
                />
              </label>

              {#if memorySearched || hasActiveFilters || similarSourceId}
                <button class="btn-text memory-toolbar-clear" onclick={clearAll}>Clear</button>
              {/if}
            </div>

            <div class="memory-library-filters">
              <select class="memory-filter-select" bind:value={filterWho}>
                <option value="">Any source</option>
                {#each whoOptions as w}
                  <option>{w}</option>
                {/each}
              </select>
              <input
                class="memory-filter-input"
                placeholder="Tags (comma separated)"
                bind:value={filterTags}
              />
              <input
                type="number"
                class="memory-filter-number"
                min="0"
                max="1"
                step="0.1"
                bind:value={filterImportanceMin}
                placeholder="imp"
              />
              <input type="date" class="memory-filter-date" bind:value={filterSince} />
              <button
                class="memory-filter-pill"
                class:memory-filter-pill-active={filterPinned}
                onclick={() => filterPinned = !filterPinned}
              >
                pinned only
              </button>
            </div>

            <div class="memory-library-types">
              {#each ['fact', 'decision', 'preference', 'issue', 'learning'] as t}
                <button
                  class="memory-type-chip"
                  class:memory-type-chip-active={filterType === t}
                  onclick={() => filterType = filterType === t ? '' : t}
                >
                  {t}
                </button>
              {/each}
            </div>

            {#if similarSourceId && similarSource}
              <div class="memory-similar-banner">
                <span>
                  Similar to: {(similarSource.content ?? '').slice(0, 100)}
                  {(similarSource.content ?? '').length > 100 ? '...' : ''}
                </span>
                <button
                  class="btn-text"
                  onclick={() => {
                    similarSourceId = null;
                    similarSource = null;
                    similarResults = [];
                  }}
                >
                  Back to list
                </button>
              </div>
            {/if}

            <div class="memory-doc-grid">
              {#if loadingSimilar}
                <div class="empty memory-library-empty">Finding similar memories...</div>
              {:else}
                {#each displayMemories as memory}
                  {@const tags = parseMemoryTags(memory.tags)}
                  {@const scoreLabel = memoryScoreLabel(memory)}

                  <article class="memory-doc">
                    <header class="memory-doc-head">
                      <div class="memory-doc-stamp">
                        <span class="memory-doc-source">{memory.who || 'unknown'}</span>
                        {#if memory.type}
                          <span class="memory-doc-type">{memory.type}</span>
                        {/if}
                        {#if memory.pinned}
                          <span class="memory-doc-pin">pinned</span>
                        {/if}
                      </div>
                      <span class="memory-doc-date">{formatDate(memory.created_at)}</span>
                    </header>

                    <p class="memory-doc-content">{memory.content}</p>

                    {#if tags.length > 0}
                      <div class="memory-doc-tags">
                        {#each tags.slice(0, 6) as tag}
                          <span class="memory-doc-tag">#{tag}</span>
                        {/each}
                      </div>
                    {/if}

                    <footer class="memory-doc-foot">
                      <span class="memory-doc-importance">
                        importance {Math.round((memory.importance ?? 0) * 100)}%
                      </span>

                      {#if scoreLabel}
                        <span class="memory-doc-match">{scoreLabel}</span>
                      {/if}

                      {#if memory.id}
                        <button
                          class="btn-similar btn-similar-visible"
                          onclick={() => findSimilar(memory.id, memory)}
                          title="Find similar"
                        >
                          similar
                        </button>
                      {/if}
                    </footer>
                  </article>
                {:else}
                  <div class="empty memory-library-empty">
                    {similarSourceId
                      ? 'No similar memories found.'
                      : memorySearched || hasActiveFilters
                        ? 'No memories matched your search.'
                        : 'No memories available yet.'}
                  </div>
                {/each}
              {/if}
            </div>
          </section>
        {:else if activeTab === 'embeddings'}
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
                      <button class="embedding-relation-item" onclick={() => openGlobalSimilar(item)}>
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
        {:else if activeTab === 'logs'}
          <div class="logs-container">
            <!-- Log filters -->
            <div class="logs-filters">
              <select class="filter-select" bind:value={logLevelFilter} onchange={fetchLogs}>
                <option value="">All levels</option>
                {#each logLevels as level}
                  <option value={level}>{level}</option>
                {/each}
              </select>
              <select class="filter-select" bind:value={logCategoryFilter} onchange={fetchLogs}>
                <option value="">All categories</option>
                {#each logCategories as cat}
                  <option value={cat}>{cat}</option>
                {/each}
              </select>
              <label class="checkbox-label">
                <input type="checkbox" bind:checked={logAutoScroll} />
                Auto-scroll
              </label>
              {#if logsStreaming}
                <span class="streaming-indicator">● Live</span>
              {/if}
            </div>
            
            <!-- Log entries -->
            <div class="logs-scroll" bind:this={logContainer}>
              {#if logsLoading}
                <div class="logs-empty">Loading logs...</div>
              {:else if logsError}
                <div class="logs-empty text-error">{logsError}</div>
              {:else if logs.length === 0}
                <div class="logs-empty">No logs found</div>
              {:else}
                {#each logs as log}
                  <div class="log-entry log-{log.level}">
                    <span class="log-time">{formatLogTime(log.timestamp)}</span>
                    <span class="log-level">{log.level.toUpperCase()}</span>
                    <span class="log-category">[{log.category}]</span>
                    <span class="log-message">{log.message}</span>
                    {#if log.duration !== undefined}
                      <span class="log-duration">({log.duration}ms)</span>
                    {/if}
                    {#if log.data && Object.keys(log.data).length > 0}
                      <span class="log-data">{JSON.stringify(log.data)}</span>
                    {/if}
                    {#if log.error}
                      <div class="log-error">{log.error.name}: {log.error.message}</div>
                    {/if}
                  </div>
                {/each}
              {/if}
            </div>
          </div>
        {:else if activeTab === 'secrets'}
          <div class="secrets-container">
            <!-- Add new secret -->
            <div class="secrets-add">
              <input
                type="text"
                class="secrets-input"
                bind:value={newSecretName}
                placeholder="Secret name (e.g. OPENAI_API_KEY)"
              />
              <input
                type="password"
                class="secrets-input"
                bind:value={newSecretValue}
                placeholder="Secret value"
              />
              <button
                class="btn-primary"
                onclick={addSecret}
                disabled={secretAdding || !newSecretName.trim() || !newSecretValue.trim()}
              >
                {secretAdding ? 'Adding...' : 'Add'}
              </button>
            </div>
            
            <!-- Secrets list -->
            <div class="secrets-list">
              {#if secretsLoading}
                <div class="secrets-empty">Loading secrets...</div>
              {:else if secrets.length === 0}
                <div class="secrets-empty">No secrets stored. Add one above.</div>
              {:else}
                {#each secrets as name}
                  <div class="secret-item">
                    <span class="secret-name">{name}</span>
                    <span class="secret-value">••••••••</span>
                    <button
                      class="btn-danger-small"
                      onclick={() => removeSecret(name)}
                      disabled={secretDeleting === name}
                    >
                      {secretDeleting === name ? '...' : 'Delete'}
                    </button>
                  </div>
                {/each}
              {/if}
            </div>
          </div>
        {:else if activeTab === 'skills'}
          <div class="skills-container">
            <!-- Search skills.sh -->
            <div class="skills-search">
              <input
                type="text"
                class="skills-search-input"
                bind:value={skillSearchQuery}
                onkeydown={(e) => e.key === 'Enter' && doSkillSearch()}
                placeholder="Search skills.sh..."
              />
              <button
                class="btn-primary"
                onclick={doSkillSearch}
                disabled={skillSearching || !skillSearchQuery.trim()}
              >
                {skillSearching ? 'Searching...' : 'Search'}
              </button>
            </div>
            
            <!-- Search results -->
            {#if skillSearchResults.length > 0}
              <div class="skills-section">
                <div class="skills-section-title">Search Results</div>
                <div class="skills-list">
                  {#each skillSearchResults as result}
                    <div class="skill-item">
                      <div class="skill-info">
                        <span class="skill-name">{result.name}</span>
                        {#if result.installed}
                          <span class="skill-badge installed">Installed</span>
                        {/if}
                      </div>
                      <div class="skill-description">{result.description}</div>
                      <div class="skill-actions">
                        {#if result.installed}
                          <button
                            class="btn-danger-small"
                            onclick={() => doUninstallSkill(result.name)}
                            disabled={skillUninstalling === result.name}
                          >
                            {skillUninstalling === result.name ? '...' : 'Uninstall'}
                          </button>
                        {:else}
                          <button
                            class="btn-primary-small"
                            onclick={() => doInstallSkill(result.name)}
                            disabled={skillInstalling === result.name}
                          >
                            {skillInstalling === result.name ? '...' : 'Install'}
                          </button>
                        {/if}
                      </div>
                    </div>
                  {/each}
                </div>
              </div>
            {/if}
            
            <!-- Installed skills -->
            <div class="skills-section">
              <div class="skills-section-title">Installed ({skills.length})</div>
              <div class="skills-list">
                {#if skillsLoading}
                  <div class="skills-empty">Loading skills...</div>
                {:else if skills.length === 0}
                  <div class="skills-empty">No skills installed. Search above to find skills.</div>
                {:else}
                  {#each skills as skill}
                    <div class="skill-item" class:skill-selected={selectedSkill?.name === skill.name}>
                      <div class="skill-info">
                        <span class="skill-name">{skill.name}</span>
                        {#if skill.builtin}
                          <span class="skill-badge builtin">Built-in</span>
                        {/if}
                        {#if skill.user_invocable}
                          <span class="skill-badge invocable">/{skill.name}</span>
                        {/if}
                      </div>
                      <div class="skill-description">{skill.description}</div>
                      <div class="skill-actions">
                        {#if !skill.builtin}
                          <button
                            class="btn-danger-small"
                            onclick={() => doUninstallSkill(skill.name)}
                            disabled={skillUninstalling === skill.name}
                          >
                            {skillUninstalling === skill.name ? '...' : 'Uninstall'}
                          </button>
                        {/if}
                      </div>
                    </div>
                  {/each}
                {/if}
              </div>
            </div>
          </div>
        {/if}
      </div>

      <!-- Status Bar -->
      <div class="statusbar">
        {#if activeTab === 'config'}
          <span>{ext(selectedFile).toUpperCase()}</span>
          <span class="statusbar-right">
            <kbd>Cmd+S</kbd> to save
          </span>
        {:else if activeTab === 'memory'}
          <span>{displayMemories.length} memory documents</span>
          <span class="statusbar-right">
            {#if searchingMemory}
              semantic search in progress
            {:else if similarSourceId}
              similarity mode
            {:else}
              hybrid embedding index
            {/if}
          </span>
        {:else if activeTab === 'embeddings'}
          <span>{nodes.length} nodes · {edges.length} edges · limit {embeddingLimit}</span>
          <span class="statusbar-right">
            UMAP · {graphMode.toUpperCase()} · {#if embeddingsHasMore}{embeddingsTotal} total{:else}full set{/if}
          </span>
        {:else if activeTab === 'logs'}
          <span>{logs.length} entries</span>
          <span class="statusbar-right">
            {#if logsStreaming}
              <span class="streaming-badge">LIVE</span>
            {:else}
              Press play to stream
            {/if}
          </span>
        {:else if activeTab === 'secrets'}
          <span>{secrets.length} secrets</span>
          <span class="statusbar-right">Encrypted with libsodium</span>
        {:else if activeTab === 'skills'}
          <span>{skills.length} installed</span>
          <span class="statusbar-right">skills.sh</span>
        {/if}
      </div>
    </main>

    <!-- Right Sidebar -->
    <aside class="sidebar sidebar-right" class:sidebar-right-hidden={activeTab === 'memory'}>
      <section class="section">
        <div class="section-header">
          <span class="section-title">Memories</span>
          <span class="badge">{data.memoryStats?.total ?? 0}</span>
        </div>

        <!-- Search row -->
        <div class="search-row">
          <input
            type="text"
            class="search-input"
            bind:value={memoryQuery}
            oninput={queueMemorySearch}
            onkeydown={(e) => e.key === 'Enter' && doSearch()}
            placeholder="Search embeddings..."
          />
          <button
            class="btn-icon"
            class:filter-active={hasActiveFilters}
            onclick={() => filtersOpen = !filtersOpen}
            title="Filters"
          >
            <!-- funnel icon -->
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.3">
              <path d="M1 2h10L7 6.5V10.5L5 9.5V6.5L1 2z"/>
            </svg>
          </button>
          {#if memorySearched || hasActiveFilters || similarSourceId}
            <button class="btn-text" onclick={clearAll}>Clear</button>
          {/if}
        </div>

        <!-- Filter panel -->
        {#if filtersOpen}
          <div class="filter-panel">
            <!-- Type pills -->
            <div class="filter-row">
              {#each ['fact','decision','preference','issue','learning'] as t}
                <button
                  class="pill"
                  class:pill-active={filterType === t}
                  onclick={() => filterType = filterType === t ? '' : t}
                >{t}</button>
              {/each}
            </div>
            <!-- Who select -->
            <select class="filter-select" bind:value={filterWho}>
              <option value="">any source</option>
              {#each whoOptions as w}<option>{w}</option>{/each}
            </select>
            <!-- Tags -->
            <input
              class="filter-input"
              placeholder="tags (comma-sep)..."
              bind:value={filterTags}
            />
            <!-- Importance + Since -->
            <div class="filter-row">
              <span class="filter-label">imp ≥</span>
              <input
                type="number" class="filter-num"
                min="0" max="1" step="0.1"
                bind:value={filterImportanceMin}
              />
              <span class="filter-label">since</span>
              <input type="date" class="filter-date" bind:value={filterSince} />
            </div>
            <!-- Pinned toggle -->
            <button
              class="pill"
              class:pill-active={filterPinned}
              onclick={() => filterPinned = !filterPinned}
            >pinned only</button>
          </div>
        {/if}

        {#if similarSourceId && similarSource}
          <div class="similar-header">
            <span>∿ similar to: {(similarSource.content ?? '').slice(0, 40)}{(similarSource.content ?? '').length > 40 ? '…' : ''}</span>
            <button class="btn-text" onclick={() => { similarSourceId = null; similarSource = null; similarResults = []; }}>✕</button>
          </div>
        {:else if memorySearched || hasActiveFilters}
          <div class="search-results">
            {searchingMemory ? 'Searching…' : `${memoryResults.length} results`}
          </div>
        {/if}
      </section>

      <div class="memory-scroll">
        {#if loadingSimilar}
          <div class="empty">Finding similar…</div>
        {:else}
        {#each displayMemories as memory}
          <div class="memory-item">
            <p class="memory-content">{memory.content}</p>
            <div class="memory-footer">
              <span class="memory-source">{memory.who}</span>
              {#if memory.type}
                <span class="memory-type">{memory.type}</span>
              {/if}
              {#if memory.importance && memory.importance >= 0.9}
                <span class="memory-critical">critical</span>
              {/if}
              {#if memory.pinned}
                <span class="memory-pinned">📌</span>
              {/if}
              <span class="memory-time">{formatDate(memory.created_at)}</span>
              <button
                class="btn-similar"
                onclick={() => findSimilar(memory.id, memory)}
                title="Find similar"
              >∿</button>
            </div>
          </div>
        {:else}
          <div class="empty">
            {similarSourceId ? 'No similar memories' : memorySearched || hasActiveFilters ? 'No results' : 'No memories'}
          </div>
        {/each}
        {/if}
      </div>
    </aside>
  </div>
</div>

<style>
  /* === Layout === */
  
  .app {
    display: flex;
    flex-direction: column;
    height: 100vh;
    background: linear-gradient(180deg, rgba(61, 77, 255, 0.08), transparent 120px), var(--bg-canvas);
    color: var(--text-primary);
    overflow: hidden;
  }

  .main {
    display: flex;
    flex: 1;
    min-height: 0;
    overflow: hidden;
  }

  /* === Header === */
  
  .header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    height: 48px;
    padding: 0 var(--space-4);
    border-bottom: 1px solid var(--border-emphasis);
    backdrop-filter: blur(6px);
    flex-shrink: 0;
  }

  .brand {
    display: flex;
    align-items: center;
    gap: var(--space-2);
  }

  .brand-icon {
    color: var(--accent-seal);
  }

  .brand-name {
    font-size: 12px;
    font-weight: 600;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--text-primary);
  }

  .header-signals {
    display: flex;
    align-items: center;
    gap: 6px;
    margin-left: auto;
    margin-right: 8px;
  }

  .signal-chip {
    font-family: var(--font-mono);
    font-size: 9px;
    letter-spacing: 0.08em;
    border: 1px solid var(--border-standard);
    color: var(--text-secondary);
    padding: 2px 6px;
    border-radius: 999px;
    background: rgba(138, 168, 255, 0.08);
  }

  .signal-chip-pop {
    color: var(--bg-canvas);
    background: var(--accent-lime);
    border-color: transparent;
  }

  .btn-icon {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 28px;
    height: 28px;
    color: var(--text-tertiary);
    background: transparent;
    border: none;
    border-radius: var(--radius-sm);
    cursor: pointer;
  }

  .btn-icon:hover {
    color: var(--text-secondary);
    background: var(--bg-elevated);
  }

  /* === Sidebars === */
  
  .sidebar {
    display: flex;
    flex-direction: column;
    background: var(--bg-surface);
    overflow: hidden;
  }

  .sidebar-left {
    width: 220px;
    border-right: 1px solid var(--border-standard);
  }

  .sidebar-right {
    width: 300px;
    border-left: 1px solid var(--border-standard);
  }

  .sidebar-right-hidden {
    display: none;
  }

  .section {
    padding: var(--space-3) var(--space-3);
  }

  .section-grow {
    flex: 1;
    display: flex;
    flex-direction: column;
    min-height: 0;
    padding-bottom: var(--space-4);
  }

  .section-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: var(--space-3);
  }

  .section-title {
    font-size: 11px;
    font-weight: 500;
    color: var(--text-tertiary);
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }

  .divider {
    height: 1px;
    background: var(--border-subtle);
    margin: 0 var(--space-3);
  }

  /* === Seal Indicator === */
  
  .seal-indicator {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--accent-seal);
    box-shadow: 0 0 0 2px var(--accent-seal-ring);
  }

  .seal-status {
    width: 5px;
    height: 5px;
    border-radius: 50%;
    background: var(--text-muted);
    flex-shrink: 0;
  }

  .seal-status-active {
    background: var(--success);
    box-shadow: 0 0 0 1.5px rgba(74, 222, 128, 0.2);
  }

  /* === Fields === */
  
  .field {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    padding: var(--space-1) 0;
    font-size: 12px;
  }

  .field-label {
    color: var(--text-tertiary);
    font-family: var(--font-mono);
    font-size: 10px;
    min-width: 60px;
  }

  .field-value {
    color: var(--text-secondary);
    font-family: var(--font-mono);
  }

  .field-value-accent {
    color: var(--accent-seal);
  }

  /* === File List === */
  
  .file-list {
    display: flex;
    flex-direction: column;
    gap: 1px;
    overflow-y: auto;
  }

  .file-item {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: var(--space-2) var(--space-2);
    font-size: 12px;
    color: var(--text-secondary);
    background: transparent;
    border: none;
    border-radius: var(--radius-sm);
    cursor: pointer;
    text-align: left;
  }

  .file-item:hover {
    background: var(--bg-elevated);
    color: var(--text-primary);
  }

  .file-item-active {
    background: var(--accent-seal-dim);
    color: var(--accent-seal);
  }

  .file-name {
    font-family: var(--font-mono);
    font-size: 11px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .file-meta {
    font-family: var(--font-mono);
    font-size: 10px;
    color: var(--text-tertiary);
    flex-shrink: 0;
  }

  /* === Center Panel === */
  
  .center {
    flex: 1;
    display: flex;
    flex-direction: column;
    min-width: 0;
    background: var(--bg-canvas);
  }

  /* === Tabs === */
  
  .tabs {
    display: flex;
    align-items: center;
    justify-content: space-between;
    height: 44px;
    padding: 0 var(--space-3);
    border-bottom: 1px solid var(--border-emphasis);
    backdrop-filter: blur(6px);
    flex-shrink: 0;
  }

  .tab-group {
    display: flex;
    gap: var(--space-1);
  }

  .tab {
    padding: var(--space-1) var(--space-3);
    font-size: 12px;
    font-weight: 450;
    color: var(--text-tertiary);
    background: transparent;
    border: none;
    border-radius: var(--radius-sm);
    cursor: pointer;
  }

  .tab:hover {
    color: var(--text-secondary);
    background: var(--bg-elevated);
  }

  .tab-active {
    color: var(--text-primary);
    background: linear-gradient(135deg, rgba(138, 168, 255, 0.15), rgba(61, 77, 255, 0.12));
    border: 1px solid var(--border-accent);
  }

  .tab-info {
    display: flex;
    align-items: center;
    gap: var(--space-3);
  }

  .filename {
    font-family: var(--font-mono);
    font-size: 11px;
    color: var(--text-tertiary);
  }

  .status-text {
    font-size: 11px;
    color: var(--text-tertiary);
  }

  .embedding-limit-shell {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font-family: var(--font-mono);
    font-size: 10px;
    color: var(--text-tertiary);
  }

  .embedding-limit-input {
    width: 72px;
    font-family: var(--font-mono);
    font-size: 11px;
    color: var(--text-primary);
    background: var(--bg-elevated);
    border: 1px solid var(--border-standard);
    border-radius: var(--radius-sm);
    padding: 4px 6px;
    outline: none;
  }

  /* === Buttons === */
  
  .btn-primary {
    padding: var(--space-1) var(--space-3);
    font-size: 11px;
    font-weight: 500;
    color: var(--bg-canvas);
    background: var(--text-primary);
    border: none;
    border-radius: var(--radius-sm);
    cursor: pointer;
  }

  .btn-primary:hover {
    background: var(--text-secondary);
  }

  .btn-primary:disabled {
    opacity: 0.4;
    cursor: default;
  }

  .btn-text {
    font-size: 11px;
    color: var(--accent-seal);
    background: transparent;
    border: none;
    cursor: pointer;
    padding: 0;
  }

  .btn-text:hover {
    text-decoration: underline;
  }

  /* === Content === */
  
  .content {
    flex: 1;
    display: flex;
    flex-direction: column;
    min-height: 0;
    position: relative;
  }

  /* === Editor === */
  
  .editor {
    flex: 1;
    width: 100%;
    padding: var(--space-5);
    font-family: var(--font-mono);
    font-size: 13px;
    line-height: 1.7;
    color: var(--text-primary);
    background: transparent;
    border: none;
    resize: none;
    outline: none;
    tab-size: 2;
  }

  .editor::placeholder {
    color: var(--text-tertiary);
    font-style: italic;
  }

  /* === Memory Library === */

  .memory-library {
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
    padding: var(--space-4);
    background:
      linear-gradient(180deg, rgba(138, 168, 255, 0.08), transparent 25%),
      radial-gradient(circle at 85% 0, rgba(212, 255, 0, 0.08), transparent 40%);
  }

  .memory-library-toolbar {
    display: flex;
    align-items: center;
    gap: var(--space-3);
  }

  .memory-search-shell {
    flex: 1;
    display: flex;
    align-items: center;
    gap: var(--space-2);
    padding: var(--space-2) var(--space-3);
    border-radius: var(--radius-md);
    border: 1px solid var(--border-accent);
    background: color-mix(in srgb, var(--bg-elevated) 72%, transparent);
  }

  .memory-search-glyph {
    color: var(--accent-seal);
    font-family: var(--font-mono);
    font-size: 11px;
  }

  .memory-library-search {
    flex: 1;
    font-size: 13px;
    font-family: var(--font-mono);
    color: var(--text-primary);
    background: transparent;
    border: none;
    outline: none;
  }

  .memory-library-search::placeholder {
    color: var(--text-tertiary);
  }

  .memory-toolbar-clear {
    white-space: nowrap;
  }

  .memory-library-filters {
    display: grid;
    grid-template-columns: minmax(140px, 200px) minmax(180px, 1fr) 90px 140px auto;
    gap: var(--space-2);
    align-items: center;
  }

  .memory-filter-select,
  .memory-filter-input,
  .memory-filter-number,
  .memory-filter-date {
    width: 100%;
    font-size: 12px;
    font-family: var(--font-mono);
    color: var(--text-primary);
    background: var(--bg-elevated);
    border: 1px solid var(--border-standard);
    border-radius: var(--radius-sm);
    padding: 6px 8px;
    outline: none;
  }

  .memory-filter-pill {
    font-size: 11px;
    font-family: var(--font-mono);
    color: var(--text-secondary);
    background: transparent;
    border: 1px solid var(--border-standard);
    border-radius: 999px;
    padding: 6px 10px;
    cursor: pointer;
    white-space: nowrap;
  }

  .memory-filter-pill-active {
    color: var(--accent-seal);
    border-color: var(--accent-seal);
    background: var(--accent-seal-dim);
  }

  .memory-library-types {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2);
  }

  .memory-type-chip {
    font-size: 11px;
    font-family: var(--font-mono);
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--text-secondary);
    background: rgba(138, 168, 255, 0.06);
    border: 1px solid var(--border-standard);
    border-radius: 999px;
    padding: 4px 10px;
    cursor: pointer;
  }

  .memory-type-chip-active {
    color: var(--accent-seal);
    border-color: var(--accent-seal);
    background: var(--accent-seal-dim);
  }

  .memory-similar-banner {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-3);
    padding: var(--space-2) var(--space-3);
    border-radius: var(--radius-sm);
    border: 1px dashed var(--border-accent);
    font-family: var(--font-mono);
    font-size: 11px;
    color: var(--text-secondary);
    background: rgba(138, 168, 255, 0.04);
  }

  .memory-doc-grid {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(290px, 1fr));
    gap: var(--space-3);
    padding-right: var(--space-1);
  }

  .memory-doc {
    display: flex;
    flex-direction: column;
    min-height: 220px;
    gap: var(--space-3);
    padding: var(--space-4);
    border-radius: var(--radius-lg);
    border: 1px solid var(--border-standard);
    background:
      linear-gradient(180deg, rgba(255, 255, 255, 0.05), transparent 45%),
      var(--bg-surface);
    box-shadow:
      0 1px 0 rgba(255, 255, 255, 0.04) inset,
      0 12px 32px rgba(2, 4, 9, 0.25);
  }

  .memory-doc-head {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    gap: var(--space-2);
  }

  .memory-doc-stamp {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 6px;
  }

  .memory-doc-date {
    font-family: var(--font-mono);
    font-size: 10px;
    color: var(--text-tertiary);
    white-space: nowrap;
  }

  .memory-doc-content {
    margin: 0;
    color: var(--text-primary);
    line-height: 1.62;
    font-size: 13px;
    white-space: pre-wrap;
    word-break: break-word;
  }

  .memory-doc-tags {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }

  .memory-doc-tag,
  .memory-doc-type,
  .memory-doc-pin,
  .memory-doc-importance,
  .memory-doc-match,
  .memory-doc-source {
    font-family: var(--font-mono);
    font-size: 10px;
    border-radius: 999px;
    padding: 2px 7px;
    border: 1px solid var(--border-standard);
    color: var(--text-secondary);
    background: rgba(255, 255, 255, 0.04);
  }

  .memory-doc-source {
    color: var(--accent-seal);
    border-color: var(--border-accent);
    background: rgba(138, 168, 255, 0.12);
  }

  .memory-doc-pin {
    color: var(--accent-lime);
    border-color: color-mix(in srgb, var(--accent-lime) 45%, transparent);
    background: color-mix(in srgb, var(--accent-lime) 12%, transparent);
  }

  .memory-doc-match {
    color: var(--accent-seal);
  }

  .memory-doc-foot {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    margin-top: auto;
  }

  .btn-similar-visible {
    opacity: 1;
    margin-left: auto;
    border: 1px solid var(--border-standard);
    border-radius: 999px;
    padding: 3px 8px;
    font-size: 10px;
    letter-spacing: 0.04em;
    text-transform: uppercase;
  }

  .memory-library-empty {
    border: 1px dashed var(--border-standard);
    border-radius: var(--radius-md);
    background: rgba(138, 168, 255, 0.04);
  }

  /* === Canvas === */

  .embeddings-layout {
    flex: 1;
    min-height: 0;
    display: flex;
    background: #050505;
  }

  .canvas-container {
    flex: 1;
    position: relative;
    overflow: hidden;
    background: #050505;
  }

  .graph-toolbar {
    position: absolute;
    top: 8px;
    left: 12px;
    right: 12px;
    z-index: 8;
    display: flex;
    align-items: center;
    gap: var(--space-2);
    pointer-events: none;
  }

  .graph-toolbar-input {
    flex: 1;
    max-width: 420px;
    pointer-events: auto;
    font-family: var(--font-mono);
    font-size: 11px;
    color: var(--text-primary);
    background: rgba(5, 5, 5, 0.7);
    border: 1px solid rgba(255, 255, 255, 0.22);
    border-radius: var(--radius-sm);
    padding: 6px 9px;
    outline: none;
    backdrop-filter: blur(2px);
  }

  .graph-toolbar-meta {
    font-family: var(--font-mono);
    font-size: 10px;
    color: rgba(220, 220, 220, 0.75);
    background: rgba(5, 5, 5, 0.55);
    border: 1px solid rgba(255, 255, 255, 0.16);
    border-radius: 999px;
    padding: 4px 8px;
  }

  .graph-ascii {
    position: absolute;
    left: 14px;
    top: 44px;
    z-index: 6;
    font-family: var(--font-mono);
    font-size: 10px;
    color: rgba(212, 255, 0, 0.78);
    letter-spacing: 0.08em;
    text-transform: uppercase;
    pointer-events: none;
  }

  .graph-corners {
    position: absolute;
    inset: 0;
    pointer-events: none;
    z-index: 5;
  }

  .corner {
    position: absolute;
    width: 14px;
    height: 14px;
    border-color: rgba(255, 255, 255, 0.22);
    border-style: solid;
  }

  .corner-tl { top: 10px;    left: 10px;  border-width: 1px 0 0 1px; }
  .corner-tr { top: 10px;    right: 10px; border-width: 1px 1px 0 0; }
  .corner-bl { bottom: 10px; left: 10px;  border-width: 0 0 1px 1px; }
  .corner-br { bottom: 10px; right: 10px; border-width: 0 1px 1px 0; }

  .canvas {
    width: 100%;
    height: 100%;
    cursor: grab;
  }

  .graph3d-container {
    position: absolute;
    inset: 0;
  }

  .embedding-inspector {
    width: 340px;
    min-width: 300px;
    border-left: 1px solid rgba(255, 255, 255, 0.08);
    background: linear-gradient(180deg, rgba(255, 255, 255, 0.04), transparent 140px), #060607;
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
    padding: var(--space-3);
    overflow-y: auto;
  }

  .embedding-inspector-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-2);
  }

  .embedding-inspector-title {
    font-family: var(--font-mono);
    font-size: 11px;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--text-secondary);
  }

  .embedding-inspector-meta {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }

  .embedding-inspector-meta span,
  .embedding-inspector-tags span {
    font-family: var(--font-mono);
    font-size: 10px;
    color: var(--text-secondary);
    border: 1px solid var(--border-standard);
    border-radius: 999px;
    padding: 2px 7px;
    background: rgba(255, 255, 255, 0.04);
  }

  .embedding-inspector-source {
    font-family: var(--font-mono);
    font-size: 10px;
    color: var(--accent-seal);
    border: 1px solid var(--border-accent);
    border-radius: var(--radius-sm);
    padding: 5px 7px;
    background: rgba(138, 168, 255, 0.08);
    word-break: break-all;
  }

  .embedding-inspector-content {
    margin: 0;
    font-size: 13px;
    line-height: 1.55;
    color: var(--text-primary);
    white-space: pre-wrap;
    word-break: break-word;
  }

  .embedding-inspector-tags {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }

  .embedding-inspector-actions {
    display: flex;
    gap: var(--space-2);
  }

  .embedding-inspector-subtitle {
    font-family: var(--font-mono);
    font-size: 10px;
    color: var(--text-tertiary);
    letter-spacing: 0.04em;
    text-transform: uppercase;
  }

  .embedding-inspector-empty {
    border: 1px dashed var(--border-standard);
    border-radius: var(--radius-sm);
    padding: var(--space-3);
    font-size: 12px;
    color: var(--text-tertiary);
    line-height: 1.5;
  }

  .embedding-mode-toggle {
    align-self: flex-start;
  }

  .embedding-relation-list {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }

  .embedding-relation-item {
    display: grid;
    grid-template-columns: auto 1fr;
    gap: var(--space-2);
    align-items: start;
    width: 100%;
    text-align: left;
    border: 1px solid var(--border-standard);
    border-radius: var(--radius-sm);
    background: rgba(255, 255, 255, 0.03);
    color: var(--text-secondary);
    padding: 7px 8px;
    cursor: pointer;
  }

  .embedding-relation-item:hover {
    border-color: var(--border-accent);
    background: rgba(138, 168, 255, 0.08);
  }

  .embedding-relation-score {
    font-family: var(--font-mono);
    font-size: 10px;
    color: var(--accent-seal);
    white-space: nowrap;
  }

  .embedding-relation-text {
    font-size: 12px;
    line-height: 1.45;
    color: var(--text-primary);
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }

  /* === 2D/3D Mode Toggle === */

  .mode-toggle {
    display: flex;
    border: 1px solid var(--border-standard);
    border-radius: var(--radius-sm);
    overflow: hidden;
  }

  .mode-btn {
    padding: 2px 8px;
    font-size: 10px;
    font-weight: 500;
    font-family: var(--font-mono);
    color: var(--text-tertiary);
    background: transparent;
    border: none;
    cursor: pointer;
    letter-spacing: 0.04em;
  }

  .mode-btn:hover {
    color: var(--text-secondary);
    background: var(--bg-elevated);
  }

  .mode-btn-active {
    color: var(--accent-seal);
    background: var(--accent-seal-dim);
  }

  .overlay {
    position: absolute;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    background: var(--bg-canvas);
    z-index: 10;
  }

  .overlay p {
    font-size: 13px;
    color: var(--text-secondary);
  }

  /* === Status Bar === */
  
  .statusbar {
    display: flex;
    background: rgba(8, 11, 18, 0.7);
    align-items: center;
    justify-content: space-between;
    height: 26px;
    padding: 0 var(--space-3);
    border-top: 1px solid var(--border-subtle);
    font-size: 10px;
    font-family: var(--font-mono);
    color: var(--text-tertiary);
    flex-shrink: 0;
  }

  .statusbar-right {
    display: flex;
    align-items: center;
    gap: var(--space-2);
  }

  .statusbar kbd {
    padding: 1px 4px;
    font-size: 9px;
    color: var(--text-tertiary);
    background: var(--bg-elevated);
    border-radius: 2px;
  }

  /* === Right Sidebar === */
  
  .badge {
    font-family: var(--font-mono);
    font-size: 10px;
    color: var(--accent-seal);
    padding: 1px 5px;
    background: var(--accent-seal-dim);
    border-radius: 10px;
  }

  .search-row {
    display: flex;
    align-items: center;
    gap: var(--space-1);
  }

  .search-input {
    flex: 1;
    padding: var(--space-2) var(--space-3);
    font-size: 12px;
    font-family: var(--font-mono);
    color: var(--text-primary);
    background: linear-gradient(135deg, rgba(138, 168, 255, 0.15), rgba(61, 77, 255, 0.12));
    border: 1px solid var(--border-accent);
    border-radius: var(--radius-md);
    outline: none;
  }

  .search-input:focus {
    border-color: var(--border-accent);
  }

  .search-input::placeholder {
    color: var(--text-tertiary);
  }

  .search-results {
    font-size: 11px;
    color: var(--text-tertiary);
    margin-top: var(--space-2);
  }

  .memory-scroll {
    flex: 1;
    overflow-y: auto;
    padding: 0 var(--space-3) var(--space-4);
  }

  .memory-item {
    padding: var(--space-3) 0;
    border-bottom: 1px solid var(--border-subtle);
  }

  .memory-item:last-child {
    border-bottom: none;
  }

  .memory-content {
    font-size: 12px;
    line-height: 1.6;
    color: var(--text-secondary);
    display: -webkit-box;
    -webkit-line-clamp: 3;
    -webkit-box-orient: vertical;
    overflow: hidden;
    margin: 0 0 var(--space-2) 0;
  }

  .memory-footer {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    font-size: 10px;
  }

  .memory-source {
    font-family: var(--font-mono);
    color: var(--accent-seal);
  }

  .memory-critical {
    color: var(--warning);
    font-weight: 500;
    text-transform: uppercase;
    letter-spacing: 0.02em;
  }

  .memory-time {
    color: var(--text-tertiary);
    font-family: var(--font-mono);
  }

  .memory-type {
    font-family: var(--font-mono);
    font-size: 9px;
    color: var(--text-tertiary);
    border: 1px solid var(--border-subtle);
    border-radius: 3px;
    padding: 0 3px;
  }

  .memory-pinned {
    font-size: 9px;
  }

  .empty {
    padding: var(--space-8) var(--space-4);
    text-align: center;
    font-size: 13px;
    color: var(--text-tertiary);
  }

  /* === Filter Panel === */

  .filter-panel {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    padding: var(--space-2) 0;
    border-top: 1px solid var(--border-subtle);
  }

  .filter-row {
    display: flex;
    gap: var(--space-1);
    align-items: center;
    flex-wrap: wrap;
  }

  .pill {
    font-size: 10px;
    padding: 2px 6px;
    border-radius: 9999px;
    border: 1px solid var(--border-standard);
    background: none;
    color: var(--text-secondary);
    cursor: pointer;
    white-space: nowrap;
  }

  .pill:hover {
    border-color: var(--accent-seal);
    color: var(--accent-seal);
  }

  .pill-active {
    border-color: var(--accent-seal);
    color: var(--accent-seal);
    background: var(--accent-seal-dim);
  }

  .filter-select,
  .filter-input {
    font-size: 11px;
    font-family: var(--font-mono);
    background: var(--bg-elevated);
    border: 1px solid var(--border-standard);
    color: var(--text-primary);
    border-radius: 4px;
    padding: 3px 6px;
    width: 100%;
    outline: none;
  }

  .filter-num {
    font-size: 11px;
    font-family: var(--font-mono);
    background: var(--bg-elevated);
    border: 1px solid var(--border-standard);
    color: var(--text-primary);
    border-radius: 4px;
    padding: 3px 4px;
    width: 48px;
    outline: none;
  }

  .filter-date {
    font-size: 11px;
    font-family: var(--font-mono);
    background: var(--bg-elevated);
    border: 1px solid var(--border-standard);
    color: var(--text-primary);
    border-radius: 4px;
    padding: 3px 4px;
    flex: 1;
    outline: none;
  }

  .filter-label {
    font-size: 10px;
    color: var(--text-tertiary);
    white-space: nowrap;
    font-family: var(--font-mono);
  }

  .filter-active {
    color: var(--accent-seal) !important;
  }

  /* === Similar button === */

  .btn-similar {
    opacity: 0;
    font-size: 13px;
    color: var(--text-tertiary);
    background: none;
    border: none;
    cursor: pointer;
    margin-left: auto;
    padding: 0 2px;
    line-height: 1;
    transition: opacity 0.1s, color 0.1s;
  }

  .memory-item:hover .btn-similar {
    opacity: 1;
  }

  .btn-similar:hover {
    color: var(--accent-seal);
  }

  .similar-header {
    font-size: 11px;
    color: var(--text-secondary);
    padding: var(--space-2) 0 0;
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    gap: var(--space-2);
    font-family: var(--font-mono);
    line-height: 1.4;
  }

  /* === Utilities === */

  .text-error {
    color: var(--error);
  }

  /* === Logs === */
  
  .logs-container {
    flex: 1;
    display: flex;
    flex-direction: column;
    min-height: 0;
  }

  .logs-filters {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    padding: var(--space-2) var(--space-3);
    border-bottom: 1px solid var(--border-subtle);
    flex-shrink: 0;
  }

  .logs-filters .filter-select {
    font-size: 11px;
    padding: 4px 8px;
    min-width: 100px;
  }

  .checkbox-label {
    display: flex;
    align-items: center;
    gap: 4px;
    font-size: 11px;
    color: var(--text-secondary);
    cursor: pointer;
  }

  .checkbox-label input {
    margin: 0;
  }

  .streaming-indicator {
    color: var(--success);
    font-size: 11px;
    font-weight: 500;
    animation: pulse 2s infinite;
  }

  @keyframes pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.5; }
  }

  .streaming-badge {
    background: var(--success);
    color: var(--bg-canvas);
    font-size: 9px;
    font-weight: 600;
    padding: 2px 6px;
    border-radius: 3px;
    animation: pulse 2s infinite;
  }

  .logs-scroll {
    flex: 1;
    overflow-y: auto;
    padding: var(--space-2);
    font-family: var(--font-mono);
    font-size: 11px;
    line-height: 1.6;
  }

  .logs-empty {
    padding: var(--space-8);
    text-align: center;
    color: var(--text-tertiary);
    font-family: var(--font-sans);
    font-size: 13px;
  }

  .log-entry {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: var(--space-1);
    padding: 2px 0;
    border-bottom: 1px solid var(--border-subtle);
  }

  .log-entry:last-child {
    border-bottom: none;
  }

  .log-time {
    color: var(--text-tertiary);
    flex-shrink: 0;
  }

  .log-level {
    font-weight: 600;
    flex-shrink: 0;
    min-width: 40px;
  }

  .log-debug .log-level { color: var(--text-tertiary); }
  .log-info .log-level { color: var(--accent-seal); }
  .log-warn .log-level { color: var(--warning); }
  .log-error .log-level { color: var(--error); }

  .log-category {
    color: var(--text-secondary);
    flex-shrink: 0;
  }

  .log-message {
    color: var(--text-primary);
  }

  .log-duration {
    color: var(--text-tertiary);
  }

  .log-data {
    color: var(--text-tertiary);
    font-size: 10px;
    max-width: 300px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .log-error {
    width: 100%;
    color: var(--error);
    padding-left: 60px;
    font-size: 10px;
  }

  .btn-icon.streaming {
    color: var(--success);
  }

  /* === Secrets === */

  .secrets-container {
    height: 100%;
    display: flex;
    flex-direction: column;
    padding: 16px;
    gap: 16px;
    overflow: hidden;
  }

  .secrets-add {
    display: flex;
    gap: 8px;
    flex-shrink: 0;
  }

  .secrets-input {
    flex: 1;
    padding: 8px 12px;
    border: 1px solid var(--border-standard);
    border-radius: 6px;
    background: var(--bg-elevated);
    color: var(--text-primary);
    font-size: 13px;
  }

  .secrets-input:focus {
    outline: none;
    border-color: var(--accent-seal);
  }

  .secrets-list {
    flex: 1;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .secrets-empty {
    padding: 32px;
    text-align: center;
    color: var(--text-tertiary);
  }

  .secret-item {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 12px 16px;
    background: var(--bg-elevated);
    border-radius: 8px;
    border: 1px solid var(--border-standard);
  }

  .secret-name {
    flex: 1;
    font-family: var(--font-mono);
    font-size: 13px;
    color: var(--text-primary);
  }

  .secret-value {
    color: var(--text-tertiary);
    font-family: var(--font-mono);
    font-size: 12px;
  }

  .btn-danger-small {
    padding: 4px 10px;
    font-size: 11px;
    background: transparent;
    border: 1px solid var(--error);
    color: var(--error);
    border-radius: 4px;
    cursor: pointer;
  }

  .btn-danger-small:hover:not(:disabled) {
    background: var(--error);
    color: white;
  }

  .btn-danger-small:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  /* === Skills === */

  .skills-container {
    height: 100%;
    display: flex;
    flex-direction: column;
    padding: 16px;
    gap: 16px;
    overflow: hidden;
  }

  .skills-search {
    display: flex;
    gap: 8px;
    flex-shrink: 0;
  }

  .skills-search-input {
    flex: 1;
    padding: 8px 12px;
    border: 1px solid var(--border-standard);
    border-radius: 6px;
    background: var(--bg-elevated);
    color: var(--text-primary);
    font-size: 13px;
  }

  .skills-search-input:focus {
    outline: none;
    border-color: var(--accent-seal);
  }

  .skills-section {
    display: flex;
    flex-direction: column;
    gap: 8px;
    flex: 1;
    min-height: 0;
  }

  .skills-section-title {
    font-size: 12px;
    font-weight: 500;
    color: var(--text-secondary);
    text-transform: uppercase;
    letter-spacing: 0.5px;
    flex-shrink: 0;
  }

  .skills-list {
    flex: 1;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .skills-empty {
    padding: 32px;
    text-align: center;
    color: var(--text-tertiary);
  }

  .skill-item {
    padding: 12px 16px;
    background: var(--bg-elevated);
    border-radius: 8px;
    border: 1px solid var(--border-standard);
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  .skill-item.skill-selected {
    border-color: var(--accent-seal);
  }

  .skill-info {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .skill-name {
    font-family: var(--font-mono);
    font-size: 13px;
    font-weight: 500;
    color: var(--text-primary);
  }

  .skill-badge {
    font-size: 10px;
    padding: 2px 6px;
    border-radius: 4px;
    text-transform: uppercase;
  }

  .skill-badge.installed {
    background: var(--success);
    color: white;
  }

  .skill-badge.builtin {
    background: var(--accent-seal);
    color: white;
  }

  .skill-badge.invocable {
    background: color-mix(in srgb, var(--bg-elevated) 80%, white 20%);
    color: var(--text-secondary);
    font-family: var(--font-mono);
    text-transform: none;
  }

  .skill-description {
    font-size: 12px;
    color: var(--text-secondary);
    line-height: 1.4;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }

  .skill-actions {
    display: flex;
    gap: 8px;
    margin-top: 4px;
  }

  .btn-primary-small {
    padding: 4px 10px;
    font-size: 11px;
    background: var(--accent-seal);
    border: none;
    color: white;
    border-radius: 4px;
    cursor: pointer;
  }

  .btn-primary-small:hover:not(:disabled) {
    opacity: 0.9;
  }

  .btn-primary-small:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  /* === Responsive === */
  
  @media (max-width: 1024px) {
    .sidebar-right { display: none; }

    .embeddings-layout {
      flex-direction: column;
    }

    .embedding-inspector {
      width: 100%;
      min-width: 0;
      max-height: 42%;
      border-left: none;
      border-top: 1px solid rgba(255, 255, 255, 0.08);
    }

    .memory-library {
      padding: var(--space-3);
    }

    .memory-library-filters {
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }
  }

  @media (max-width: 768px) {
    .sidebar-left { display: none; }

    .tabs {
      overflow-x: auto;
      justify-content: flex-start;
      gap: var(--space-2);
    }

    .tab-info {
      margin-left: auto;
      flex-shrink: 0;
      gap: var(--space-2);
    }

    .embedding-limit-shell {
      display: none;
    }

    .memory-library-toolbar {
      flex-direction: column;
      align-items: stretch;
    }

    .memory-library-filters {
      grid-template-columns: 1fr;
    }

    .memory-doc-grid {
      grid-template-columns: 1fr;
    }
  }
</style>

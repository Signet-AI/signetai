<script lang="ts">
import { getConstellationOverlay } from "$lib/api";
import { onMount } from "svelte";
import { SpatialIndex } from "./canvas/hit-test";
import { GraphInputHandler } from "./canvas/input-handler";
import { renderFrame } from "./canvas/renderer";
import { KnowledgeForceSimulation } from "./canvas/simulation";
import type { GraphCanvasEdge, GraphCanvasNode, GraphRenderColors } from "./canvas/types";
import { ViewportState } from "./canvas/viewport";
import {
	KNOWLEDGE_NODE_COLORS,
	KNOWLEDGE_NODE_COLORS_DIM,
	KNOWLEDGE_RELATED_GLOW,
	type KnowledgeMapEdge,
	type KnowledgeMapEdgeKind,
	type KnowledgeMapNode,
	type KnowledgeMapNodeKind,
	buildKnowledgeMapFromConstellation,
	relatedIdsForKnowledgeNode,
} from "./knowledge-map-data";

interface Props {
	agentId?: string;
}
const { agentId = "default" }: Props = $props();

type GraphDepth = "entities" | "aspects" | "attributes" | "evidence";

const DEPTH_OPTIONS: { value: GraphDepth; label: string }[] = [
	{ value: "entities", label: "Entities" },
	{ value: "aspects", label: "Aspects" },
	{ value: "attributes", label: "Attributes" },
	{ value: "evidence", label: "Evidence" },
];

const FILTERABLE_KINDS: { kind: KnowledgeMapNodeKind; label: string }[] = [
	{ kind: "entity", label: "Entities" },
	{ kind: "aspect", label: "Aspects" },
	{ kind: "attribute", label: "Attributes" },
	{ kind: "memory", label: "Evidence" },
];

const DEFAULT_KIND_FILTER = new Set<KnowledgeMapNodeKind>(["entity", "aspect", "attribute", "memory"]);

const BASE_SIZES: Record<KnowledgeMapNodeKind, number> = {
	source: 58,
	document: 48,
	session: 46,
	aspect: 32,
	attribute: 22,
	memory: 24,
	entity: 42,
	proposal: 34,
};

const EDGE_COLORS: GraphRenderColors["edges"] = {
	contains: { color: "rgb(96, 165, 250)", alpha: 0.18, width: 1.1 },
	has_aspect: { color: "rgb(96, 165, 250)", alpha: 0.46, width: 1.35 },
	has_attribute: { color: "rgb(167, 139, 250)", alpha: 0.42, width: 1.2 },
	supports: { color: "rgb(34, 211, 238)", alpha: 0.42, width: 1.25 },
	updates: { color: "rgb(34, 211, 238)", alpha: 0.58, width: 1.8 },
	extends: { color: "rgb(14, 165, 233)", alpha: 0.36, width: 1.2 },
	mentions: { color: "rgb(59, 130, 246)", alpha: 0.12, width: 0.9 },
	about: { color: "rgb(59, 130, 246)", alpha: 0.24, width: 1.2 },
};

const RENDER_COLORS: GraphRenderColors = {
	selection: "#7cc7ff",
	selectionGlow: "rgba(59, 130, 246, 0.24)",
	text: "rgba(226, 232, 240, 0.74)",
	textMuted: "rgba(148, 163, 184, 0.66)",
	textDim: "rgba(148, 163, 184, 0.14)",
	labelShadow: "rgba(0, 0, 0, 0.82)",
	edges: EDGE_COLORS,
	relatedGlow: KNOWLEDGE_RELATED_GLOW,
};

const LEGEND_ITEMS: { kind: KnowledgeMapNodeKind; label: string }[] = [
	{ kind: "entity", label: "Entities" },
	{ kind: "aspect", label: "Aspects" },
	{ kind: "attribute", label: "Attributes" },
	{ kind: "memory", label: "Evidence" },
];

// biome-ignore lint/style/useConst: Svelte bind:this assigns to this rune.
let canvas = $state<HTMLCanvasElement | null>(null);
let simNodes = $state<GraphCanvasNode[]>([]);
let simEdges: GraphCanvasEdge[] = [];
let rawNodes = $state<KnowledgeMapNode[]>([]);
let rawEdges = $state<KnowledgeMapEdge[]>([]);
let selectedId = $state<string | null>(null);
let hoveredId = $state<string | null>(null);
let relatedIds = $state(new Set<string>());
let loading = $state(false);
let error = $state<string | null>(null);
// biome-ignore lint/style/useConst: Svelte $state primitive is reassigned by event handlers.
let legendOpen = $state(false);
let query = $state("");
let depth = $state<GraphDepth>("entities");
let kindFilter = $state(new Set(DEFAULT_KIND_FILTER));
let searchMatchIds = $state<Set<string> | null>(null);
let activeMatchIndex = $state(0);
let pinnedIds = $state(new Set<string>());
let width = $state(800);
let height = $state(600);
let zoomDisplay = $state(50);
const cardNode = $derived(selectedNode());
const selectedRelations = $derived(relationSummary(cardNode));
const visibleSummary = $derived(summaryText());
let nodeCache = new Map<string, GraphCanvasNode>();
let nodeMap = new Map<string, GraphCanvasNode>();
let viewport: ViewportState | null = null;
const spatial = new SpatialIndex();
let input: GraphInputHandler | null = null;
const sim = new KnowledgeForceSimulation();
let raf = 0;
let renderNeeded = true;
let dimProgress = 0;
let autoFitPending = false;

function nodeRadius(node: KnowledgeMapNode): number {
	const base = BASE_SIZES[node.kind];
	const weight = Math.max(0, Math.min(node.weight ?? 0, 1));
	if (node.kind === "entity") return base + Math.min(Math.log2((node.counts?.mentions ?? 0) + 1) * 3, 18);
	if (node.kind === "aspect") return base + weight * 8;
	if (node.kind === "attribute") return base + weight * 8;
	if (node.kind === "memory") return base + weight * 8;
	return base;
}

function shapeFor(kind: KnowledgeMapNodeKind): "circle" | "rect" | "hex" {
	if (kind === "source" || kind === "document" || kind === "session") return "rect";
	if (kind === "entity") return "hex";
	if (kind === "aspect" || kind === "attribute") return "rect";
	return "circle";
}

function toCanvasNode(node: KnowledgeMapNode): GraphCanvasNode {
	const cached = nodeCache.get(node.id);
	const size = nodeRadius(node);
	const next: GraphCanvasNode = {
		id: node.id,
		kind: node.kind,
		label: node.label,
		sublabel: node.sublabel,
		searchText: node.searchText,
		parentId: node.parentId,
		x: cached?.x ?? node.x,
		y: cached?.y ?? node.y,
		vx: cached?.vx ?? 0,
		vy: cached?.vy ?? 0,
		fx: cached?.fx ?? null,
		fy: cached?.fy ?? null,
		size,
		color: KNOWLEDGE_NODE_COLORS[node.kind],
		dimColor: KNOWLEDGE_NODE_COLORS_DIM[node.kind],
		shape: shapeFor(node.kind),
		data: node,
	};
	nodeCache.set(node.id, next);
	return next;
}

function toCanvasEdge(edge: KnowledgeMapEdge): GraphCanvasEdge {
	return {
		...edge,
		id: edge.id,
		sourceId: edge.source,
		targetId: edge.target,
		source: edge.source,
		target: edge.target,
	};
}

function buildSim(nodes: KnowledgeMapNode[], edges: KnowledgeMapEdge[], forceInit = false): void {
	const nextNodes = nodes.map(toCanvasNode);
	const nodeIds = new Set(nextNodes.map((node) => node.id));
	const nextEdges = edges.filter((edge) => nodeIds.has(edge.source) && nodeIds.has(edge.target)).map(toCanvasEdge);
	simNodes = nextNodes;
	simEdges = nextEdges;
	nodeMap = new Map(nextNodes.map((node) => [node.id, node]));
	spatial.rebuild(nextNodes);
	const charge = nextNodes.length > 90 ? -1500 : -2000;
	if (forceInit)
		sim.init(nextNodes, nextEdges, {
			chargeStrength: charge,
			linkDistance: 220,
			collisionPadding: 18,
			preSettleTicks: 180,
		});
	else sim.update(nextNodes, nextEdges);
	autoFitPending = forceInit;
	requestRender();
}

function applyVisibleGraph(forceInit = false): void {
	const ids = visibleNodeIds();
	const visibleNodes = rawNodes.filter((node) => ids.has(node.id) && kindAllowed(node));
	const visibleIds = new Set(visibleNodes.map((node) => node.id));
	const visibleEdges = rawEdges.filter((edge) => visibleIds.has(edge.source) && visibleIds.has(edge.target));
	buildSim(visibleNodes, visibleEdges, forceInit);
}

function visibleNodeIds(): Set<string> {
	const ids = new Set<string>();
	const trimmed = query.trim().toLowerCase();
	const matches = new Set<string>();

	for (const node of rawNodes) {
		if (node.kind === "entity") ids.add(node.id);
		if (depth !== "entities" && node.kind === "aspect") ids.add(node.id);
		if ((depth === "attributes" || depth === "evidence") && node.kind === "attribute") ids.add(node.id);
		if (depth === "evidence" && node.kind === "memory") ids.add(node.id);
		if (trimmed && searchableText(node).includes(trimmed)) matches.add(node.id);
	}

	if (selectedId) addFocusNeighborhood(ids, selectedId);

	if (trimmed) {
		for (const id of matches) {
			ids.add(id);
			addAncestors(ids, id);
			for (const child of directChildren(id)) ids.add(child.id);
		}
		searchMatchIds = matches;
		activeMatchIndex = Math.min(activeMatchIndex, Math.max(matches.size - 1, 0));
	} else {
		searchMatchIds = null;
		activeMatchIndex = 0;
	}

	return ids;
}

function kindAllowed(node: KnowledgeMapNode): boolean {
	if (node.id === selectedId) return true;
	return kindFilter.has(node.kind);
}

function searchableText(node: KnowledgeMapNode): string {
	return `${node.label} ${node.sublabel ?? ""} ${node.searchText ?? ""} ${node.preview ?? ""}`.toLowerCase();
}

function addFocusNeighborhood(ids: Set<string>, id: string): void {
	ids.add(id);
	addAncestors(ids, id);
	for (const neighbor of relatedIdsForKnowledgeNode(id, rawEdges)) ids.add(neighbor);

	const node = rawNodes.find((item) => item.id === id);
	if (!node) return;
	if (node.kind === "entity") {
		for (const aspect of directChildren(id)) {
			ids.add(aspect.id);
			if (depth === "attributes" || depth === "evidence") {
				for (const attribute of directChildren(aspect.id)) {
					ids.add(attribute.id);
					if (depth === "evidence") {
						for (const evidence of directChildren(attribute.id)) ids.add(evidence.id);
					}
				}
			}
		}
		return;
	}
	for (const child of directChildren(id)) ids.add(child.id);
}

function addAncestors(ids: Set<string>, id: string): void {
	let current = rawNodes.find((node) => node.id === id);
	while (current?.parentId) {
		ids.add(current.parentId);
		current = rawNodes.find((node) => node.id === current?.parentId);
	}
}

function directChildren(id: string): KnowledgeMapNode[] {
	return rawNodes.filter((node) => node.parentId === id);
}

async function loadMap(id: string): Promise<void> {
	loading = true;
	error = null;
	selectedId = null;
	relatedIds = new Set();
	try {
		const data = await getConstellationOverlay(id);
		if (!data) {
			error = "Could not reach daemon knowledge endpoint";
			rawNodes = [];
			rawEdges = [];
			buildSim([], [], true);
			return;
		}
		const graph = buildKnowledgeMapFromConstellation(data, { focusLabel: "Signet", limit: 96 });
		rawNodes = graph.nodes;
		rawEdges = graph.edges;
		nodeCache = new Map();
		selectedId = null;
		searchMatchIds = null;
		activeMatchIndex = 0;
		applyVisibleGraph(true);
	} catch (err) {
		error = err instanceof Error ? err.message : String(err);
	} finally {
		loading = false;
	}
}

function setupCanvasSize(el: HTMLCanvasElement): CanvasRenderingContext2D | null {
	const ctx = el.getContext("2d");
	if (!ctx) return null;
	const dpr = window.devicePixelRatio || 1;
	const cw = el.clientWidth;
	const ch = el.clientHeight;
	const max = 16384;
	const scale = Math.min(max / Math.max(cw, 1), max / Math.max(ch, 1), dpr);
	if (el.width !== Math.floor(cw * scale) || el.height !== Math.floor(ch * scale)) {
		el.width = Math.floor(cw * scale);
		el.height = Math.floor(ch * scale);
		width = cw;
		height = ch;
		renderNeeded = true;
	}
	ctx.setTransform(scale, 0, 0, scale, 0, 0);
	return ctx;
}

function requestRender(): void {
	renderNeeded = true;
}

function loop(): void {
	raf = requestAnimationFrame(loop);
	const el = canvas;
	const vp = viewport;
	if (!el || !vp) return;
	const ctx = setupCanvasSize(el);
	if (!ctx) return;
	const viewportMoving = vp.tick();
	zoomDisplay = Math.round(vp.zoom * 100);
	const targetDim = selectedId ? 1 : 0;
	const dimDelta = targetDim - dimProgress;
	let dimming = false;
	if (Math.abs(dimDelta) > 0.01) {
		dimProgress += dimDelta * 0.1;
		dimming = true;
	} else {
		dimProgress = targetDim;
	}
	const simActive = sim.isActive();
	const dragging = input?.getDraggingNode() != null;
	const spatialChanged = simActive || dragging ? spatial.rebuild(simNodes) : false;
	if (autoFitPending && simNodes.length > 0 && width > 0 && height > 0) {
		vp.fitToNodes(simNodes, width, height);
		autoFitPending = false;
	}
	if (!viewportMoving && !simActive && !dimming && !spatialChanged && !renderNeeded) return;
	renderNeeded = false;
	renderFrame(
		ctx,
		simNodes,
		simEdges,
		vp,
		width,
		height,
		{
			selectedId,
			hoveredId,
			relatedIds,
			searchMatchIds,
			dimProgress,
		},
		nodeMap,
		RENDER_COLORS,
	);
}

function selectGraphNode(node: GraphCanvasNode | null): void {
	if (!node) {
		selectedId = null;
		relatedIds = new Set();
		applyVisibleGraph();
		return;
	}
	selectedId = node.id;
	relatedIds = selectedId ? relatedIdsForKnowledgeNode(selectedId, rawEdges) : new Set();
	applyVisibleGraph();
}

function selectedNode(): KnowledgeMapNode | null {
	if (!selectedId) return null;
	const node = rawNodes.find((item) => item.id === selectedId);
	return node ?? null;
}

function fitGraph(): void {
	viewport?.fitToNodes(simNodes, width, height);
	requestRender();
}

function centerGraph(): void {
	if (simNodes.length === 0) return;
	let x = 0;
	let y = 0;
	for (const node of simNodes) {
		x += node.x;
		y += node.y;
	}
	viewport?.centerOn(x / simNodes.length, y / simNodes.length, width, height);
	requestRender();
}

function zoomBy(factor: number): void {
	const vp = viewport;
	if (!vp) return;
	vp.zoomTo(vp.zoom * factor, width / 2, height / 2);
	requestRender();
}

function selectAndCenter(id: string): void {
	selectedId = id;
	relatedIds = relatedIdsForKnowledgeNode(id, rawEdges);
	applyVisibleGraph();
	const node = nodeMap.get(id);
	if (!node) return;
	viewport?.centerOn(node.x, node.y, width, height);
	requestRender();
}

function expandSelection(): void {
	const node = selectedNode();
	if (!node) return;
	if (node.kind === "entity" && depth === "entities") depth = "aspects";
	else if (node.kind === "aspect" && (depth === "entities" || depth === "aspects")) depth = "attributes";
	else if (node.kind === "attribute") depth = "evidence";
	applyVisibleGraph();
	const visible = nodeMap.get(node.id);
	if (visible) viewport?.centerOn(visible.x, visible.y, width, height);
	requestRender();
}

function updateQuery(value: string): void {
	query = value;
	applyVisibleGraph();
	const first = [...(searchMatchIds ?? new Set<string>())][0];
	if (first) selectAndCenter(first);
}

function queryInput(event: Event): void {
	if (!(event.currentTarget instanceof HTMLInputElement)) return;
	updateQuery(event.currentTarget.value);
}

function cycleSearch(direction: 1 | -1): void {
	const matches = [...(searchMatchIds ?? new Set<string>())];
	if (matches.length === 0) return;
	activeMatchIndex = (activeMatchIndex + direction + matches.length) % matches.length;
	selectAndCenter(matches[activeMatchIndex]);
}

function setDepth(next: GraphDepth): void {
	depth = next;
	applyVisibleGraph();
}

function toggleKind(kind: KnowledgeMapNodeKind): void {
	const next = new Set(kindFilter);
	if (next.has(kind)) next.delete(kind);
	else next.add(kind);
	kindFilter = next;
	applyVisibleGraph();
}

function togglePin(id: string): void {
	const node = nodeMap.get(id);
	if (!node) return;
	const next = new Set(pinnedIds);
	if (next.has(id)) {
		next.delete(id);
		node.fx = null;
		node.fy = null;
	} else {
		next.add(id);
		node.fx = node.x;
		node.fy = node.y;
	}
	pinnedIds = next;
	requestRender();
}

function navigateSibling(direction: 1 | -1): void {
	const current = selectedNode();
	if (!current) return;
	const siblings = rawNodes.filter((node) => node.parentId === current.parentId && node.kind === current.kind);
	if (siblings.length === 0) return;
	const index = siblings.findIndex((node) => node.id === current.id);
	const next = siblings[(index + direction + siblings.length) % siblings.length];
	if (next) selectAndCenter(next.id);
}

function navigateParent(): void {
	const current = selectedNode();
	if (current?.parentId) selectAndCenter(current.parentId);
}

function navigateChild(): void {
	if (!selectedId) return;
	const child = rawNodes.find((node) => node.parentId === selectedId);
	if (child) selectAndCenter(child.id);
}

function nodeKindLabel(kind: KnowledgeMapNodeKind): string {
	return kind === "memory" ? "Evidence" : kind[0]?.toUpperCase() + kind.slice(1);
}

function footerSummary(node: KnowledgeMapNode): string {
	if (node.counts?.mentions) return `${node.counts.mentions} mentions`;
	if (node.counts?.importance) return `${node.counts.importance}% importance`;
	return node.status ?? "current";
}

function relationSummary(node: KnowledgeMapNode | null): {
	parent: KnowledgeMapNode | null;
	children: KnowledgeMapNode[];
} {
	if (!node) return { parent: null, children: [] };
	return {
		parent: node.parentId ? (rawNodes.find((item) => item.id === node.parentId) ?? null) : null,
		children: directChildren(node.id),
	};
}

function summaryText(): string {
	const total = rawNodes.length;
	const visible = simNodes.length;
	if (loading) return "Loading knowledge map...";
	if (error) return error;
	if (query.trim() && searchMatchIds) return `${searchMatchIds.size} matches • ${visible} visible of ${total}`;
	return `${visible} visible of ${total} curated nodes`;
}

function keyboard(e: KeyboardEvent): void {
	const target = e.target as HTMLElement;
	if (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable) return;
	switch (e.key) {
		case "/":
			e.preventDefault();
			document.getElementById("constellation-search")?.focus();
			break;
		case "Enter":
			e.preventDefault();
			expandSelection();
			break;
		case "z":
		case "Z":
			fitGraph();
			break;
		case "c":
		case "C":
			centerGraph();
			break;
		case "+":
		case "=":
			zoomBy(1.3);
			break;
		case "-":
		case "_":
			zoomBy(1 / 1.3);
			break;
		case "Escape":
			selectedId = null;
			relatedIds = new Set();
			applyVisibleGraph();
			requestRender();
			break;
		case "ArrowRight":
			e.preventDefault();
			navigateSibling(1);
			break;
		case "ArrowLeft":
			e.preventDefault();
			navigateSibling(-1);
			break;
		case "ArrowUp":
			e.preventDefault();
			navigateParent();
			break;
		case "ArrowDown":
			e.preventDefault();
			navigateChild();
			break;
	}
}

$effect(() => {
	void agentId;
	loadMap(agentId);
});

$effect(() => {
	void selectedId;
	void hoveredId;
	void relatedIds;
	requestRender();
});

onMount(() => {
	const el = canvas;
	if (el) {
		viewport = new ViewportState(el.clientWidth / 2, el.clientHeight / 2, 0.5);
		input = new GraphInputHandler(el, viewport, spatial, {
			onNodeHover: (node) => {
				hoveredId = node?.id ?? null;
			},
			onNodeClick: selectGraphNode,
			onNodeDragStart: () => sim.reheat(),
			onNodeDragEnd: (node) => {
				node.fx = node.x;
				node.fy = node.y;
				pinnedIds = new Set(pinnedIds).add(node.id);
				sim.coolDown();
				requestRender();
			},
			onNodeDoubleClick: (node) => {
				if (!node) return;
				selectGraphNode(node);
				expandSelection();
			},
			onRequestRender: requestRender,
		});
	}
	window.addEventListener("keydown", keyboard);
	raf = requestAnimationFrame(loop);
	return () => {
		window.removeEventListener("keydown", keyboard);
		cancelAnimationFrame(raf);
		input?.destroy();
		sim.destroy();
	};
});
</script>

<div class="knowledge-map-zone">
	<canvas bind:this={canvas} class="graph-canvas" aria-label="Signet knowledge graph"></canvas>

	<div class="graph-chrome top-left">
		<div class="map-title">SIGNET CONSTELLATION</div>
		<div class="map-subtitle">
			{visibleSummary}
		</div>
	</div>

	<div class="graph-toolbar">
		<div class="search-row">
			<input
				id="constellation-search"
				type="search"
				value={query}
				placeholder="Search constellation"
				oninput={queryInput}
			/>
			<button type="button" aria-label="Previous match" onclick={() => cycleSearch(-1)}>‹</button>
			<button type="button" aria-label="Next match" onclick={() => cycleSearch(1)}>›</button>
		</div>
		<div class="depth-tabs" aria-label="Constellation depth">
			{#each DEPTH_OPTIONS as option (option.value)}
				<button
					type="button"
					class:active={depth === option.value}
					onclick={() => setDepth(option.value)}
				>
					{option.label}
				</button>
			{/each}
		</div>
		<div class="kind-toggles" aria-label="Visible node kinds">
			{#each FILTERABLE_KINDS as item (item.kind)}
				<button
					type="button"
					class:active={kindFilter.has(item.kind)}
					onclick={() => toggleKind(item.kind)}
				>
					{item.label}
				</button>
			{/each}
		</div>
	</div>

	<div class="map-controls">
		<button type="button" onclick={fitGraph}>Fit <kbd>Z</kbd></button>
		<button type="button" onclick={centerGraph}>Center <kbd>C</kbd></button>
		<div class="zoom-row">
			<span>{zoomDisplay}%</span>
			<button type="button" aria-label="Zoom out" onclick={() => zoomBy(1 / 1.3)}>-</button>
			<button type="button" aria-label="Zoom in" onclick={() => zoomBy(1.3)}>+</button>
		</div>
		<div class="legend-shell">
			<button type="button" class="legend-toggle" onclick={() => (legendOpen = !legendOpen)}>› Legend</button>
			{#if legendOpen}
				<div class="legend-list">
					{#each LEGEND_ITEMS as item (item.kind)}
						<div class="legend-item">
							<span class="legend-dot" style="background: {KNOWLEDGE_NODE_COLORS[item.kind]}"></span>
							<span>{item.label}</span>
						</div>
					{/each}
				</div>
			{/if}
		</div>
	</div>

	{#if cardNode}
		<aside class="node-inspector">
			<div class="node-card-kind">{nodeKindLabel(cardNode.kind)} {cardNode.sublabel ? `• ${cardNode.sublabel}` : ""}</div>
			<div class="node-card-title">{cardNode.label}</div>
			{#if cardNode.preview}
				<div class="node-card-preview">{cardNode.preview}</div>
			{/if}
			{#if cardNode.details?.length}
				<div class="node-detail-list">
					{#each cardNode.details as row (`${row.label}:${row.value}`)}
						<div class="node-detail-row">
							<span>{row.label}</span>
							<strong>{row.value}</strong>
						</div>
					{/each}
				</div>
			{/if}
			<div class="inspector-actions">
				<button type="button" onclick={expandSelection}>Expand</button>
				<button type="button" onclick={() => togglePin(cardNode.id)}>
					{pinnedIds.has(cardNode.id) ? "Unpin" : "Pin"}
				</button>
				{#if selectedRelations.parent}
					<button type="button" onclick={() => selectedRelations.parent && selectAndCenter(selectedRelations.parent.id)}>Parent</button>
				{/if}
			</div>
			{#if selectedRelations.children.length}
				<div class="relation-list">
					<div class="relation-heading">Children</div>
					{#each selectedRelations.children.slice(0, 8) as child (child.id)}
						<button type="button" onclick={() => selectAndCenter(child.id)}>
							<span>{nodeKindLabel(child.kind)}</span>
							<strong>{child.label}</strong>
						</button>
					{/each}
				</div>
			{/if}
			<div class="node-card-footer">
				<span>{footerSummary(cardNode)}</span>
				<code>{cardNode.id.length > 18 ? `${cardNode.id.slice(0, 10)}...${cardNode.id.slice(-5)}` : cardNode.id}</code>
			</div>
		</aside>
	{/if}
</div>

<style>
	.knowledge-map-zone {
		position: relative;
		height: 100%;
		min-height: 0;
		overflow: hidden;
		background:
			radial-gradient(circle at 50% 105%, rgba(14, 116, 144, 0.36), transparent 34%),
			radial-gradient(circle at 42% 72%, rgba(37, 99, 235, 0.22), transparent 28%),
			linear-gradient(180deg, #02040a 0%, #040712 55%, #071225 100%);
	}

	.knowledge-map-zone::before {
		position: absolute;
		inset: 0;
		content: "";
		background-image: radial-gradient(rgba(96, 165, 250, 0.42) 1px, transparent 1px);
		background-size: 36px 36px;
		opacity: 0.38;
		pointer-events: none;
	}

	.graph-canvas {
		position: absolute;
		inset: 0;
		display: block;
		width: 100%;
		height: 100%;
		touch-action: none;
	}

	.graph-chrome {
		position: absolute;
		z-index: 4;
		pointer-events: none;
	}

	.top-left {
		top: 18px;
		left: 20px;
	}

	.map-title {
		font-family: var(--font-heading);
		font-size: 13px;
		letter-spacing: 0.18em;
		color: rgba(226, 232, 240, 0.92);
	}

	.map-subtitle {
		margin-top: 4px;
		font-family: var(--font-body);
		font-size: 10px;
		letter-spacing: 0.08em;
		color: rgba(148, 163, 184, 0.66);
		text-transform: uppercase;
	}

	.map-controls {
		position: absolute;
		left: 22px;
		bottom: 22px;
		z-index: 6;
		display: flex;
		flex-direction: column;
		gap: 8px;
		align-items: flex-start;
	}

	.graph-toolbar {
		position: absolute;
		top: 18px;
		right: 22px;
		z-index: 7;
		display: grid;
		gap: 8px;
		width: min(420px, calc(100% - 360px));
	}

	.search-row,
	.depth-tabs,
	.kind-toggles {
		display: flex;
		align-items: center;
		gap: 6px;
	}

	.search-row input {
		min-width: 0;
		flex: 1;
		height: 36px;
		padding: 0 12px;
		border: 1px solid rgba(71, 85, 105, 0.78);
		border-radius: 6px;
		background: rgba(15, 23, 42, 0.76);
		color: rgba(241, 245, 249, 0.92);
		font-family: var(--font-body);
		font-size: 12px;
		box-shadow: 0 18px 44px rgba(0, 0, 0, 0.3);
		backdrop-filter: blur(14px);
	}

	.search-row input:focus {
		outline: none;
		border-color: rgba(125, 211, 252, 0.8);
		background: rgba(15, 23, 42, 0.9);
	}

	.map-controls button,
	.zoom-row,
	.legend-list,
	.node-inspector,
	.graph-toolbar button {
		border: 1px solid rgba(71, 85, 105, 0.78);
		background: rgba(15, 23, 42, 0.76);
		box-shadow: 0 18px 44px rgba(0, 0, 0, 0.34);
		backdrop-filter: blur(14px);
	}

	.map-controls button,
	.graph-toolbar button,
	.inspector-actions button,
	.relation-list button {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		gap: 8px;
		height: 36px;
		padding: 0 14px;
		border-radius: 6px;
		font-family: var(--font-body);
		font-size: 12px;
		color: rgba(241, 245, 249, 0.92);
		cursor: pointer;
	}

	.map-controls button:hover,
	.graph-toolbar button:hover,
	.inspector-actions button:hover,
	.relation-list button:hover,
	.graph-toolbar button.active {
		border-color: rgba(96, 165, 250, 0.78);
		background: rgba(30, 41, 59, 0.88);
	}

	.map-controls button {
		min-width: 96px;
		border-radius: 18px;
		justify-content: flex-start;
		gap: 12px;
	}

	.search-row button {
		width: 36px;
		padding: 0;
	}

	.depth-tabs button,
	.kind-toggles button {
		height: 30px;
		font-family: var(--font-mono);
		font-size: 10px;
		letter-spacing: 0.07em;
		text-transform: uppercase;
	}

	kbd {
		padding: 1px 6px;
		border-radius: 5px;
		border: 1px solid rgba(71, 85, 105, 0.72);
		font-family: var(--font-mono);
		font-size: 10px;
		color: rgba(148, 163, 184, 0.82);
	}

	.zoom-row {
		display: flex;
		align-items: center;
		gap: 8px;
		height: 38px;
		padding: 0 10px 0 15px;
		border-radius: 19px;
		font-family: var(--font-body);
		font-size: 12px;
		color: rgba(241, 245, 249, 0.9);
	}

	.zoom-row button {
		min-width: 28px;
		width: 28px;
		height: 28px;
		justify-content: center;
		padding: 0;
		border-radius: 8px;
	}

	.legend-shell {
		display: flex;
		flex-direction: column;
		gap: 6px;
	}

	.legend-toggle {
		min-width: 168px !important;
		justify-content: flex-start;
		border-radius: 5px !important;
	}

	.legend-list {
		display: flex;
		flex-direction: column;
		gap: 6px;
		padding: 10px 12px;
		border-radius: 6px;
	}

	.legend-item {
		display: flex;
		align-items: center;
		gap: 8px;
		font-family: var(--font-body);
		font-size: 10px;
		letter-spacing: 0.07em;
		color: rgba(203, 213, 225, 0.72);
		text-transform: uppercase;
	}

	.legend-dot {
		width: 8px;
		height: 8px;
		border-radius: 999px;
		box-shadow: 0 0 14px currentColor;
	}

	.node-inspector {
		position: absolute;
		top: 154px;
		right: 22px;
		bottom: 22px;
		width: min(360px, calc(100% - 44px));
		z-index: 8;
		display: flex;
		flex-direction: column;
		padding: 16px 18px 12px;
		border-radius: 8px;
		overflow: hidden;
		color: rgba(241, 245, 249, 0.94);
	}

	.node-card-kind {
		font-family: var(--font-mono);
		font-size: 10px;
		letter-spacing: 0.09em;
		text-transform: uppercase;
		color: rgba(96, 165, 250, 0.82);
	}

	.node-card-title {
		margin-top: 8px;
		font-family: var(--font-body);
		font-size: 16px;
		line-height: 1.25;
	}

	.node-card-preview {
		margin-top: 12px;
		max-height: 120px;
		overflow: auto;
		font-family: var(--font-body);
		font-size: 12px;
		line-height: 1.45;
		color: rgba(203, 213, 225, 0.74);
	}

	.node-detail-list {
		display: grid;
		gap: 8px;
		margin-top: 14px;
		padding-top: 12px;
		border-top: 1px solid rgba(71, 85, 105, 0.46);
		overflow: auto;
	}

	.node-detail-row {
		display: grid;
		grid-template-columns: 86px minmax(0, 1fr);
		gap: 10px;
		align-items: baseline;
		font-family: var(--font-body);
		font-size: 11px;
		line-height: 1.35;
	}

	.node-detail-row span,
	.relation-heading,
	.relation-list button span {
		font-family: var(--font-mono);
		font-size: 9px;
		letter-spacing: 0.08em;
		text-transform: uppercase;
		color: rgba(125, 211, 252, 0.6);
	}

	.node-detail-row strong {
		min-width: 0;
		max-height: 48px;
		overflow: hidden;
		font-weight: 500;
		color: rgba(226, 232, 240, 0.84);
	}

	.inspector-actions {
		display: flex;
		flex-wrap: wrap;
		gap: 8px;
		margin-top: 14px;
	}

	.inspector-actions button {
		min-width: 84px;
		border: 1px solid rgba(71, 85, 105, 0.78);
		background: rgba(15, 23, 42, 0.72);
	}

	.relation-list {
		display: grid;
		gap: 7px;
		margin-top: 14px;
		padding-top: 12px;
		border-top: 1px solid rgba(71, 85, 105, 0.46);
		overflow: auto;
	}

	.relation-list button {
		display: grid;
		grid-template-columns: 60px minmax(0, 1fr);
		justify-content: initial;
		height: auto;
		min-height: 34px;
		padding: 8px 10px;
		border: 1px solid rgba(71, 85, 105, 0.62);
		background: rgba(15, 23, 42, 0.48);
		text-align: left;
	}

	.relation-list button strong {
		min-width: 0;
		overflow: hidden;
		font-size: 11px;
		font-weight: 500;
		text-overflow: ellipsis;
		white-space: nowrap;
		color: rgba(226, 232, 240, 0.84);
	}

	.node-card-footer {
		display: flex;
		justify-content: space-between;
		gap: 14px;
		margin-top: auto;
		padding-top: 10px;
		border-top: 1px solid rgba(71, 85, 105, 0.56);
		font-family: var(--font-mono);
		font-size: 10px;
		color: rgba(148, 163, 184, 0.78);
	}

	.node-card-footer code {
		font-family: var(--font-mono);
		color: rgba(148, 163, 184, 0.86);
	}

	@media (max-width: 900px) {
		.graph-toolbar {
			left: 20px;
			right: 20px;
			width: auto;
			top: 68px;
		}

		.node-inspector {
			top: auto;
			left: 20px;
			right: 20px;
			bottom: 20px;
			width: auto;
			max-height: 42%;
		}
	}
</style>

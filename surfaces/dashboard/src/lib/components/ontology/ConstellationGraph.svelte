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

const BASE_SIZES: Record<KnowledgeMapNodeKind, number> = {
	source: 58,
	document: 48,
	session: 46,
	claim: 36,
	memory: 24,
	entity: 42,
	proposal: 34,
};

const EDGE_COLORS: GraphRenderColors["edges"] = {
	contains: { color: "rgb(96, 165, 250)", alpha: 0.22, width: 1.1 },
	derives: { color: "rgb(56, 189, 248)", alpha: 0.3, width: 1.15 },
	supports: { color: "rgb(167, 139, 250)", alpha: 0.42, width: 1.35 },
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
	{ kind: "source", label: "Sources" },
	{ kind: "entity", label: "Anchors" },
	{ kind: "claim", label: "Claims" },
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
let width = $state(800);
let height = $state(600);
let zoomDisplay = $state(50);
const cardNode = $derived(selectedNode());
const cardScreen = $derived(selectedScreen());
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
	if (node.kind === "claim") return base + weight * 12;
	if (node.kind === "memory") return base + weight * 8;
	return base;
}

function shapeFor(kind: KnowledgeMapNodeKind): "circle" | "rect" | "hex" {
	if (kind === "source" || kind === "document" || kind === "session") return "rect";
	if (kind === "entity") return "hex";
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
	const charge = nextNodes.length > 90 ? -80 : -140;
	if (forceInit) sim.init(nextNodes, nextEdges, { chargeStrength: charge, linkDistance: 98, preSettleTicks: 180 });
	else sim.update(nextNodes, nextEdges);
	autoFitPending = forceInit;
	requestRender();
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
		buildSim(graph.nodes, graph.edges, true);
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
		return;
	}
	selectedId = selectedId === node.id ? null : node.id;
	relatedIds = selectedId ? relatedIdsForKnowledgeNode(selectedId, rawEdges) : new Set();
}

function selectedNode(): KnowledgeMapNode | null {
	if (!selectedId) return null;
	const node = rawNodes.find((item) => item.id === selectedId);
	return node ?? null;
}

function selectedScreen(): { x: number; y: number } | null {
	if (!selectedId || !viewport) return null;
	const node = nodeMap.get(selectedId);
	if (!node) return null;
	return viewport.worldToScreen(node.x, node.y);
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
	const node = nodeMap.get(id);
	if (!node) return;
	selectedId = id;
	relatedIds = relatedIdsForKnowledgeNode(id, rawEdges);
	viewport?.centerOn(node.x, node.y, width, height);
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

function cardStyle(screen: { x: number; y: number } | null): string {
	if (!screen) return "display: none";
	const cardWidth = 360;
	const cardHeight = 220;
	const left = Math.max(20, Math.min(width - cardWidth - 20, screen.x + 28));
	const top = Math.max(76, Math.min(height - cardHeight - 20, screen.y - 72));
	return `left: ${left}px; top: ${top}px; width: ${cardWidth}px`;
}

function nodeKindLabel(kind: KnowledgeMapNodeKind): string {
	return kind === "memory" ? "Evidence" : kind[0]?.toUpperCase() + kind.slice(1);
}

function keyboard(e: KeyboardEvent): void {
	const target = e.target as HTMLElement;
	if (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable) return;
	switch (e.key) {
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
			onNodeDragEnd: () => sim.coolDown(),
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
			{#if loading}
				Loading knowledge map...
			{:else if error}
				{error}
			{:else}
				{simNodes.length} curated nodes • evidence-first view
			{/if}
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
		<div class="node-card" style={cardStyle(cardScreen)}>
			<div class="node-card-kind">{nodeKindLabel(cardNode.kind)} {cardNode.sublabel ? `• ${cardNode.sublabel}` : ""}</div>
			<div class="node-card-title">{cardNode.label}</div>
			{#if cardNode.preview}
				<div class="node-card-preview">{cardNode.preview}</div>
			{/if}
			<div class="node-card-footer">
				<span>{cardNode.counts?.mentions ? `${cardNode.counts.mentions} mentions` : cardNode.status ?? "current"}</span>
				<code>{cardNode.id.length > 18 ? `${cardNode.id.slice(0, 10)}...${cardNode.id.slice(-5)}` : cardNode.id}</code>
			</div>
		</div>
		<div class="node-actions" style={cardScreen ? `left: ${Math.max(20, Math.min(width - 220, cardScreen.x + 408))}px; top: ${Math.max(88, Math.min(height - 190, cardScreen.y - 44))}px` : "display: none"}>
			<button type="button" onclick={navigateParent}>↑ Parent</button>
			<button type="button" onclick={navigateChild}>↓ Evidence</button>
			<button type="button" onclick={() => navigateSibling(1)}>→ Next</button>
			<button type="button" onclick={() => navigateSibling(-1)}>← Prev</button>
		</div>
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

	.map-controls button,
	.zoom-row,
	.legend-list,
	.node-card,
	.node-actions button {
		border: 1px solid rgba(71, 85, 105, 0.78);
		background: rgba(15, 23, 42, 0.76);
		box-shadow: 0 18px 44px rgba(0, 0, 0, 0.34);
		backdrop-filter: blur(14px);
	}

	.map-controls button,
	.node-actions button {
		display: inline-flex;
		align-items: center;
		gap: 12px;
		min-width: 96px;
		height: 36px;
		padding: 0 14px;
		border-radius: 18px;
		font-family: var(--font-body);
		font-size: 12px;
		color: rgba(241, 245, 249, 0.92);
		cursor: pointer;
	}

	.map-controls button:hover,
	.node-actions button:hover {
		border-color: rgba(96, 165, 250, 0.78);
		background: rgba(30, 41, 59, 0.88);
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

	.node-card {
		position: absolute;
		z-index: 8;
		border-radius: 10px;
		padding: 16px 18px 12px;
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
		max-height: 92px;
		overflow: hidden;
		font-family: var(--font-body);
		font-size: 12px;
		line-height: 1.45;
		color: rgba(203, 213, 225, 0.74);
	}

	.node-card-footer {
		display: flex;
		justify-content: space-between;
		gap: 14px;
		margin-top: 14px;
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

	.node-actions {
		position: absolute;
		z-index: 9;
		display: flex;
		flex-direction: column;
		gap: 8px;
	}

	.node-actions button {
		min-width: 132px;
		justify-content: flex-start;
		border-radius: 8px;
	}
</style>

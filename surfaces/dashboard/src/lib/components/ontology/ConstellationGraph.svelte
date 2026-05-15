<script lang="ts">
import type { ConstellationEntity } from "$lib/api";
import { onMount } from "svelte";
import { SpatialIndex } from "./canvas/hit-test";
import { GraphInputHandler } from "./canvas/input-handler";
import { renderFrame } from "./canvas/renderer";
import { KnowledgeForceSimulation } from "./canvas/simulation";
import type { GraphCanvasEdge, GraphCanvasNode, GraphRenderColors } from "./canvas/types";
import { ViewportState } from "./canvas/viewport";
import {
	NODE_COLORS,
	NODE_COLORS_DIM,
	type OntologyEdge,
	type OntologyEdgeKind,
	type OntologyNode,
	type OntologyNodeKind,
	RELATED_GLOW,
} from "./ontology-data";
import { clearHover, clearSelection, hoverNode, loadGraph, ontology, selectNode } from "./ontology-state.svelte";

interface Props {
	agentId?: string;
}
const { agentId = "default" }: Props = $props();

const BASE_SIZES: Record<OntologyNodeKind, number> = {
	entity: 52,
	aspect: 36,
	attribute: 24,
};

const ENTITY_MIN_SIZE = 48;
const ENTITY_MAX_SIZE = 74;

const EDGE_COLORS: GraphRenderColors["edges"] = {
	dependency: { color: "rgb(245, 158, 11)", alpha: 0.18, width: 1.5 },
	has_aspect: { color: "rgb(139, 92, 246)", alpha: 0.2, width: 1 },
	has_attribute: { color: "rgb(6, 182, 212)", alpha: 0.12, width: 1 },
};

const RENDER_COLORS: GraphRenderColors = {
	selection: "#c8ff00",
	selectionGlow: "rgba(200, 255, 0, 0.15)",
	text: "rgba(220, 220, 228, 0.8)",
	textMuted: "rgba(200, 200, 208, 0.5)",
	textDim: "rgba(200, 200, 208, 0.15)",
	labelShadow: "rgba(0, 0, 0, 0.6)",
	edges: EDGE_COLORS,
	relatedGlow: RELATED_GLOW,
};

const LEGEND_ITEMS: { kind: OntologyNodeKind; label: string }[] = [
	{ kind: "entity", label: "Entities" },
	{ kind: "aspect", label: "Aspects" },
	{ kind: "attribute", label: "Attributes" },
];

// biome-ignore lint/style/useConst: Svelte bind:this assigns to this rune.
let canvas = $state<HTMLCanvasElement | null>(null);
let simNodes = $state<GraphCanvasNode[]>([]);
let simEdges: GraphCanvasEdge[] = [];
let lastFilter = "";
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
let width = 800;
let height = 600;

function nodeRadius(node: OntologyNode): number {
	if (node.kind === "entity") {
		const e = node.data as ConstellationEntity;
		const aspectCount = e.aspects?.length ?? 0;
		let attrCount = 0;
		for (const a of e.aspects ?? []) attrCount += a.attributes?.length ?? 0;
		const weight = aspectCount + attrCount * 0.5 + (e.mentions ?? 0) * 0.05;
		const scaled = Math.log2(1 + weight);
		const t = Math.min(scaled / 5.5, 1);
		return ENTITY_MIN_SIZE + t * (ENTITY_MAX_SIZE - ENTITY_MIN_SIZE);
	}
	return BASE_SIZES[node.kind];
}

function stableUnit(id: string, salt = ""): number {
	let hash = 0;
	const input = `${id}:${salt}`;
	for (let i = 0; i < input.length; i++) hash = (Math.imul(31, hash) + input.charCodeAt(i)) | 0;
	return ((hash >>> 0) % 10000) / 10000;
}

function initialPosition(node: OntologyNode): { x: number; y: number } {
	const parent = node.parentId ? nodeCache.get(node.parentId) : null;
	if (parent) {
		const angle = stableUnit(node.id, "angle") * Math.PI * 2;
		const radius =
			node.kind === "attribute" ? 95 + stableUnit(node.id, "r") * 55 : 190 + stableUnit(node.id, "r") * 120;
		return { x: parent.x + Math.cos(angle) * radius, y: parent.y + Math.sin(angle) * radius };
	}
	const angle = stableUnit(node.id, "root") * Math.PI * 2;
	const radius = 120 + stableUnit(node.id, "root-r") * 320;
	return { x: Math.cos(angle) * radius, y: Math.sin(angle) * radius };
}

function toCanvasNode(node: OntologyNode): GraphCanvasNode {
	const cached = nodeCache.get(node.id);
	const pos = cached ?? initialPosition(node);
	const size = nodeRadius(node);
	const next: GraphCanvasNode = {
		id: node.id,
		kind: node.kind,
		label: node.label,
		sublabel: node.sublabel,
		searchText: node.searchText,
		parentId: node.parentId,
		x: pos.x,
		y: pos.y,
		vx: cached?.vx ?? 0,
		vy: cached?.vy ?? 0,
		fx: cached?.fx ?? null,
		fy: cached?.fy ?? null,
		size,
		color: NODE_COLORS[node.kind],
		dimColor: NODE_COLORS_DIM[node.kind],
		shape: node.kind === "entity" ? "hex" : "circle",
		data: node.data,
	};
	nodeCache.set(node.id, next);
	return next;
}

function buildSim(nodes: OntologyNode[], edges: OntologyEdge[], forceInit = false): void {
	const visNodes = ontology.visibleNodeKinds;
	const visEdges = ontology.visibleEdgeKinds;
	const search = ontology.searchMatchIds;
	const nextNodes = nodes
		.filter((n) => visNodes.has(n.kind) && (search === null || search.has(n.id)))
		.map(toCanvasNode);
	const nodeIds = new Set(nextNodes.map((n) => n.id));
	const nextEdges: GraphCanvasEdge[] = edges
		.filter((edge) => visEdges.has(edge.kind) && nodeIds.has(edge.source) && nodeIds.has(edge.target))
		.map((edge) => ({
			...edge,
			id: `${edge.kind}:${edge.source}:${edge.target}`,
			sourceId: edge.source,
			targetId: edge.target,
			source: edge.source,
			target: edge.target,
			visualOnly: false,
		}));

	simNodes = nextNodes;
	simEdges = nextEdges;
	nodeMap = new Map(nextNodes.map((node) => [node.id, node]));
	spatial.rebuild(nextNodes);
	const charge = nextNodes.length > 500 ? -80 : nextNodes.length > 200 ? -120 : -180;
	const linkDistance = nextNodes.length > 500 ? 40 : 80;
	if (forceInit) sim.init(nextNodes, nextEdges, { chargeStrength: charge, linkDistance, preSettleTicks: 240 });
	else sim.update(nextNodes, nextEdges);
	autoFitPending = forceInit;
	requestRender();
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
	const targetDim = ontology.selected ? 1 : 0;
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
			selectedId: ontology.selected?.id ?? null,
			hoveredId: ontology.hovered?.id ?? null,
			relatedIds: ontology.relatedIds,
			dimProgress,
		},
		nodeMap,
		RENDER_COLORS,
	);
}

$effect(() => {
	const key = `${[...ontology.visibleNodeKinds].sort().join(",")}|${[...ontology.visibleEdgeKinds].sort().join(",")}|${ontology.searchEpoch}`;
	if (key !== lastFilter && ontology.graphNodes.length > 0) {
		lastFilter = key;
		buildSim(ontology.graphNodes, ontology.graphEdges);
	}
});

$effect(() => {
	void ontology.selected;
	void ontology.hovered;
	void ontology.relatedIds;
	requestRender();
});

$effect(() => {
	const id = agentId;
	loadGraph(id).then(() => {
		lastFilter = `${[...ontology.visibleNodeKinds].sort().join(",")}|${[...ontology.visibleEdgeKinds].sort().join(",")}|all`;
		nodeCache = new Map();
		buildSim(ontology.graphNodes, ontology.graphEdges, true);
	});
});

onMount(() => {
	const el = canvas;
	if (el) {
		viewport = new ViewportState(el.clientWidth / 2, el.clientHeight / 2, 0.5);
		input = new GraphInputHandler(el, viewport, spatial, {
			onNodeHover: (node) => {
				if (node) hoverNode(node.id, node.kind);
				else clearHover();
			},
			onNodeClick: (node) => {
				if (node) selectNode(node.id, node.kind);
				else clearSelection();
			},
			onNodeDragStart: () => sim.reheat(),
			onNodeDragEnd: () => sim.coolDown(),
			onRequestRender: requestRender,
		});
	}
	raf = requestAnimationFrame(loop);
	return () => {
		cancelAnimationFrame(raf);
		input?.destroy();
		sim.destroy();
	};
});
</script>

<div class="constellation-zone">
	<div class="panel-header">
		<span class="panel-title">CONSTELLATION GRAPH</span>
		{#if ontology.loading}
			<span class="panel-status">Loading...</span>
		{:else if simNodes.length > 0}
			<span class="panel-status">{simNodes.length} nodes</span>
		{/if}
	</div>

	<div class="graph-container">
		<canvas bind:this={canvas} class="graph-canvas"></canvas>

		<div class="graph-legend">
			{#each LEGEND_ITEMS as item (item.kind)}
				{#if ontology.visibleNodeKinds.has(item.kind)}
					<div class="legend-item">
						<span class="legend-dot" style="background: {NODE_COLORS[item.kind]}"></span>
						<span class="legend-label">{item.label}</span>
					</div>
				{/if}
			{/each}
		</div>
	</div>
</div>

<style>
	.constellation-zone {
		display: flex;
		flex-direction: column;
		height: 100%;
		min-height: 0;
		background: var(--sig-bg);
		border-right: 1px solid var(--sig-border);
	}

	.panel-header {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 10px 12px;
		border-bottom: 1px solid var(--sig-border);
		flex-shrink: 0;
	}

	.panel-title {
		font-family: var(--font-body);
		font-size: 9px;
		font-weight: 600;
		letter-spacing: 0.1em;
		text-transform: uppercase;
		color: var(--sig-text-bright);
	}

	.panel-status {
		font-family: var(--font-body);
		font-size: 9px;
		color: var(--sig-text-muted);
		letter-spacing: 0.05em;
	}

	.graph-container {
		position: relative;
		flex: 1;
		min-height: 0;
	}

	.graph-canvas {
		display: block;
		width: 100%;
		height: 100%;
		touch-action: none;
	}

	.graph-legend {
		position: absolute;
		top: 10px;
		left: 10px;
		display: flex;
		flex-direction: column;
		gap: 4px;
		padding: 8px 10px;
		background: rgba(6, 6, 8, 0.85);
		border: 1px solid var(--sig-border);
		border-radius: 4px;
		pointer-events: none;
	}

	.legend-item {
		display: flex;
		align-items: center;
		gap: 6px;
		padding: 0;
	}

	.legend-dot {
		width: 8px;
		height: 8px;
		border-radius: 50%;
		flex-shrink: 0;
	}

	.legend-label {
		font-family: var(--font-body);
		font-size: 9px;
		color: var(--sig-text-muted);
		text-transform: uppercase;
		letter-spacing: 0.05em;
	}
</style>

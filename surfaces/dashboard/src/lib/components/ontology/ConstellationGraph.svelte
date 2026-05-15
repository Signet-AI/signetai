<script lang="ts">
import { getConstellationOverlay } from "$lib/api";
import { onMount } from "svelte";
import { SpatialIndex } from "./canvas/hit-test";
import { GraphInputHandler } from "./canvas/input-handler";
import { isNodeVisibleAtLod, renderFrame } from "./canvas/renderer";
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
} from "./knowledge-map-data";

interface Props {
	agentId?: string;
}
const { agentId = "default" }: Props = $props();

const BASE_SIZES: Record<KnowledgeMapNodeKind, number> = {
	source: 58,
	document: 48,
	session: 46,
	aspect: 32,
	attribute: 30,
	memory: 28,
	entity: 38,
	proposal: 34,
};

const ENTITY_TYPE_COLORS: Record<string, { color: string; dim: string }> = {
	person: { color: "#eab308", dim: "rgba(234, 179, 8, 0.34)" },
	project: { color: "#06b6d4", dim: "rgba(6, 182, 212, 0.34)" },
	product: { color: "#14f1d9", dim: "rgba(20, 241, 217, 0.3)" },
	system: { color: "#a855f7", dim: "rgba(168, 85, 247, 0.32)" },
	tool: { color: "#10b981", dim: "rgba(16, 185, 129, 0.3)" },
	topic: { color: "#a78bfa", dim: "rgba(167, 139, 250, 0.32)" },
	concept: { color: "#f43f5e", dim: "rgba(244, 63, 94, 0.3)" },
	organization: { color: "#f59e0b", dim: "rgba(245, 158, 11, 0.28)" },
	org: { color: "#f59e0b", dim: "rgba(245, 158, 11, 0.28)" },
	skill: { color: "#f59e0b", dim: "rgba(245, 158, 11, 0.28)" },
	task: { color: "#64748b", dim: "rgba(100, 116, 139, 0.3)" },
};

const ENTITY_SPRITE_TYPES = new Set([
	"person",
	"project",
	"product",
	"system",
	"tool",
	"topic",
	"concept",
	"organization",
	"org",
	"skill",
	"task",
	"unknown",
]);

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

const ENTITY_TYPE_ORDER = [
	"person",
	"project",
	"system",
	"tool",
	"concept",
	"topic",
	"product",
	"org",
	"skill",
	"task",
	"extracted",
	"unknown",
];

const ENTITY_TYPE_LABELS: Record<string, string> = {
	person: "Person",
	project: "Project",
	product: "Product",
	system: "System",
	tool: "Tool",
	topic: "Topic",
	concept: "Concept",
	org: "Org",
	skill: "Skill",
	task: "Task",
	extracted: "Extracted",
	unknown: "Other",
};

const MAX_ENTITY_TYPE_LEGEND_ITEMS = 12;

const STRUCTURE_LEGEND: { kind: "aspect" | "attribute" | "memory"; label: string }[] = [
	{ kind: "aspect", label: "Aspect" },
	{ kind: "attribute", label: "Attribute" },
	{ kind: "memory", label: "Evidence" },
];
const ENTITY_FOCUS_ZOOM = 0.56;
const ASPECT_FOCUS_ZOOM = 0.72;
const ENTITY_DESELECT_ZOOM = 0.36;
const ASPECT_DESELECT_ZOOM = 0.44;

// biome-ignore lint/style/useConst: Svelte bind:this assigns to this rune.
let canvas = $state<HTMLCanvasElement | null>(null);
let simNodes = $state<GraphCanvasNode[]>([]);
const entityLegendItems = $derived(entityLegendItemsFor(simNodes));
let simEdges: GraphCanvasEdge[] = [];
let rawNodes = $state<KnowledgeMapNode[]>([]);
let rawEdges = $state<KnowledgeMapEdge[]>([]);
let selectedId = $state<string | null>(null);
let hoveredId = $state<string | null>(null);
let relatedIds = $state(new Set<string>());
let loading = $state(false);
let error = $state<string | null>(null);
// biome-ignore lint/style/useConst: Svelte $state primitive is reassigned by event handlers.
let legendOpen = $state(true);
let width = $state(800);
let height = $state(600);
let zoomDisplay = $state(50);
let viewportVersion = $state(0);
const popoverNode = $derived(focusedNode());
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
let spatialFrame = 0;

function nodeRadius(node: KnowledgeMapNode): number {
	const base = BASE_SIZES[node.kind];
	const weight = Math.max(0, Math.min(node.weight ?? 0, 1));
	if (node.kind === "entity") {
		const scale = Math.max(0, Math.min(node.counts?.scale ?? 0, 1));
		return base + Math.round(108 * scale);
	}
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
	const entityTone = node.kind === "entity" ? entityColor(node.entityType) : null;
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
		anchorDx: cached?.anchorDx,
		anchorDy: cached?.anchorDy,
		size,
		mass: node.kind === "entity" ? Math.max(0, Math.min(node.counts?.scale ?? 0, 1)) : undefined,
		color: entityTone?.color ?? KNOWLEDGE_NODE_COLORS[node.kind],
		dimColor: entityTone?.dim ?? KNOWLEDGE_NODE_COLORS_DIM[node.kind],
		sprite: node.kind === "entity" ? entitySprite(node.entityType) : undefined,
		shape: shapeFor(node.kind),
		data: node,
	};
	return next;
}

function entityColor(type: string | undefined): { color: string; dim: string } {
	return ENTITY_TYPE_COLORS[normalizeEntityType(type)] ?? { color: "#93c5fd", dim: "rgba(147, 197, 253, 0.28)" };
}

function entitySprite(type: string | undefined): string {
	const key = normalizeEntityType(type);
	return `/constellation-assets/entity-${ENTITY_SPRITE_TYPES.has(key) ? key : "unknown"}.png`;
}

function normalizeEntityType(type: string | undefined): string {
	const key = type?.trim().toLowerCase();
	if (!key) return "unknown";
	if (key === "organization") return "org";
	return key;
}

function entityLegendItemsFor(nodes: GraphCanvasNode[]): { type: string; label: string; count: number }[] {
	const counts = new Map<string, number>();
	for (const node of nodes) {
		if (node.kind !== "entity") continue;
		const type = normalizeEntityType(canvasEntityType(node));
		counts.set(type, (counts.get(type) ?? 0) + 1);
	}
	const order = new Map(ENTITY_TYPE_ORDER.map((type, index) => [type, index]));
	return [...counts.entries()]
		.sort(([a, aCount], [b, bCount]) => {
			const aOrder = order.get(a);
			const bOrder = order.get(b);
			if (aOrder !== undefined || bOrder !== undefined) return (aOrder ?? 999) - (bOrder ?? 999);
			return bCount - aCount || a.localeCompare(b);
		})
		.slice(0, MAX_ENTITY_TYPE_LEGEND_ITEMS)
		.map(([type, count]) => ({ type, label: entityTypeLabel(type), count }));
}

function canvasEntityType(node: GraphCanvasNode): string | undefined {
	const data = node.data;
	if (!data || typeof data !== "object" || !("entityType" in data)) return undefined;
	const value = data.entityType;
	return typeof value === "string" ? value : undefined;
}

function entityTypeLabel(type: string): string {
	const known = ENTITY_TYPE_LABELS[type];
	if (known) return known;
	return type
		.split(/[-_\s]+/)
		.filter(Boolean)
		.map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
		.join(" ");
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
	const activeNodes = simNodes;
	const activeEdges = simEdges;
	nodeCache = new Map(activeNodes.map((node) => [node.id, node]));
	nodeMap = new Map(activeNodes.map((node) => [node.id, node]));
	initializeAnchors(activeNodes);
	syncAnchoredNodes();
	rebuildSpatial();
	const charge = activeNodes.length > 1000 ? -650 : activeNodes.length > 400 ? -1000 : activeNodes.length > 90 ? -1500 : -2000;
	const layoutNodes = activeNodes.filter(shouldSimulateNode);
	const layoutIds = new Set(layoutNodes.map((node) => node.id));
	const layoutEdges = activeEdges.filter((edge) => layoutIds.has(edge.sourceId) && layoutIds.has(edge.targetId));
	if (forceInit)
		sim.init(layoutNodes, layoutEdges, {
			chargeStrength: charge,
			linkDistance: activeNodes.length > 1000 ? 150 : 220,
			collisionPadding: activeNodes.length > 1000 ? 10 : 18,
			preSettleTicks: activeNodes.length > 1000 ? 24 : activeNodes.length > 400 ? 45 : 140,
			maxActiveTicks: activeNodes.length > 1000 ? 18 : activeNodes.length > 400 ? 28 : 70,
			maxActiveMs: activeNodes.length > 1000 ? 280 : activeNodes.length > 400 ? 420 : 900,
		});
	else sim.update(layoutNodes, layoutEdges);
	autoFitPending = forceInit;
	requestRender();
}

function applyVisibleGraph(forceInit = false): void {
	buildSim(rawNodes, rawEdges, forceInit);
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
		const graph = buildKnowledgeMapFromConstellation(data, { focusLabel: "Signet", limit: 2000 });
		rawNodes = graph.nodes;
		rawEdges = graph.edges;
		nodeCache = new Map();
		selectedId = null;
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
	const draggingNode = input?.getDraggingNode();
	if (draggingNode) captureAnchorOffset(draggingNode);
	const anchoredChanged = syncAnchoredNodes(draggingNode);
	const spatialChanged =
		viewportMoving || simActive || dragging || anchoredChanged || renderNeeded ? rebuildSpatial(spatialFrame++ % 3 !== 0) : false;
	if ((selectedId ?? hoveredId) && (viewportMoving || simActive || spatialChanged)) viewportVersion += 1;
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
			searchMatchIds: null,
			dimProgress,
		},
		nodeMap,
		RENDER_COLORS,
	);
}

function selectGraphNode(node: GraphCanvasNode | null): void {
	if (!node || selectedId === node.id) {
		clearSelection();
		return;
	}
	selectedId = node.id;
	relatedIds = focusRelatedIds(node.id);
	if (node.kind === "entity" || node.kind === "aspect") focusNodeNeighborhood(node.id);
	requestRender();
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
	if (selectedId) {
		centerNode(selectedId);
		return;
	}
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
	relatedIds = focusRelatedIds(id);
	const node = nodeMap.get(id);
	if (node?.kind === "entity" || node?.kind === "aspect") focusNodeNeighborhood(id);
	else centerNode(id);
	requestRender();
}

function focusRelatedIds(id: string): Set<string> {
	const node = rawNodes.find((item) => item.id === id);
	if (!node) return new Set();
	const ids = new Set<string>();
	ids.add(id);
	const ancestors = ancestorNodes(node);
	const entity = node.kind === "entity" ? node : ancestors.find((item) => item.kind === "entity");
	const aspect = node.kind === "aspect" ? node : ancestors.find((item) => item.kind === "aspect");

	if (entity) {
		ids.add(entity.id);
		for (const child of directChildren(entity.id)) ids.add(child.id);
	}
	if (aspect) {
		ids.add(aspect.id);
		for (const child of directChildren(aspect.id)) ids.add(child.id);
	}
	for (const child of directChildren(id)) ids.add(child.id);
	if (node.kind === "attribute" || node.kind === "memory") {
		for (const edge of rawEdges) {
			if (edge.kind !== "supports") continue;
			if (edge.source === id) ids.add(edge.target);
			if (edge.target === id) ids.add(edge.source);
		}
	}
	return ids;
}

function ancestorNodes(node: KnowledgeMapNode): KnowledgeMapNode[] {
	const ancestors: KnowledgeMapNode[] = [];
	let current = node.parentId ? rawNodes.find((item) => item.id === node.parentId) : null;
	while (current) {
		ancestors.push(current);
		current = current.parentId ? rawNodes.find((item) => item.id === current?.parentId) : null;
	}
	return ancestors;
}

function clearSelection(): void {
	const previousId = selectedId;
	selectedId = null;
	relatedIds = new Set();
	if (previousId) zoomOutFromFocus(previousId);
	requestRender();
}

function centerNode(id: string): void {
	const node = nodeMap.get(id);
	if (!node) return;
	viewport?.centerOn(node.x, node.y, width, height);
	requestRender();
}

function focusNodeNeighborhood(id: string): void {
	const node = nodeMap.get(id);
	if (!node) return;
	const children = directCanvasChildren(id);
	arrangeOrbit(node, children);
	sim.pause();
	syncAnchoredNodes();
	rebuildSpatial();
	const maxZoom = node.kind === "entity" ? ENTITY_FOCUS_ZOOM : ASPECT_FOCUS_ZOOM;
	viewport?.fitToNodes([node, ...children], width, height, {
		maxZoom,
		padding: node.kind === "entity" ? 0.34 : 0.42,
	});
	requestRender();
}

function zoomOutFromFocus(id: string): void {
	const node = nodeMap.get(id);
	const vp = viewport;
	if (!node || !vp) return;
	if (node.kind === "aspect" && node.parentId) {
		const parent = nodeMap.get(node.parentId);
		if (parent) {
			vp.fitToNodes([parent, ...directCanvasChildren(parent.id)], width, height, {
				maxZoom: ASPECT_DESELECT_ZOOM,
				padding: 0.5,
			});
			return;
		}
	}
	if (node.kind === "entity") {
		vp.fitToNodes([node, ...directCanvasChildren(node.id)], width, height, {
			maxZoom: ENTITY_DESELECT_ZOOM,
			padding: 0.62,
		});
		return;
	}
	vp.zoomTo(Math.max(vp.zoom * 0.72, 0.38), width / 2, height / 2);
}

function directCanvasChildren(id: string): GraphCanvasNode[] {
	return directChildren(id)
		.map((child) => nodeMap.get(child.id))
		.filter((child): child is GraphCanvasNode => child !== undefined);
}

function arrangeOrbit(parent: GraphCanvasNode, children: GraphCanvasNode[]): void {
	if (children.length === 0) return;
	const radius = parent.kind === "entity" ? 210 : 132;
	const ringStep = parent.kind === "entity" ? 46 : 34;
	const startAngle = -Math.PI / 2;
	parent.vx = 0;
	parent.vy = 0;
	for (const [index, child] of children.entries()) {
		const angle = startAngle + (Math.PI * 2 * index) / children.length;
		const ring = radius + (children.length > 6 ? (index % 2) * ringStep : 0);
		child.x = parent.x + Math.cos(angle) * ring;
		child.y = parent.y + Math.sin(angle) * ring;
		child.vx = 0;
		child.vy = 0;
		child.fx = null;
		child.fy = null;
		child.anchorDx = child.x - parent.x;
		child.anchorDy = child.y - parent.y;
	}
}

function shouldSimulateNode(node: GraphCanvasNode): boolean {
	return node.kind === "entity" || node.kind === "aspect";
}

function shouldAnchorNode(node: GraphCanvasNode): boolean {
	return node.kind === "attribute" || node.kind === "memory";
}

function initializeAnchors(nodes: GraphCanvasNode[]): void {
	for (const node of nodes) {
		if (!shouldAnchorNode(node) || !node.parentId) continue;
		const parent = nodeMap.get(node.parentId);
		if (!parent) continue;
		node.anchorDx ??= node.x - parent.x;
		node.anchorDy ??= node.y - parent.y;
	}
}

function syncAnchoredNodes(except?: GraphCanvasNode | null): boolean {
	let changed = false;
	for (const node of simNodes) {
		if (!shouldAnchorNode(node) || node === except || !node.parentId) continue;
		const parent = nodeMap.get(node.parentId);
		if (!parent) continue;
		const x = parent.x + (node.anchorDx ?? 0);
		const y = parent.y + (node.anchorDy ?? 0);
		if (Math.abs(node.x - x) > 0.05 || Math.abs(node.y - y) > 0.05) {
			node.x = x;
			node.y = y;
			changed = true;
		}
	}
	return changed;
}

function captureAnchorOffset(node: GraphCanvasNode): void {
	if (!shouldAnchorNode(node) || !node.parentId) return;
	const parent = nodeMap.get(node.parentId);
	if (!parent) return;
	node.anchorDx = node.x - parent.x;
	node.anchorDy = node.y - parent.y;
}

function rebuildSpatial(skipWhenLarge = false): boolean {
	const vp = viewport;
	if (skipWhenLarge && simNodes.length > 1000) return false;
	const zoom = vp?.zoom ?? 1;
	return spatial.rebuild(simNodes.filter((node) => isNodeInteractiveAtLod(node, zoom, isNodeEmphasized(node))));
}

function isNodeEmphasized(node: GraphCanvasNode): boolean {
	return node.id === selectedId || node.id === hoveredId || relatedIds.has(node.id);
}

function isNodeInteractiveAtLod(node: GraphCanvasNode, zoom: number, emphasized = false): boolean {
	if (emphasized) return true;
	if (node.kind === "entity") return true;
	if (node.kind === "aspect") return zoom >= 0.15;
	if (node.kind === "attribute") return zoom >= 0.38;
	if (node.kind === "memory") return zoom >= 0.62;
	return isNodeVisibleAtLod(node, zoom, emphasized);
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

function parentNode(node: KnowledgeMapNode): KnowledgeMapNode | null {
	return node.parentId ? (rawNodes.find((item) => item.id === node.parentId) ?? null) : null;
}

function focusedNode(): KnowledgeMapNode | null {
	const id = selectedId ?? hoveredId;
	return id ? (rawNodes.find((node) => node.id === id) ?? null) : null;
}

function popoverStyle(node: KnowledgeMapNode): string {
	void viewportVersion;
	const canvasNode = nodeMap.get(node.id);
	const vp = viewport;
	if (!canvasNode || !vp) return "display: none";
	const screen = vp.worldToScreen(canvasNode.x, canvasNode.y);
	const gap = 20;
	const panelWidth = Math.max(260, Math.min(330, width - 32));
	const panelHeight = 250;
	const radius = (canvasNode.size * vp.zoom) / 2;
	const rightSpace = width - (screen.x + radius + gap);
	const leftSpace = screen.x - radius - gap;
	const belowSpace = height - (screen.y + radius + gap);
	const aboveSpace = screen.y - radius - gap;

	let left = screen.x + radius + gap;
	let top = screen.y - panelHeight / 2;
	if (rightSpace < panelWidth && leftSpace >= panelWidth) {
		left = screen.x - radius - gap - panelWidth;
	} else if (rightSpace < panelWidth && belowSpace >= panelHeight) {
		left = screen.x - panelWidth / 2;
		top = screen.y + radius + gap;
	} else if (rightSpace < panelWidth && aboveSpace > belowSpace) {
		left = screen.x - panelWidth / 2;
		top = screen.y - radius - gap - panelHeight;
	}

	return `left: ${clamp(left, 16, width - panelWidth - 16)}px; top: ${clamp(top, 16, height - panelHeight - 16)}px; width: ${panelWidth}px;`;
}

function shortId(id: string): string {
	return id.length > 18 ? `${id.slice(0, 10)}...${id.slice(-5)}` : id;
}

function clamp(value: number, min: number, max: number): number {
	return Math.max(min, Math.min(value, max));
}

function summaryText(): string {
	const visible = simNodes.length;
	if (loading) return "Loading knowledge map...";
	if (error) return error;
	return `${visible} ontology nodes • ${simEdges.length} relationships`;
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
			clearSelection();
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
			onNodeDragEnd: () => {
				sim.coolDown();
				requestRender();
			},
			onNodeDoubleClick: (node) => {
				if (!node) return;
				selectAndCenter(node.id);
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

	<div class="map-controls">
		<button type="button" onclick={fitGraph}><span>Fit</span><kbd>Z</kbd></button>
		<button type="button" onclick={centerGraph}><span>Center</span><kbd>C</kbd></button>
		<div class="zoom-row">
			<span>{zoomDisplay}%</span>
			<button type="button" aria-label="Zoom out" onclick={() => zoomBy(1 / 1.3)}>-</button>
			<button type="button" aria-label="Zoom in" onclick={() => zoomBy(1.3)}>+</button>
		</div>
		<div class="legend-shell">
			<button
				type="button"
				class="legend-toggle"
				class:legend-toggle-open={legendOpen}
				aria-expanded={legendOpen}
				onclick={() => (legendOpen = !legendOpen)}
			>
				<span class="legend-chevron">›</span>
				<span>Legend</span>
			</button>
			{#if legendOpen}
				<div class="legend-list">
					<div class="legend-section">
						<div class="legend-heading">Entity Type</div>
						<div class="legend-grid">
							{#each entityLegendItems as item (item.type)}
								<div class="legend-item" title={`${item.count} visible`}>
									<span class="legend-dot" style="background: {entityColor(item.type).color}"></span>
									<span>{item.label}</span>
								</div>
							{/each}
							{#if entityLegendItems.length === 0}
								<div class="legend-empty">No entities visible</div>
							{/if}
						</div>
					</div>
					<div class="legend-section legend-structure">
						<div class="legend-heading">Structure</div>
						{#each STRUCTURE_LEGEND as item (item.kind)}
							<div class="legend-item">
								<span class="legend-dot" style="background: {KNOWLEDGE_NODE_COLORS[item.kind]}"></span>
								<span>{item.label}</span>
							</div>
						{/each}
					</div>
				</div>
			{/if}
		</div>
	</div>

	{#if popoverNode}
		<div class="node-popover" class:selected={selectedId === popoverNode.id} style={popoverStyle(popoverNode)}>
			<div class="node-card-kind">
				{nodeKindLabel(popoverNode.kind)}{popoverNode.sublabel ? ` • ${popoverNode.sublabel}` : ""}
			</div>
			<div class="node-card-title">{popoverNode.label}</div>
			{#if popoverNode.preview}
				<div class="node-card-preview">{popoverNode.preview}</div>
			{/if}
			{#if popoverNode.details?.length}
				<div class="node-detail-list">
					{#each popoverNode.details.slice(0, 4) as row (`${row.label}:${row.value}`)}
						<div class="node-detail-row">
							<span>{row.label}</span>
							<strong>{row.value}</strong>
						</div>
					{/each}
				</div>
			{/if}
			<div class="popover-actions">
				{#if parentNode(popoverNode)}
					<button type="button" onclick={() => popoverNode.parentId && selectAndCenter(popoverNode.parentId)}>
						Parent
					</button>
				{/if}
				{#each directChildren(popoverNode.id).slice(0, 3) as child (child.id)}
					<button type="button" onclick={() => selectAndCenter(child.id)}>
						<span>{nodeKindLabel(child.kind)}</span>
						<strong>{child.label}</strong>
					</button>
				{/each}
			</div>
			<div class="node-card-footer">
				<span>{footerSummary(popoverNode)}</span>
				<code>{shortId(popoverNode.id)}</code>
			</div>
		</div>
	{/if}
</div>

<style>
	.knowledge-map-zone {
		position: relative;
		height: 100%;
		min-height: 0;
		overflow: hidden;
		background: #02040a;
	}

	.knowledge-map-zone::before {
		position: absolute;
		inset: 0;
		z-index: 0;
		content: "";
		background: url("/constellation-assets/background.png") center / cover no-repeat;
		opacity: 0.26;
		pointer-events: none;
	}

	.knowledge-map-zone::after {
		position: absolute;
		inset: 0;
		z-index: 0;
		content: "";
		background:
			linear-gradient(90deg, rgba(2, 6, 18, 0.72), rgba(2, 6, 18, 0.28) 24%, rgba(2, 6, 18, 0.28) 70%, rgba(2, 6, 18, 0.7)),
			linear-gradient(180deg, rgba(2, 6, 18, 0.58), rgba(2, 6, 18, 0.36) 40%, rgba(2, 6, 18, 0.72));
		pointer-events: none;
	}

	.graph-canvas {
		position: absolute;
		inset: 0;
		z-index: 1;
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
		left: 24px;
		bottom: 24px;
		z-index: 6;
		display: flex;
		flex-direction: column;
		gap: 9px;
		align-items: flex-start;
		width: 276px;
	}

	.map-controls button,
	.zoom-row,
	.legend-list {
		border: 0;
		background: url("/constellation-assets/button.png") center / 100% 100% no-repeat;
		background-color: transparent;
	}

	.map-controls button,
	.popover-actions button {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		gap: 8px;
		height: 40px;
		padding: 0 18px;
		border-radius: 0;
		font-family: var(--font-body);
		font-size: 11px;
		color: rgba(241, 245, 249, 0.92);
		cursor: pointer;
	}

	.map-controls button:hover,
	.popover-actions button:hover {
		border-color: rgba(96, 165, 250, 0.78);
		color: rgba(255, 255, 255, 0.98);
	}

	.map-controls button {
		width: 132px;
		justify-content: flex-start;
		gap: 14px;
		letter-spacing: 0.01em;
	}

	.map-controls button span {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	kbd {
		margin-left: auto;
		min-width: 24px;
		padding: 2px 6px;
		border-radius: 5px;
		border: 1px solid rgba(71, 85, 105, 0.72);
		font-family: var(--font-mono);
		font-size: 9px;
		line-height: 1.4;
		text-align: center;
		color: rgba(148, 163, 184, 0.82);
	}

	.zoom-row {
		display: flex;
		align-items: center;
		gap: 7px;
		width: 158px;
		height: 42px;
		padding: 0 10px 0 18px;
		font-family: var(--font-body);
		font-size: 11px;
		color: rgba(241, 245, 249, 0.9);
	}

	.zoom-row > span {
		width: 48px;
		text-align: left;
	}

	.zoom-row button {
		min-width: 30px;
		width: 30px;
		height: 30px;
		justify-content: center;
		padding: 0;
		font-size: 12px;
	}

	.legend-shell {
		display: flex;
		flex-direction: column;
		gap: 8px;
		width: 100%;
	}

	.legend-toggle {
		width: 250px !important;
		justify-content: flex-start;
	}

	.legend-chevron {
		display: inline-flex;
		width: 10px;
		transition: transform 120ms ease;
	}

	.legend-toggle-open .legend-chevron {
		transform: rotate(90deg);
	}

	.legend-list {
		display: flex;
		flex-direction: column;
		gap: 12px;
		width: 250px;
		min-height: 248px;
		padding: 26px 30px 24px 34px;
		box-sizing: border-box;
		border: 0;
		background: url("/constellation-assets/large-card.png") center / 100% 100% no-repeat;
		background-color: transparent;
	}

	.legend-section {
		display: flex;
		flex-direction: column;
		gap: 6px;
		min-width: 0;
	}

	.legend-heading {
		font-family: var(--font-mono);
		font-size: 7px;
		letter-spacing: 0.18em;
		line-height: 1.4;
		color: rgba(125, 211, 252, 0.82);
		text-transform: uppercase;
	}

	.legend-grid {
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		column-gap: 12px;
		row-gap: 2px;
	}

	.legend-item {
		display: grid;
		grid-template-columns: 14px minmax(0, 1fr);
		align-items: center;
		gap: 8px;
		min-height: 20px;
		padding: 0 4px;
		font-family: var(--font-body);
		font-size: 7px;
		letter-spacing: 0.14em;
		color: rgba(203, 213, 225, 0.82);
		text-transform: uppercase;
	}

	.legend-item span:last-child {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.legend-empty {
		grid-column: 1 / -1;
		min-height: 20px;
		padding: 0 4px;
		font-family: var(--font-body);
		font-size: 7px;
		letter-spacing: 0.14em;
		color: rgba(148, 163, 184, 0.62);
		text-transform: uppercase;
	}

	.legend-structure .legend-item + .legend-item {
		border-top: 1px solid rgba(96, 165, 250, 0.1);
	}

	.legend-dot {
		flex: 0 0 auto;
		justify-self: center;
		width: 7px;
		height: 7px;
		border-radius: 2px;
		transform: rotate(45deg);
		border: 1px solid rgba(226, 232, 240, 0.46);
	}

	.node-popover {
		position: absolute;
		z-index: 8;
		display: flex;
		flex-direction: column;
		max-height: min(350px, calc(100% - 32px));
		padding: 28px 38px 26px;
		border: 0;
		background: url("/constellation-assets/large-card.png") center / 100% 100% no-repeat;
		background-color: transparent;
		overflow: auto;
		color: rgba(241, 245, 249, 0.94);
		pointer-events: auto;
	}

	.node-popover.selected {
		background: url("/constellation-assets/large-card.png") center / 100% 100% no-repeat;
	}

	.node-card-kind {
		font-family: var(--font-mono);
		font-size: 9px;
		letter-spacing: 0.16em;
		text-transform: uppercase;
		color: rgba(96, 165, 250, 0.96);
	}

	.node-card-title {
		margin-top: 10px;
		font-family: var(--font-heading);
		font-size: 22px;
		line-height: 1.05;
		letter-spacing: 0.02em;
		color: rgba(241, 245, 249, 0.94);
	}

	.node-card-preview {
		margin-top: 8px;
		max-height: 54px;
		overflow: auto;
		font-family: var(--font-body);
		font-size: 11px;
		line-height: 1.45;
		color: rgba(203, 213, 225, 0.82);
	}

	.node-detail-list {
		display: grid;
		gap: 8px;
		margin-top: 12px;
		padding-top: 10px;
		overflow: auto;
	}

	.node-detail-row {
		display: grid;
		grid-template-columns: 92px minmax(0, 1fr);
		gap: 10px;
		align-items: baseline;
		font-family: var(--font-body);
		font-size: 10px;
		line-height: 1.35;
	}

	.node-detail-row span,
	.popover-actions button span {
		font-family: var(--font-mono);
		font-size: 8px;
		letter-spacing: 0.08em;
		text-transform: uppercase;
		color: rgba(125, 211, 252, 0.78);
	}

	.node-detail-row strong {
		min-width: 0;
		max-height: 48px;
		overflow: hidden;
		font-weight: 500;
		color: rgba(226, 232, 240, 0.9);
	}

	.popover-actions {
		display: flex;
		flex-wrap: wrap;
		gap: 8px;
		margin-top: 12px;
	}

	.popover-actions button {
		min-width: 0;
		height: 34px;
		max-width: 100%;
		border: 0;
		background: url("/constellation-assets/button.png") center / 100% 100% no-repeat;
		background-color: transparent;
	}

	.popover-actions button strong {
		min-width: 0;
		overflow: hidden;
		font-size: 10px;
		font-weight: 500;
		text-overflow: ellipsis;
		white-space: nowrap;
		color: rgba(226, 232, 240, 0.9);
	}

	.node-card-footer {
		display: flex;
		justify-content: space-between;
		gap: 14px;
		margin-top: auto;
		padding-top: 10px;
		font-family: var(--font-mono);
		font-size: 9px;
		color: rgba(148, 163, 184, 0.78);
	}

	.node-card-footer code {
		font-family: var(--font-mono);
		color: rgba(148, 163, 184, 0.86);
	}

	@media (max-width: 700px) {
		.map-controls {
			left: 14px;
			bottom: 14px;
		}
	}
</style>

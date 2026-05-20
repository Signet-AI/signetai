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

type FocusLevel = "overview" | "entity" | "aspect" | "attribute";

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
	source: { color: "#38bdf8", dim: "rgba(56, 189, 248, 0.3)" },
	artifact: { color: "#f97316", dim: "rgba(249, 115, 22, 0.28)" },
	agent: { color: "#22c55e", dim: "rgba(34, 197, 94, 0.3)" },
	policy: { color: "#fb7185", dim: "rgba(251, 113, 133, 0.3)" },
	action: { color: "#84cc16", dim: "rgba(132, 204, 22, 0.28)" },
	workflow: { color: "#c084fc", dim: "rgba(192, 132, 252, 0.3)" },
	event: { color: "#facc15", dim: "rgba(250, 204, 21, 0.28)" },
	object_type: { color: "#2dd4bf", dim: "rgba(45, 212, 191, 0.3)" },
	interface: { color: "#60a5fa", dim: "rgba(96, 165, 250, 0.3)" },
	observation: { color: "#e879f9", dim: "rgba(232, 121, 249, 0.3)" },
	claim_slot: { color: "#a3e635", dim: "rgba(163, 230, 53, 0.28)" },
	claim_value: { color: "#f472b6", dim: "rgba(244, 114, 182, 0.3)" },
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

const EDGE_COLORS_DARK: GraphRenderColors["edges"] = {
	contains: { color: "rgb(96, 165, 250)", alpha: 0.14, width: 1.0 },
	has_aspect: { color: "rgb(96, 165, 250)", alpha: 0.38, width: 1.25 },
	has_attribute: { color: "rgb(167, 139, 250)", alpha: 0.34, width: 1.1 },
	supports: { color: "rgb(34, 211, 238)", alpha: 0.34, width: 1.15 },
	updates: { color: "rgb(34, 211, 238)", alpha: 0.48, width: 1.6 },
	extends: { color: "rgb(14, 165, 233)", alpha: 0.3, width: 1.1 },
	mentions: { color: "rgb(59, 130, 246)", alpha: 0.1, width: 0.85 },
	about: { color: "rgb(59, 130, 246)", alpha: 0.2, width: 1.1 },
};

const EDGE_COLORS_LIGHT: GraphRenderColors["edges"] = {
	contains: { color: "rgb(10, 57, 255)", alpha: 0.18, width: 1.0 },
	has_aspect: { color: "rgb(10, 57, 255)", alpha: 0.42, width: 1.25 },
	has_attribute: { color: "rgb(124, 58, 237)", alpha: 0.38, width: 1.1 },
	supports: { color: "rgb(6, 182, 212)", alpha: 0.38, width: 1.15 },
	updates: { color: "rgb(6, 182, 212)", alpha: 0.52, width: 1.6 },
	extends: { color: "rgb(2, 132, 199)", alpha: 0.34, width: 1.1 },
	mentions: { color: "rgb(37, 99, 235)", alpha: 0.14, width: 0.85 },
	about: { color: "rgb(37, 99, 235)", alpha: 0.26, width: 1.1 },
};

const RENDER_COLORS_DARK: GraphRenderColors = {
	selection: "#7cc7ff",
	selectionGlow: "rgba(59, 130, 246, 0.24)",
	text: "rgba(226, 232, 240, 0.74)",
	textMuted: "rgba(148, 163, 184, 0.66)",
	textDim: "rgba(148, 163, 184, 0.14)",
	labelShadow: "rgba(0, 0, 0, 0.82)",
	edges: EDGE_COLORS_DARK,
	relatedGlow: KNOWLEDGE_RELATED_GLOW,
};

const RENDER_COLORS_LIGHT: GraphRenderColors = {
	selection: "#0a39ff",
	selectionGlow: "rgba(10, 57, 255, 0.18)",
	text: "rgba(36, 41, 54, 0.78)",
	textMuted: "rgba(94, 102, 117, 0.72)",
	textDim: "rgba(94, 102, 117, 0.18)",
	labelShadow: "rgba(255, 255, 255, 0.7)",
	edges: EDGE_COLORS_LIGHT,
	relatedGlow: {
		source: "rgba(10, 57, 255, 0.18)",
		document: "rgba(10, 57, 255, 0.18)",
		session: "rgba(10, 57, 255, 0.18)",
		aspect: "rgba(10, 57, 255, 0.14)",
		attribute: "rgba(124, 58, 237, 0.14)",
		memory: "rgba(10, 57, 255, 0.12)",
		entity: "rgba(10, 57, 255, 0.18)",
		proposal: "rgba(10, 57, 255, 0.14)",
	},
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
	"source",
	"artifact",
	"agent",
	"policy",
	"action",
	"workflow",
	"event",
	"object_type",
	"interface",
	"observation",
	"claim_slot",
	"claim_value",
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
	source: "Source",
	artifact: "Artifact",
	agent: "Agent",
	policy: "Policy",
	action: "Action",
	workflow: "Workflow",
	event: "Event",
	object_type: "Object Type",
	interface: "Interface",
	observation: "Observation",
	claim_slot: "Claim Slot",
	claim_value: "Claim Value",
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
const ATTRIBUTE_FOCUS_ZOOM = 0.92;
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
let entitySearch = $state("");
let lightTheme = $state(false);
const popoverNode = $derived(focusedNode());
const visibleSummary = $derived(summaryText());
const entitySearchResults = $derived(entitySearchResultsFor(rawNodes, entitySearch));
const renderColors = $derived(lightTheme ? RENDER_COLORS_LIGHT : RENDER_COLORS_DARK);
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
		systemRadius: systemRadiusForNode(node, size),
		iconScale: iconScaleForKind(node.kind),
		counts: node.counts,
		color: entityTone?.color ?? KNOWLEDGE_NODE_COLORS[node.kind],
		dimColor: entityTone?.dim ?? KNOWLEDGE_NODE_COLORS_DIM[node.kind],
		sprite: node.kind === "entity" ? entitySprite(node.entityType) : undefined,
		shape: shapeFor(node.kind),
		data: node,
	};
	return next;
}

function iconScaleForKind(kind: KnowledgeMapNodeKind): number {
	if (kind === "aspect") return 1.35;
	if (kind === "attribute") return 1.45;
	return 1;
}

function systemRadiusForNode(node: KnowledgeMapNode, size: number): number | undefined {
	if (node.kind === "entity") {
		const aspects = node.counts?.aspects ?? 0;
		const attributes = node.counts?.attributes ?? 0;
		const scale = Math.max(0, Math.min(node.counts?.scale ?? 0, 1));
		return clamp(370 + scale * 230 + Math.sqrt(aspects) * 36 + Math.sqrt(attributes) * 9, 440, 860);
	}
	if (node.kind === "aspect") {
		const attributes = node.counts?.attributes ?? 0;
		return clamp(150 + Math.sqrt(attributes) * 17, size + 96, 360);
	}
	return undefined;
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

function entitySearchResultsFor(nodes: KnowledgeMapNode[], query: string): KnowledgeMapNode[] {
	const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
	if (terms.length === 0) return [];
	return nodes
		.filter((node) => node.kind === "entity")
		.map((node) => ({ node, score: entitySearchScore(node, terms) }))
		.filter((result) => result.score > 0)
		.sort(
			(a, b) =>
				b.score - a.score || entityRank(b.node) - entityRank(a.node) || a.node.label.localeCompare(b.node.label),
		)
		.slice(0, 10)
		.map((result) => result.node);
}

function entitySearchScore(node: KnowledgeMapNode, terms: string[]): number {
	const text = entitySearchText(node);
	let score = 0;
	for (const term of terms) {
		if (node.label.toLowerCase() === term) score += 80;
		else if (node.label.toLowerCase().startsWith(term)) score += 45;
		else if (node.label.toLowerCase().includes(term)) score += 25;
		else if (text.includes(term)) score += 8;
		else return 0;
	}
	return score + Math.min(entityRank(node) / 70, 25);
}

function entitySearchText(node: KnowledgeMapNode): string {
	return [node.label, node.entityType, node.sublabel, node.preview, node.searchText]
		.filter((value): value is string => typeof value === "string")
		.join(" ")
		.toLowerCase();
}

function entityRank(node: KnowledgeMapNode): number {
	const mentions = Math.max(0, node.counts?.mentions ?? 0);
	const scale = Math.max(0, Math.min(node.counts?.scale ?? 0, 1));
	const aspects = Math.max(0, node.counts?.aspects ?? 0);
	const attributes = Math.max(0, node.counts?.attributes ?? 0);
	return mentions * 8 + scale * 1000 + aspects * 10 + attributes;
}

function applyEntityTypeZones(nodes: GraphCanvasNode[], resetPositions: boolean): void {
	const entities = nodes.filter((node) => node.kind === "entity");
	if (entities.length === 0) return;
	const groups = new Map<string, GraphCanvasNode[]>();
	for (const node of entities) {
		const type = normalizeEntityType(canvasEntityType(node));
		const group = groups.get(type) ?? [];
		group.push(node);
		groups.set(type, group);
	}
	const order = new Map(ENTITY_TYPE_ORDER.map((type, index) => [type, index]));
	const sortedGroups = [...groups.entries()].sort(([a, aNodes], [b, bNodes]) => {
		const aOrder = order.get(a);
		const bOrder = order.get(b);
		if (aOrder !== undefined || bOrder !== undefined) return (aOrder ?? 999) - (bOrder ?? 999);
		return bNodes.length - aNodes.length || a.localeCompare(b);
	});
	const columns = Math.max(2, Math.ceil(Math.sqrt(sortedGroups.length * 1.45)));
	const rows = Math.max(1, Math.ceil(sortedGroups.length / columns));
	for (const [zoneIndex, [, group]] of sortedGroups.entries()) {
		const centerX = ((zoneIndex % columns) - (columns - 1) / 2) * 1320;
		const centerY = (Math.floor(zoneIndex / columns) - (rows - 1) / 2) * 1060;
		group.sort((a, b) => b.size - a.size || a.label.localeCompare(b.label));
		for (const [index, node] of group.entries()) {
			const target = zonePoint(index, group.length, centerX, centerY, node.systemRadius ?? node.size * 3);
			node.zoneX = target.x;
			node.zoneY = target.y;
			if (resetPositions) {
				node.x = target.x;
				node.y = target.y;
				node.vx = 0;
				node.vy = 0;
			}
		}
	}
}

function zonePoint(
	index: number,
	total: number,
	centerX: number,
	centerY: number,
	systemRadius: number,
): { x: number; y: number } {
	if (index === 0) return { x: centerX, y: centerY };
	const ring = Math.floor(Math.sqrt(index));
	const firstInRing = ring * ring;
	const ringCount = Math.max(1, Math.min(total - firstInRing, (ring + 1) * (ring + 1) - firstInRing));
	const position = index - firstInRing;
	const angle = -Math.PI / 2 + (position / ringCount) * Math.PI * 2 + ring * 0.38;
	const radius = Math.max(420, systemRadius * 0.42) + ring * 420;
	return {
		x: centerX + Math.cos(angle) * radius,
		y: centerY + Math.sin(angle) * radius,
	};
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
	applyEntityTypeZones(nextNodes, forceInit && selectedId === null);
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
	const layoutNodes = activeNodes.filter(shouldSimulateNode);
	const charge =
		layoutNodes.length > 600 ? -900 : layoutNodes.length > 250 ? -1500 : layoutNodes.length > 90 ? -2200 : -2800;
	const layoutIds = new Set(layoutNodes.map((node) => node.id));
	const layoutEdges = activeEdges.filter((edge) => layoutIds.has(edge.sourceId) && layoutIds.has(edge.targetId));
	if (forceInit)
		sim.init(layoutNodes, layoutEdges, {
			chargeStrength: charge,
			linkDistance: activeNodes.length > 1000 ? 210 : 280,
			collisionPadding: activeNodes.length > 1000 ? 20 : 34,
			solarPadding: activeNodes.length > 1000 ? 170 : 240,
			solarStrength: activeNodes.length > 1000 ? 0.42 : 0.5,
			preSettleTicks: activeNodes.length > 1000 ? 48 : activeNodes.length > 400 ? 90 : 180,
			maxActiveTicks: activeNodes.length > 1000 ? 28 : activeNodes.length > 400 ? 48 : 90,
			maxActiveMs: activeNodes.length > 1000 ? 420 : activeNodes.length > 400 ? 680 : 1100,
		});
	else sim.update(layoutNodes, layoutEdges);
	autoFitPending = forceInit;
	requestRender();
}

function applyVisibleGraph(forceInit = false): void {
	const graph = visibleGraphForFocus();
	buildSim(graph.nodes, graph.edges, forceInit);
}

function directChildren(id: string): KnowledgeMapNode[] {
	return rawNodes.filter((node) => node.parentId === id);
}

function visibleGraphForFocus(): { nodes: KnowledgeMapNode[]; edges: KnowledgeMapEdge[] } {
	const selected = selectedNode();
	const ids = selected ? focusedVisibleIds(selected) : overviewVisibleIds();
	const nodes = rawNodes.filter((node) => ids.has(node.id));
	return {
		nodes,
		edges: rawEdges.filter(
			(edge) => ids.has(edge.source) && ids.has(edge.target) && includeEdgeForFocus(edge, selected),
		),
	};
}

function overviewVisibleIds(): Set<string> {
	const ids = new Set<string>();
	for (const node of rawNodes) {
		if (node.kind === "entity" || node.kind === "session") ids.add(node.id);
	}
	return ids;
}

function focusedVisibleIds(node: KnowledgeMapNode): Set<string> {
	const ids = new Set<string>();
	const ancestors = ancestorNodes(node);
	const entity = node.kind === "entity" ? node : ancestors.find((item) => item.kind === "entity");
	const aspect = node.kind === "aspect" ? node : ancestors.find((item) => item.kind === "aspect");

	if (node.kind === "entity" && entity) {
		ids.add(entity.id);
		for (const child of directChildren(entity.id)) ids.add(child.id);
		for (const edge of rawEdges) {
			if (edge.kind !== "about") continue;
			if (edge.source === node.id) ids.add(edge.target);
			if (edge.target === node.id) ids.add(edge.source);
		}
		return ids;
	}

	if (node.kind === "aspect" && aspect) {
		if (entity) ids.add(entity.id);
		ids.add(aspect.id);
		for (const child of directChildren(aspect.id)) ids.add(child.id);
		return ids;
	}

	if (node.kind === "attribute") {
		if (entity) ids.add(entity.id);
		if (aspect) ids.add(aspect.id);
		ids.add(node.id);
		if (aspect) {
			for (const child of directChildren(aspect.id)) ids.add(child.id);
		}
		for (const child of directChildren(node.id)) ids.add(child.id);
		return ids;
	}

	if (node.kind === "memory") {
		for (const ancestor of ancestors) ids.add(ancestor.id);
		ids.add(node.id);
		return ids;
	}

	ids.add(node.id);
	return ids;
}

function includeEdgeForFocus(edge: KnowledgeMapEdge, selected: KnowledgeMapNode | null): boolean {
	if (!selected) return edge.kind === "about" || edge.kind === "updates";
	if (selected.kind === "entity") return edge.kind === "has_aspect" || edge.kind === "about" || edge.kind === "updates";
	if (selected.kind === "aspect")
		return edge.kind === "has_aspect" || edge.kind === "has_attribute" || edge.kind === "updates";
	if (selected.kind === "attribute" || selected.kind === "memory")
		return (
			edge.kind === "has_aspect" || edge.kind === "has_attribute" || edge.kind === "supports" || edge.kind === "updates"
		);
	return true;
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
		const graph = buildKnowledgeMapFromConstellation(data, { focusLabel: "Signet", limit: 5000 });
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
		viewportMoving || simActive || dragging || anchoredChanged || renderNeeded
			? rebuildSpatial(spatialFrame++ % 3 !== 0)
			: false;
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
		renderColors,
	);
}

function selectGraphNode(node: GraphCanvasNode | null): void {
	if (!node || selectedId === node.id) {
		clearSelection();
		return;
	}
	enterFocus(node.id);
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
	enterFocus(id);
}

function enterFocus(id: string): void {
	selectedId = id;
	relatedIds = focusRelatedIds(id);
	applyVisibleGraph();
	const node = nodeMap.get(id);
	if (node?.kind === "entity" || node?.kind === "aspect" || node?.kind === "attribute") focusNodeNeighborhood(id);
	else centerNode(id);
	requestRender();
}

function focusRelatedIds(id: string): Set<string> {
	const node = rawNodes.find((item) => item.id === id);
	if (!node) return new Set();
	const ids = new Set<string>([id]);
	const ancestors = ancestorNodes(node);
	for (const ancestor of ancestors) ids.add(ancestor.id);
	for (const child of directChildren(id)) ids.add(child.id);
	if (node.kind === "entity" || node.kind === "aspect") {
		for (const visibleId of focusedVisibleIds(node)) ids.add(visibleId);
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
	selectedId = null;
	relatedIds = new Set();
	applyVisibleGraph(true);
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
	arrangeFocusLayout(node, children);
	sim.pause();
	syncAnchoredNodes();
	rebuildSpatial();
	if (node.kind === "attribute") {
		requestRender();
		return;
	}
	const maxZoom =
		node.kind === "entity" ? ENTITY_FOCUS_ZOOM : node.kind === "aspect" ? ASPECT_FOCUS_ZOOM : ATTRIBUTE_FOCUS_ZOOM;
	viewport?.fitToNodes(focusViewportNodes(node), width, height, {
		maxZoom,
		padding: node.kind === "entity" ? 0.34 : node.kind === "aspect" ? 0.42 : 0.58,
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

function focusViewportNodes(node: GraphCanvasNode): GraphCanvasNode[] {
	const ids = new Set<string>([node.id]);
	for (const child of directCanvasChildren(node.id)) ids.add(child.id);
	let current = node.parentId ? nodeMap.get(node.parentId) : null;
	while (current) {
		ids.add(current.id);
		if (node.kind === "attribute" && current.kind === "aspect") {
			for (const sibling of directCanvasChildren(current.id)) ids.add(sibling.id);
		}
		current = current.parentId ? nodeMap.get(current.parentId) : null;
	}
	return [...ids].map((id) => nodeMap.get(id)).filter((item): item is GraphCanvasNode => item !== undefined);
}

function arrangeFocusLayout(parent: GraphCanvasNode, children: GraphCanvasNode[]): void {
	if (parent.kind === "aspect") {
		if (children.length === 0) return;
		arrangeAttributeLane(parent, children);
		return;
	}
	if (parent.kind === "attribute") {
		arrangeEvidenceTerminals(parent, children);
		return;
	}
	if (children.length === 0) return;
	arrangeAspectRing(parent, children);
}

function arrangeAspectRing(parent: GraphCanvasNode, children: GraphCanvasNode[]): void {
	const baseRadius =
		parent.kind === "entity" ? Math.max(290, parent.size * 0.8 + 190) : Math.max(188, parent.size * 1.15 + 118);
	const ringStep = parent.kind === "entity" ? 122 : 96;
	const minArc = parent.kind === "entity" ? 190 : 188;
	const startAngle = -Math.PI / 2 + stableOrbitOffset(parent.id) * 0.4;
	parent.vx = 0;
	parent.vy = 0;
	for (const [index, child] of children.entries()) {
		const point = orbitPoint(index, children.length, baseRadius, ringStep, minArc, startAngle);
		const angle = point.angle;
		const ring = point.radius;
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

function arrangeAttributeLane(parent: GraphCanvasNode, children: GraphCanvasNode[]): void {
	const parentEntity = parent.parentId ? nodeMap.get(parent.parentId) : null;
	const angle = parentEntity
		? Math.atan2(parent.y - parentEntity.y, parent.x - parentEntity.x)
		: stableOrbitOffset(parent.id);
	const tangent = angle + Math.PI / 2;
	const columns = children.length > 42 ? 7 : children.length > 24 ? 6 : children.length > 12 ? 5 : 4;
	parent.vx = 0;
	parent.vy = 0;
	for (const [index, child] of children.entries()) {
		const row = Math.floor(index / columns);
		const column = index % columns;
		const finalColumns = Math.min(columns, children.length - row * columns);
		const center = (finalColumns - 1) / 2;
		const radial = 178 + row * 124;
		const tangentOffset = (column - center) * 118;
		child.x = parent.x + Math.cos(angle) * radial + Math.cos(tangent) * tangentOffset;
		child.y = parent.y + Math.sin(angle) * radial + Math.sin(tangent) * tangentOffset;
		child.vx = 0;
		child.vy = 0;
		child.fx = null;
		child.fy = null;
		child.anchorDx = child.x - parent.x;
		child.anchorDy = child.y - parent.y;
	}
}

function arrangeEvidenceTerminals(parent: GraphCanvasNode, children: GraphCanvasNode[]): void {
	const aspect = parent.parentId ? nodeMap.get(parent.parentId) : null;
	const entity = aspect?.parentId ? nodeMap.get(aspect.parentId) : null;
	const angle = aspect && entity ? Math.atan2(aspect.y - entity.y, aspect.x - entity.x) : stableOrbitOffset(parent.id);
	const tangent = angle + Math.PI / 2;
	parent.vx = 0;
	parent.vy = 0;
	for (const [index, child] of children.entries()) {
		const side = index % 2 === 0 ? 1 : -1;
		const radial = 86 + Math.floor(index / 2) * 48;
		const tangentOffset = side * (34 + Math.floor(index / 2) * 16);
		child.x = parent.x + Math.cos(angle) * radial + Math.cos(tangent) * tangentOffset;
		child.y = parent.y + Math.sin(angle) * radial + Math.sin(tangent) * tangentOffset;
		child.vx = 0;
		child.vy = 0;
		child.fx = null;
		child.fy = null;
		child.anchorDx = child.x - parent.x;
		child.anchorDy = child.y - parent.y;
	}
}

function orbitPoint(
	index: number,
	total: number,
	baseRadius: number,
	ringStep: number,
	minArc: number,
	startAngle: number,
): { radius: number; angle: number } {
	let consumed = 0;
	let ring = 0;
	while (true) {
		const radius = baseRadius + ring * ringStep;
		const capacity = Math.max(5, Math.floor((Math.PI * 2 * radius) / minArc));
		const ringIndex = index - consumed;
		if (ringIndex < capacity) {
			const count = Math.min(capacity, total - consumed);
			const angle = startAngle + (Math.PI * 2 * ringIndex) / Math.max(count, 1);
			return { radius, angle };
		}
		consumed += capacity;
		ring += 1;
	}
}

function stableOrbitOffset(id: string): number {
	let hash = 0;
	for (let i = 0; i < id.length; i++) hash = (Math.imul(31, hash) + id.charCodeAt(i)) | 0;
	return (((hash >>> 0) % 10000) / 10000 - 0.5) * 0.6;
}

function shouldSimulateNode(node: GraphCanvasNode): boolean {
	return node.kind === "entity" || node.kind === "aspect";
}

function shouldAnchorNode(node: GraphCanvasNode): boolean {
	return node.kind === "attribute" || node.kind === "memory" || node.kind === "proposal";
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

function cardTitle(node: KnowledgeMapNode): string {
	if (node.kind === "attribute" && node.preview) return node.preview;
	return node.label;
}

function shouldShowCardPreview(node: KnowledgeMapNode): boolean {
	return node.kind !== "attribute" && Boolean(node.preview);
}

function footerSummary(node: KnowledgeMapNode): string {
	if (node.counts?.mentions) return `${node.counts.mentions} mentions`;
	if (node.counts?.importance) return `${node.counts.importance}% importance`;
	if (node.counts?.confidence) return `${node.counts.confidence}% confidence`;
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
	const panelWidth = Math.max(260, Math.min(330, width - 32));
	const panelHeight = popoverPanelHeight(node);
	const inset = width < 700 ? 14 : 24;
	return `right: ${inset}px; bottom: ${inset}px; width: ${panelWidth}px; height: ${panelHeight}px;`;
}

function entityNavigatorStyle(): string {
	const panelWidth = Math.max(300, Math.min(360, width - 32));
	const inset = width < 700 ? 14 : 24;
	return `right: ${inset}px; bottom: ${inset}px; width: ${panelWidth}px; height: auto; max-height: ${Math.min(420, height - 80)}px;`;
}

function popoverPanelHeight(node: KnowledgeMapNode): number {
	const actions = Math.min(directChildren(node.id).length, popoverChildLimit(node));
	return clamp(236 + Math.ceil(actions / 2) * 32, 270, Math.min(430, height - 32));
}

function popoverChildLimit(node: KnowledgeMapNode): number {
	if (node.kind === "aspect") return 8;
	if (node.kind === "entity") return 6;
	if (node.kind === "attribute") return 6;
	return 4;
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
	const focus = selectedNode();
	const proposals = simNodes.filter((node) => node.kind === "proposal").length;
	const dreams = simNodes.filter((node) => node.kind === "session").length;
	const overlays = [
		focus ? `${focusLevelForNode(focus)} focus` : "overview",
		proposals > 0 ? `${proposals} proposals` : "",
		dreams > 0 ? `${dreams} dreaming signals` : "",
	].filter(Boolean);
	return `${visible} ontology nodes • ${simEdges.length} relationships${overlays.length > 0 ? ` • ${overlays.join(" • ")}` : ""}`;
}

function focusLevelForNode(node: KnowledgeMapNode): FocusLevel {
	if (node.kind === "entity") return "entity";
	if (node.kind === "aspect") return "aspect";
	if (node.kind === "attribute" || node.kind === "memory") return "attribute";
	return "overview";
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

function handleEntitySearchKeydown(e: KeyboardEvent): void {
	if (e.key === "Enter") {
		e.preventDefault();
		const first = entitySearchResults[0];
		if (first) selectAndCenter(first.id);
	}
	if (e.key === "Escape") {
		e.stopPropagation();
		entitySearch = "";
	}
}

function readLightTheme(): boolean {
	return typeof document !== "undefined" && document.documentElement.dataset.theme === "light";
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
	lightTheme = readLightTheme();
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

	const themeObserver = new MutationObserver((mutations) => {
		for (const mutation of mutations) {
			if (mutation.attributeName === "data-theme") {
				lightTheme = readLightTheme();
				renderNeeded = true;
				break;
			}
		}
	});
	themeObserver.observe(document.documentElement, { attributes: true });

	return () => {
		window.removeEventListener("keydown", keyboard);
		cancelAnimationFrame(raf);
		input?.destroy();
		sim.destroy();
		themeObserver.disconnect();
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

	<div
		class="node-popover"
		class:selected={popoverNode ? selectedId === popoverNode.id : false}
		class:attribute-popover={popoverNode?.kind === "attribute"}
		class:entity-navigator-popover={!popoverNode}
		style={popoverNode ? popoverStyle(popoverNode) : entityNavigatorStyle()}
	>
		<div class="node-popover-content">
			{#if popoverNode}
				<div class="node-card-kind">
					{nodeKindLabel(popoverNode.kind)}{popoverNode.sublabel ? ` • ${popoverNode.sublabel}` : ""}
				</div>
				<div class="node-card-title">{cardTitle(popoverNode)}</div>
				{#if shouldShowCardPreview(popoverNode)}
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
					{#each directChildren(popoverNode.id).slice(0, popoverChildLimit(popoverNode)) as child (child.id)}
						<button type="button" onclick={() => selectAndCenter(child.id)}>
							<span>{nodeKindLabel(child.kind)}</span>
							<strong>{child.label}</strong>
						</button>
					{/each}
					{#if directChildren(popoverNode.id).length > popoverChildLimit(popoverNode)}
						<div class="popover-more">
							+{directChildren(popoverNode.id).length - popoverChildLimit(popoverNode)} more
						</div>
					{/if}
				</div>
			{:else}
				<div class="node-card-kind">Navigator</div>
				<div class="node-card-title entity-navigator-title">Entities</div>
				<div class="entity-navigator-subtitle">
					{rawNodes.filter((node) => node.kind === "entity").length} selectable entities
				</div>
				<label class="entity-search-label" for="constellation-entity-search">Search entity</label>
				<input
					id="constellation-entity-search"
					class="entity-search-input"
					type="search"
					bind:value={entitySearch}
					placeholder="Name, type, or memory path"
					autocomplete="off"
					onkeydown={handleEntitySearchKeydown}
				/>
				<div class="entity-navigator-results" aria-label="Entity search results">
					{#if entitySearch.trim().length === 0}
						<div class="entity-navigator-empty">Type to locate an entity</div>
					{:else if entitySearchResults.length === 0}
						<div class="entity-navigator-empty">No matching entities</div>
					{:else}
						{#each entitySearchResults as node (node.id)}
							<button type="button" onclick={() => selectAndCenter(node.id)} title={node.label}>
								<span>{node.label}</span>
								<small>
									{entityTypeLabel(normalizeEntityType(node.entityType))} • {node.counts?.aspects ?? 0} aspects • {node
										.counts?.attributes ?? 0} attributes
								</small>
							</button>
						{/each}
					{/if}
				</div>
			{/if}
		</div>
		<div class="node-card-footer">
			{#if popoverNode}
				<span>{footerSummary(popoverNode)}</span>
				<code>{shortId(popoverNode.id)}</code>
			{:else}
				<span>overview</span>
				<code>{entitySearchResults.length} results</code>
			{/if}
		</div>
	</div>
</div>

<style>
	.knowledge-map-zone {
		-webkit-app-region: no-drag;
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
		opacity: 0.35;
		pointer-events: none;
	}

	.knowledge-map-zone::after {
		position: absolute;
		inset: 0;
		z-index: 0;
		content: "";
		background:
			linear-gradient(90deg, rgba(2, 6, 18, 0.78), rgba(2, 6, 18, 0.22) 28%, rgba(2, 6, 18, 0.22) 68%, rgba(2, 6, 18, 0.76)),
			linear-gradient(180deg, rgba(2, 6, 18, 0.62), rgba(2, 6, 18, 0.32) 40%, rgba(2, 6, 18, 0.76)),
			radial-gradient(ellipse at 50% 50%, rgba(6, 22, 56, 0.15) 0%, rgba(2, 6, 18, 0) 70%);
		pointer-events: none;
	}

	.graph-canvas {
		-webkit-app-region: no-drag;
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
		letter-spacing: 0.22em;
		color: rgba(226, 232, 240, 0.95);
		text-shadow: 0 0 18px rgba(96, 165, 250, 0.25);
	}

	.map-subtitle {
		margin-top: 5px;
		font-family: var(--font-body);
		font-size: 10px;
		letter-spacing: 0.1em;
		color: rgba(148, 163, 184, 0.72);
		text-transform: uppercase;
	}

	.map-controls {
		-webkit-app-region: no-drag;
		position: absolute;
		left: 24px;
		bottom: 24px;
		z-index: 6;
		display: flex;
		flex-direction: column;
		gap: 8px;
		align-items: flex-start;
		width: 276px;
	}

	.map-controls button,
	.zoom-row {
		border: 1px solid rgba(96, 165, 250, 0.12);
		background: rgba(4, 10, 28, 0.78);
		backdrop-filter: blur(10px);
		box-shadow:
			0 1px 2px rgba(0, 0, 0, 0.25),
			inset 0 1px 0 rgba(255, 255, 255, 0.04);
	}

	.map-controls button,
	.popover-actions button {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		gap: 8px;
		height: 36px;
		padding: 0 16px;
		border-radius: 6px;
		font-family: var(--font-body);
		font-size: 11px;
		color: rgba(241, 245, 249, 0.9);
		cursor: pointer;
		transition: border-color 120ms ease, color 120ms ease, box-shadow 120ms ease, background 120ms ease;
	}

	.map-controls button:hover,
	.popover-actions button:hover {
		border-color: rgba(96, 165, 250, 0.45);
		color: rgba(255, 255, 255, 0.98);
		background: rgba(15, 30, 72, 0.65);
		box-shadow: 0 0 12px rgba(96, 165, 250, 0.12), inset 0 1px 0 rgba(255, 255, 255, 0.06);
	}

	.map-controls button {
		width: 124px;
		justify-content: flex-start;
		gap: 12px;
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
		min-width: 22px;
		padding: 2px 5px;
		border-radius: 4px;
		border: 1px solid rgba(71, 85, 105, 0.5);
		background: rgba(2, 6, 23, 0.5);
		font-family: var(--font-mono);
		font-size: 9px;
		line-height: 1.4;
		text-align: center;
		color: rgba(148, 163, 184, 0.7);
	}

	.zoom-row {
		display: flex;
		align-items: center;
		gap: 6px;
		width: 148px;
		height: 38px;
		padding: 0 10px 0 14px;
		border-radius: 6px;
		font-family: var(--font-body);
		font-size: 11px;
		color: rgba(241, 245, 249, 0.88);
	}

	.zoom-row > span {
		width: 44px;
		text-align: left;
	}

	.zoom-row button {
		min-width: 28px;
		width: 28px;
		height: 28px;
		justify-content: center;
		padding: 0;
		font-size: 12px;
		border-radius: 5px;
	}

	.legend-shell {
		display: flex;
		flex-direction: column;
		gap: 6px;
		width: 100%;
	}

	.legend-toggle {
		width: 234px !important;
		justify-content: flex-start;
	}

	.legend-chevron {
		display: inline-flex;
		width: 10px;
		transition: transform 120ms ease;
		color: rgba(96, 165, 250, 0.7);
	}

	.legend-toggle-open .legend-chevron {
		transform: rotate(90deg);
	}

	.legend-list {
		display: flex;
		flex-direction: column;
		gap: 14px;
		width: 234px;
		min-height: 220px;
		padding: 22px 24px 20px;
		box-sizing: border-box;
		border: 1px solid rgba(96, 165, 250, 0.1);
		border-radius: 10px;
		background: rgba(4, 10, 28, 0.82);
		backdrop-filter: blur(12px);
		box-shadow:
			0 4px 24px rgba(0, 0, 0, 0.35),
			inset 0 1px 0 rgba(255, 255, 255, 0.04);
	}

	.legend-section {
		display: flex;
		flex-direction: column;
		gap: 8px;
		min-width: 0;
	}

	.legend-heading {
		font-family: var(--font-mono);
		font-size: 8px;
		letter-spacing: 0.2em;
		line-height: 1.4;
		color: rgba(125, 211, 252, 0.7);
		text-transform: uppercase;
	}

	.legend-grid {
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		column-gap: 10px;
		row-gap: 4px;
	}

	.legend-item {
		display: grid;
		grid-template-columns: 12px minmax(0, 1fr);
		align-items: center;
		gap: 8px;
		min-height: 22px;
		padding: 2px 6px;
		border-radius: 4px;
		font-family: var(--font-body);
		font-size: 8px;
		letter-spacing: 0.12em;
		color: rgba(203, 213, 225, 0.78);
		text-transform: uppercase;
		transition: background 100ms ease;
	}

	.legend-item:hover {
		background: rgba(96, 165, 250, 0.06);
	}

	.legend-item span:last-child {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.legend-empty {
		grid-column: 1 / -1;
		min-height: 22px;
		padding: 2px 6px;
		font-family: var(--font-body);
		font-size: 8px;
		letter-spacing: 0.12em;
		color: rgba(148, 163, 184, 0.5);
		text-transform: uppercase;
	}

	.legend-structure .legend-item + .legend-item {
		border-top: 1px solid rgba(96, 165, 250, 0.06);
	}

	.legend-dot {
		flex: 0 0 auto;
		justify-self: center;
		width: 6px;
		height: 6px;
		border-radius: 2px;
		transform: rotate(45deg);
		border: 1px solid rgba(226, 232, 240, 0.35);
		box-shadow: 0 0 4px rgba(226, 232, 240, 0.15);
	}

	.node-popover {
		-webkit-app-region: no-drag;
		position: absolute;
		z-index: 8;
		display: flex;
		flex-direction: column;
		padding: 24px 28px 20px;
		border: 1px solid rgba(96, 165, 250, 0.1);
		border-radius: 12px;
		background: rgba(4, 10, 28, 0.88);
		backdrop-filter: blur(16px);
		box-shadow:
			0 8px 32px rgba(0, 0, 0, 0.4),
			0 0 0 1px rgba(96, 165, 250, 0.04),
			inset 0 1px 0 rgba(255, 255, 255, 0.04);
		overflow: hidden;
		color: rgba(241, 245, 249, 0.94);
		pointer-events: auto;
	}

	.node-popover::before {
		position: absolute;
		top: 0;
		left: 0;
		right: 0;
		height: 1px;
		content: "";
		background: linear-gradient(90deg, transparent 5%, rgba(96, 165, 250, 0.25) 50%, transparent 95%);
		pointer-events: none;
	}

	/* Subtle inner starfield pattern */
	.node-popover::after {
		position: absolute;
		inset: 14px;
		content: "";
		background:
			radial-gradient(circle at 20% 30%, rgba(96, 165, 250, 0.035) 0%, transparent 2px),
			radial-gradient(circle at 70% 20%, rgba(96, 165, 250, 0.025) 0%, transparent 1.5px),
			radial-gradient(circle at 40% 70%, rgba(96, 165, 250, 0.03) 0%, transparent 2px),
			radial-gradient(circle at 85% 60%, rgba(96, 165, 250, 0.02) 0%, transparent 1.5px),
			radial-gradient(circle at 10% 80%, rgba(96, 165, 250, 0.025) 0%, transparent 2px);
		pointer-events: none;
		z-index: 0;
	}

	.node-popover > * {
		position: relative;
		z-index: 1;
	}

	.node-popover.selected {
		border-color: rgba(96, 165, 250, 0.18);
		background: rgba(5, 14, 40, 0.92);
		box-shadow:
			0 8px 32px rgba(0, 0, 0, 0.45),
			0 0 0 1px rgba(96, 165, 250, 0.06),
			0 0 24px rgba(96, 165, 250, 0.06),
			inset 0 1px 0 rgba(255, 255, 255, 0.05);
	}

	.node-popover-content {
		min-height: 0;
		padding-right: 4px;
		overflow-y: auto;
		overscroll-behavior: contain;
		scrollbar-width: thin;
		scrollbar-color: rgba(96, 165, 250, 0.38) transparent;
	}

	.node-card-kind {
		font-family: var(--font-mono);
		font-size: 9px;
		letter-spacing: 0.18em;
		text-transform: uppercase;
		color: rgba(96, 165, 250, 0.85);
	}

	.node-card-title {
		margin-top: 8px;
		font-family: var(--font-heading);
		font-size: 20px;
		line-height: 1.1;
		letter-spacing: 0.01em;
		color: rgba(241, 245, 249, 0.96);
		text-shadow: 0 0 14px rgba(96, 165, 250, 0.12);
	}

	.attribute-popover .node-card-title {
		font-family: var(--font-body);
		font-size: 13px;
		line-height: 1.48;
		letter-spacing: 0;
		overflow-wrap: anywhere;
		word-break: normal;
		color: rgba(226, 232, 240, 0.92);
	}

	.entity-navigator-popover {
		height: auto;
		padding: 16px 20px 12px;
	}

	/* Hide starfield pattern in navigator - too much visual noise when empty */
	.entity-navigator-popover::after {
		display: none;
	}

	.entity-navigator-popover .node-popover-content {
		padding-right: 4px;
		min-height: 0;
	}

	.entity-navigator-title {
		margin-top: 4px;
		font-size: 17px;
		line-height: 1;
	}

	.entity-navigator-subtitle {
		margin-top: 3px;
		font-family: var(--font-mono);
		font-size: 8px;
		letter-spacing: 0.1em;
		color: rgba(148, 163, 184, 0.6);
		text-transform: uppercase;
	}

	.entity-search-label {
		display: block;
		margin-top: 10px;
		font-family: var(--font-mono);
		font-size: 8px;
		letter-spacing: 0.14em;
		color: rgba(125, 211, 252, 0.6);
		text-transform: uppercase;
	}

	.entity-search-input {
		box-sizing: border-box;
		width: 100%;
		height: 34px;
		margin-top: 4px;
		padding: 0 11px;
		border: 1px solid rgba(96, 165, 250, 0.12);
		border-radius: 6px;
		outline: none;
		background: rgba(2, 6, 23, 0.55);
		font-family: var(--font-body);
		font-size: 12px;
		color: rgba(241, 245, 249, 0.94);
		transition: border-color 150ms ease, box-shadow 150ms ease, background 150ms ease;
	}

	.entity-search-input:focus {
		border-color: rgba(96, 165, 250, 0.45);
		background: rgba(2, 6, 23, 0.7);
		box-shadow: 0 0 0 3px rgba(96, 165, 250, 0.08), 0 0 12px rgba(96, 165, 250, 0.08);
	}

	.entity-search-input::placeholder {
		color: rgba(148, 163, 184, 0.4);
	}

	.entity-navigator-results {
		display: grid;
		gap: 3px;
		margin-top: 8px;
		max-height: 220px;
		overflow-y: auto;
		scrollbar-width: thin;
		scrollbar-color: rgba(96, 165, 250, 0.3) transparent;
	}

	.entity-navigator-results button {
		position: relative;
		display: grid;
		grid-template-columns: minmax(0, 1fr);
		gap: 1px;
		align-items: center;
		justify-content: stretch;
		width: 100%;
		min-height: 36px;
		padding: 4px 9px 5px;
		border: 1px solid rgba(96, 165, 250, 0.06);
		border-radius: 5px;
		background: rgba(15, 23, 42, 0.22);
		color: rgba(226, 232, 240, 0.85);
		text-align: left;
		cursor: pointer;
		transition: border-color 120ms ease, background 120ms ease, box-shadow 120ms ease;
	}

	.entity-navigator-results button:hover {
		border-color: rgba(96, 165, 250, 0.25);
		background: rgba(30, 58, 138, 0.15);
		box-shadow: 0 0 10px rgba(96, 165, 250, 0.05);
	}

	.entity-navigator-results button span {
		position: relative;
		min-width: 0;
		overflow: hidden;
		font-family: var(--font-body);
		font-size: 11px;
		line-height: 1.25;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.entity-navigator-results button small {
		position: relative;
		min-width: 0;
		overflow: hidden;
		font-family: var(--font-mono);
		font-size: 8px;
		line-height: 1.2;
		color: rgba(125, 211, 252, 0.55);
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.entity-navigator-empty {
		min-height: 28px;
		padding-top: 6px;
		font-family: var(--font-body);
		font-size: 9px;
		letter-spacing: 0.1em;
		color: rgba(148, 163, 184, 0.4);
		text-transform: uppercase;
		text-align: center;
	}

	.entity-navigator-empty::before {
		display: block;
		width: 14px;
		height: 14px;
		margin: 0 auto 4px;
		content: "";
		background: radial-gradient(circle, rgba(96, 165, 250, 0.15) 0%, transparent 70%);
		border: 1px solid rgba(96, 165, 250, 0.08);
		transform: rotate(45deg);
	}

	.node-card-preview {
		margin-top: 8px;
		max-height: 54px;
		overflow: hidden;
		font-family: var(--font-body);
		font-size: 11px;
		line-height: 1.45;
		color: rgba(203, 213, 225, 0.78);
	}

	.node-detail-list {
		display: grid;
		gap: 6px;
		margin-top: 10px;
		padding-top: 10px;
		border-top: 1px solid rgba(96, 165, 250, 0.08);
	}

	.node-detail-row {
		display: grid;
		grid-template-columns: 88px minmax(0, 1fr);
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
		color: rgba(125, 211, 252, 0.65);
	}

	.node-detail-row strong {
		min-width: 0;
		max-height: 48px;
		overflow: hidden;
		font-weight: 500;
		color: rgba(226, 232, 240, 0.88);
	}

	.popover-actions {
		display: flex;
		flex-wrap: wrap;
		gap: 6px;
		margin-top: 10px;
	}

	.popover-actions button {
		min-width: 0;
		height: 32px;
		max-width: 100%;
		padding: 0 14px;
		border: 1px solid rgba(96, 165, 250, 0.15);
		border-radius: 6px;
		background: rgba(15, 23, 42, 0.5);
		transition: border-color 120ms ease, background 120ms ease, box-shadow 120ms ease;
	}

	.popover-actions button:hover {
		border-color: rgba(96, 165, 250, 0.4);
		background: rgba(30, 58, 138, 0.2);
		box-shadow: 0 0 10px rgba(96, 165, 250, 0.08);
	}

	.popover-more {
		display: inline-flex;
		align-items: center;
		height: 28px;
		padding: 0 10px;
		font-family: var(--font-mono);
		font-size: 9px;
		color: rgba(148, 163, 184, 0.7);
	}

	.popover-actions button strong {
		min-width: 0;
		overflow: hidden;
		font-size: 10px;
		font-weight: 500;
		text-overflow: ellipsis;
		white-space: nowrap;
		color: rgba(226, 232, 240, 0.88);
	}

	.node-card-footer {
		display: flex;
		justify-content: space-between;
		gap: 14px;
		margin-top: auto;
		padding-top: 8px;
		border-top: 1px solid rgba(96, 165, 250, 0.06);
		font-family: var(--font-mono);
		font-size: 9px;
		color: rgba(148, 163, 184, 0.65);
	}

	.entity-navigator-popover .node-card-footer {
		margin-top: 10px;
		padding-top: 6px;
	}

	.node-card-footer code {
		font-family: var(--font-mono);
		color: rgba(148, 163, 184, 0.75);
	}

	/* === Light mode overrides === */
	:global([data-theme="light"]) .knowledge-map-zone {
		background: #f0f1f5;
	}

	:global([data-theme="light"]) .knowledge-map-zone::before {
		opacity: 0.08;
		filter: invert(1);
	}

	:global([data-theme="light"]) .knowledge-map-zone::after {
		background:
			linear-gradient(90deg, rgba(240, 241, 245, 0.85), rgba(240, 241, 245, 0.35) 28%, rgba(240, 241, 245, 0.35) 68%, rgba(240, 241, 245, 0.82)),
			linear-gradient(180deg, rgba(240, 241, 245, 0.7), rgba(240, 241, 245, 0.4) 40%, rgba(240, 241, 245, 0.78)),
			radial-gradient(ellipse at 50% 50%, rgba(10, 57, 255, 0.04) 0%, rgba(240, 241, 245, 0) 70%);
	}

	:global([data-theme="light"]) .map-title {
		color: rgba(36, 41, 54, 0.95);
		text-shadow: none;
	}

	:global([data-theme="light"]) .map-subtitle {
		color: rgba(94, 102, 117, 0.72);
	}

	:global([data-theme="light"]) .map-controls button,
	:global([data-theme="light"]) .zoom-row {
		border-color: rgba(10, 57, 255, 0.14);
		background: rgba(252, 252, 250, 0.88);
		box-shadow: 0 1px 2px rgba(0, 0, 0, 0.08), inset 0 1px 0 rgba(255, 255, 255, 0.5);
		color: rgba(36, 41, 54, 0.9);
	}

	:global([data-theme="light"]) .map-controls button:hover {
		border-color: rgba(10, 57, 255, 0.4);
		background: rgba(255, 255, 255, 0.95);
		box-shadow: 0 0 12px rgba(10, 57, 255, 0.1), inset 0 1px 0 rgba(255, 255, 255, 0.6);
		color: rgba(11, 14, 23, 0.98);
	}

	:global([data-theme="light"]) kbd {
		border-color: rgba(10, 57, 255, 0.2);
		background: rgba(237, 238, 240, 0.7);
		color: rgba(94, 102, 117, 0.7);
	}

	:global([data-theme="light"]) .legend-list {
		border-color: rgba(10, 57, 255, 0.12);
		background: rgba(252, 252, 250, 0.9);
		box-shadow: 0 4px 24px rgba(0, 0, 0, 0.1), inset 0 1px 0 rgba(255, 255, 255, 0.5);
	}

	:global([data-theme="light"]) .legend-heading {
		color: rgba(10, 57, 255, 0.7);
	}

	:global([data-theme="light"]) .legend-item {
		color: rgba(36, 41, 54, 0.78);
	}

	:global([data-theme="light"]) .legend-item:hover {
		background: rgba(10, 57, 255, 0.04);
	}

	:global([data-theme="light"]) .legend-empty {
		color: rgba(94, 102, 117, 0.55);
	}

	:global([data-theme="light"]) .legend-dot {
		border-color: rgba(36, 41, 54, 0.3);
		box-shadow: 0 0 4px rgba(36, 41, 54, 0.1);
	}

	:global([data-theme="light"]) .node-popover {
		border-color: rgba(10, 57, 255, 0.12);
		background: rgba(252, 252, 250, 0.94);
		box-shadow: 0 8px 32px rgba(0, 0, 0, 0.12), 0 0 0 1px rgba(10, 57, 255, 0.04), inset 0 1px 0 rgba(255, 255, 255, 0.6);
	}

	:global([data-theme="light"]) .node-popover::before {
		background: linear-gradient(90deg, transparent 5%, rgba(10, 57, 255, 0.2) 50%, transparent 95%);
	}

	:global([data-theme="light"]) .node-popover.selected {
		border-color: rgba(10, 57, 255, 0.2);
		background: rgba(255, 255, 255, 0.96);
		box-shadow: 0 8px 32px rgba(0, 0, 0, 0.14), 0 0 0 1px rgba(10, 57, 255, 0.06), 0 0 24px rgba(10, 57, 255, 0.06), inset 0 1px 0 rgba(255, 255, 255, 0.7);
	}

	:global([data-theme="light"]) .node-card-kind {
		color: rgba(10, 57, 255, 0.8);
	}

	:global([data-theme="light"]) .node-card-title {
		color: rgba(11, 14, 23, 0.96);
		text-shadow: none;
	}

	:global([data-theme="light"]) .attribute-popover .node-card-title {
		color: rgba(36, 41, 54, 0.92);
	}

	:global([data-theme="light"]) .node-card-preview {
		color: rgba(94, 102, 117, 0.82);
	}

	:global([data-theme="light"]) .entity-navigator-subtitle {
		color: rgba(94, 102, 117, 0.6);
	}

	:global([data-theme="light"]) .entity-search-label {
		color: rgba(10, 57, 255, 0.65);
	}

	:global([data-theme="light"]) .entity-search-input {
		border-color: rgba(10, 57, 255, 0.14);
		background: rgba(255, 255, 255, 0.7);
		color: rgba(11, 14, 23, 0.94);
	}

	:global([data-theme="light"]) .entity-search-input:focus {
		border-color: rgba(10, 57, 255, 0.45);
		background: rgba(255, 255, 255, 0.9);
		box-shadow: 0 0 0 3px rgba(10, 57, 255, 0.06), 0 0 12px rgba(10, 57, 255, 0.06);
	}

	:global([data-theme="light"]) .entity-search-input::placeholder {
		color: rgba(94, 102, 117, 0.4);
	}

	:global([data-theme="light"]) .entity-navigator-results button {
		border-color: rgba(10, 57, 255, 0.06);
		background: rgba(237, 238, 240, 0.4);
		color: rgba(36, 41, 54, 0.85);
	}

	:global([data-theme="light"]) .entity-navigator-results button:hover {
		border-color: rgba(10, 57, 255, 0.2);
		background: rgba(10, 57, 255, 0.04);
		box-shadow: 0 0 10px rgba(10, 57, 255, 0.04);
	}

	:global([data-theme="light"]) .entity-navigator-results button small {
		color: rgba(10, 57, 255, 0.6);
	}

	:global([data-theme="light"]) .entity-navigator-empty {
		color: rgba(94, 102, 117, 0.4);
	}

	:global([data-theme="light"]) .entity-navigator-empty::before {
		background: radial-gradient(circle, rgba(10, 57, 255, 0.18) 0%, transparent 70%);
		border-color: rgba(10, 57, 255, 0.1);
	}

	:global([data-theme="light"]) .node-detail-list {
		border-top-color: rgba(10, 57, 255, 0.08);
	}

	:global([data-theme="light"]) .node-detail-row span,
	:global([data-theme="light"]) .popover-actions button span {
		color: rgba(10, 57, 255, 0.65);
	}

	:global([data-theme="light"]) .node-detail-row strong {
		color: rgba(36, 41, 54, 0.9);
	}

	:global([data-theme="light"]) .popover-actions button {
		border-color: rgba(10, 57, 255, 0.15);
		background: rgba(237, 238, 240, 0.6);
	}

	:global([data-theme="light"]) .popover-actions button:hover {
		border-color: rgba(10, 57, 255, 0.35);
		background: rgba(10, 57, 255, 0.06);
		box-shadow: 0 0 10px rgba(10, 57, 255, 0.06);
	}

	:global([data-theme="light"]) .popover-actions button strong {
		color: rgba(36, 41, 54, 0.88);
	}

	:global([data-theme="light"]) .popover-more {
		color: rgba(94, 102, 117, 0.7);
	}

	:global([data-theme="light"]) .node-card-footer {
		border-top-color: rgba(10, 57, 255, 0.06);
		color: rgba(94, 102, 117, 0.65);
	}

	:global([data-theme="light"]) .node-card-footer code {
		color: rgba(94, 102, 117, 0.75);
	}

	:global([data-theme="light"]) .legend-chevron {
		color: rgba(10, 57, 255, 0.7);
	}

	@media (max-width: 700px) {
		.map-controls {
			left: 14px;
			bottom: 14px;
		}
	}
</style>

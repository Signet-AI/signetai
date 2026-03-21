<script lang="ts">
import { forceCollide, forceLink, forceManyBody, forceSimulation, forceX, forceY } from "d3-force";
import type { EmbeddingPoint } from "../../api";
import {
	type GraphEdge,
	type GraphNode,
	type GraphPhysicsConfig,
	type NodeColorMode,
	type RelationKind,
	NodeColorCache,
	SpatialGrid,
	clampGraphPhysics,
	dependencyEdgeStyle,
	edgeStrokeStyle,
	embeddingLabel,
	entityFillFast,
	hexPath,
	isNewSinceLastSeen,
	tierChargeStrength,
} from "./embedding-graph";

interface Props {
	nodes: GraphNode[];
	edges: GraphEdge[];
	graphSelected: EmbeddingPoint | null;
	graphHovered: EmbeddingPoint | null;
	embeddingFilterIds: Set<string> | null;
	relationLookup: Map<string, RelationKind>;
	pinnedIds: Set<string>;
	lensIds: Set<string>;
	clusterLensMode: boolean;
	graphPhysics: GraphPhysicsConfig;
	colorMode: NodeColorMode;
	nowMs: number;
	showNewSinceLastSeen: boolean;
	lastSeenMs: number | null;
	sourceFocusSources: Set<string> | null;
	onselectnode: (embedding: EmbeddingPoint | null) => void;
	onhovernode: (embedding: EmbeddingPoint | null) => void;
}

// biome-ignore lint/style/useConst: Svelte keeps prop bindings reactive.
let {
	nodes,
	edges,
	graphSelected,
	graphHovered,
	embeddingFilterIds,
	relationLookup,
	pinnedIds,
	lensIds,
	clusterLensMode,
	graphPhysics,
	colorMode,
	nowMs,
	showNewSinceLastSeen,
	lastSeenMs,
	sourceFocusSources,
	onselectnode,
	onhovernode,
}: Props = $props();

// biome-ignore lint/style/useConst: Mutated by bind:this.
let canvas = $state<HTMLCanvasElement | null>(null);

// Camera state (internal)
let camX = 0;
let camY = 0;
let camZoom = 0.15;

// Interaction state
let isPanning = false;
let isDragging = false;
let didDrag = false;
let dragNode: GraphNode | null = null;
let panStartX = 0;
let panStartY = 0;
let panCamStartX = 0;
let panCamStartY = 0;
const DRAG_THRESHOLD = 4;

let simulation: ReturnType<typeof forceSimulation> | null = null;
let animFrame = 0;
let interactionCleanup: (() => void) | null = null;
let resizeListenerAttached = false;
let lastFrameTime = 0;
let needsRedraw = true;
let lastHoveredId: string | null = null;
let userAdjustedCamera = false;

// Phase 4: O(1) node lookup by ID
let nodeById = new Map<string, GraphNode>();

// Phase 2: Spatial grid for O(1) hit testing
const grid = new SpatialGrid();
let gridDirty = true;

// Phase 1: Pre-computed node color cache
let colorCache: NodeColorCache | null = null;

// Phase 3: Pre-partitioned edge arrays
let hierEdges: GraphEdge[] = [];
let knnEdges: GraphEdge[] = [];
let depEdges: GraphEdge[] = [];

// Phase 7: Coalesced hover processing
let pendingHoverX = 0;
let pendingHoverY = 0;
let pendingHover = false;

// Throttled camera fit — avoids O(n) computeWorldBounds on every tick
let lastFitTime = 0;
const FIT_THROTTLE_MS = 100;

function throttledFitCamera(): void {
	const now = performance.now();
	if (now - lastFitTime > FIT_THROTTLE_MS) {
		fitCameraToBounds();
		lastFitTime = now;
	}
}

// Minimap state
const MINIMAP_WIDTH = 160;
const MINIMAP_HEIGHT = 120;
const MINIMAP_NODE_THRESHOLD = 50;

let minimapEl = $state<HTMLCanvasElement | null>(null);
let minimapNeedsRedraw = true;
let minimapFrameCount = 0;
const MINIMAP_FRAME_SKIP = 4;

let worldBounds = $state({ minX: -100, maxX: 100, minY: -100, maxY: 100 });
let showMinimap = $derived(nodes.length > MINIMAP_NODE_THRESHOLD);
let minimapDragging = false;

function requestRedraw(): void {
	needsRedraw = true;
	minimapNeedsRedraw = true;
	if (!animFrame) {
		const ctx = canvas?.getContext("2d");
		if (ctx) {
			animFrame = requestAnimationFrame((ts) => draw(ctx, ts));
		}
	}
}

const MAX_EDGES_NEAR = 12000;
const MAX_EDGES_MID = 8000;
const MAX_EDGES_FAR = 5000;

// ---------------------------------------------------------------------------
// Public API exposed to parent
// ---------------------------------------------------------------------------

export function resetCamera(): void {
	camX = 0;
	camY = 0;
	camZoom = 0.15;
	userAdjustedCamera = false;
	initialFitDone = false;
}

// Track whether the initial camera fit has been done — prevents bounce on load
let initialFitDone = false;

export function focusNode(id: string): void {
	const node = nodeById.get(id);
	if (!node) return;
	camX = node.x;
	camY = node.y;
	camZoom = Math.max(camZoom, 1.6);
	userAdjustedCamera = true;
}

export function startSimulation(
	graphNodes: GraphNode[],
	graphEdges: GraphEdge[],
	nextPhysics: GraphPhysicsConfig = graphPhysics,
): void {
	simulation?.stop();
	initialFitDone = false;
	const physics = clampGraphPhysics(nextPhysics);
	simulation = forceSimulation(graphNodes as any)
		.force("link", forceLink(graphEdges).distance(physics.linkDistance).strength(physics.linkForce))
		.force("charge", forceManyBody().strength(physics.repelForce))
		.force("x", forceX(0).strength(physics.centerForce))
		.force("y", forceY(0).strength(physics.centerForce))
		.force(
			"collide",
			forceCollide().radius((entry: any) => entry.radius + 2),
		)
		.alphaDecay(0.04)
		.on("tick", () => {
			gridDirty = true;
			colorCache = null;
			requestRedraw();
		})
		.on("end", () => {
			if (!userAdjustedCamera) fitCameraToBounds();
		});
}

export function startKnowledgeGraphSimulation(
	graphNodes: GraphNode[],
	graphEdges: GraphEdge[],
): void {
	simulation?.stop();
	initialFitDone = false;

	// Tier-aware link distances and strengths
	const linkForce = forceLink(graphEdges)
		.distance((d: any) => {
			const s = d.source as GraphNode;
			const t = d.target as GraphNode;
			if (d.edgeType === "dependency") return 120;
			if (s.nodeType === "entity" && t.nodeType === "aspect") return 50;
			if (s.nodeType === "aspect" && t.nodeType === "attribute") return 30;
			if (s.nodeType === "attribute" && t.nodeType === "memory") return 20;
			return 50;
		})
		.strength((d: any) => {
			if (d.edgeType === "dependency") return 0.05;
			const s = d.source as GraphNode;
			const t = d.target as GraphNode;
			if (s.nodeType === "entity" && t.nodeType === "aspect") return 0.3;
			if (s.nodeType === "aspect" && t.nodeType === "attribute") return 0.4;
			if (s.nodeType === "attribute" && t.nodeType === "memory") return 0.5;
			return 0.3;
		});

	// Tier-aware charge
	const charge = forceManyBody().strength((d: any) => tierChargeStrength(d.nodeType));

	simulation = forceSimulation(graphNodes as any)
		.force("link", linkForce)
		.force("charge", charge)
		.force("x", forceX(0).strength(0.03))
		.force("y", forceY(0).strength(0.03))
		.force(
			"collide",
			forceCollide().radius((entry: any) => entry.radius + 2),
		)
		.alphaDecay(0.04)
		.on("tick", () => {
			gridDirty = true;
			colorCache = null;
			requestRedraw();
		})
		.on("end", () => {
			if (!userAdjustedCamera) fitCameraToBounds();
		});
}

export function updatePhysics(nextPhysics: GraphPhysicsConfig): void {
	if (!simulation) return;
	startSimulation(nodes, edges, nextPhysics);
	requestRedraw();
}

export function stopSimulation(): void {
	simulation?.stop();
	simulation = null;
}

export function startRendering(skipInitialFit = false): void {
	resizeCanvas();
	// Fit camera now that canvas is sized — only for UMAP mode where positions are stable
	// Entity overlay starts with random positions so skip fit (wait for simulation end)
	if (!skipInitialFit && !userAdjustedCamera && nodes.length > 0) fitCameraToBounds();
	if (!resizeListenerAttached) {
		window.addEventListener("resize", resizeCanvas);
		resizeListenerAttached = true;
	}
	setupInteractions();
	needsRedraw = true;
	const ctx = canvas?.getContext("2d");
	if (ctx) {
		cancelAnimationFrame(animFrame);
		draw(ctx, 0);
	}
}

export function resumeRendering(): void {
	needsRedraw = true;
	const ctx = canvas?.getContext("2d");
	if (ctx) {
		cancelAnimationFrame(animFrame);
		draw(ctx, 0);
	}
}

export function stopRendering(): void {
	cancelAnimationFrame(animFrame);
}

// ---------------------------------------------------------------------------
// Canvas helpers
// ---------------------------------------------------------------------------

function resizeCanvas(): void {
	if (!canvas) return;
	// Walk up past display:contents wrappers to find a sized ancestor
	let el: HTMLElement | null = canvas.parentElement;
	while (el && getComputedStyle(el).display === "contents") {
		el = el.parentElement;
	}
	const rect = el?.getBoundingClientRect();
	if (!rect || rect.width === 0) return;
	canvas.width = rect.width;
	canvas.height = rect.height;
	// Only re-fit on resize if simulation has already settled once
	if (!userAdjustedCamera && initialFitDone) {
		fitCameraToBounds();
	}
	requestRedraw();
}

function fitCameraToBounds(): void {
	if (!canvas) return;
	if (nodes.length === 0) {
		camX = 0;
		camY = 0;
		camZoom = 0.15;
		return;
	}

	const bounds = computeWorldBounds();
	const worldWidth = Math.max(bounds.maxX - bounds.minX, 1);
	const worldHeight = Math.max(bounds.maxY - bounds.minY, 1);
	const viewWidth = Math.max(canvas.width, 1);
	const viewHeight = Math.max(canvas.height, 1);
	const fitZoom = Math.min(viewWidth / worldWidth, viewHeight / worldHeight) * 0.92;

	camX = (bounds.minX + bounds.maxX) / 2;
	camY = (bounds.minY + bounds.maxY) / 2;
	camZoom = Math.max(0.08, fitZoom);
	initialFitDone = true;
}

function screenToWorld(sx: number, sy: number): [number, number] {
	if (!canvas) return [0, 0];
	const rect = canvas.getBoundingClientRect();
	const cx = rect.width / 2;
	const cy = rect.height / 2;
	return [(sx - rect.left - cx) / camZoom + camX, (sy - rect.top - cy) / camZoom + camY];
}

function findNodeAt(wx: number, wy: number): GraphNode | null {
	if (gridDirty) {
		grid.rebuild(nodes);
		gridDirty = false;
	}
	const candidates = grid.query(wx, wy, 28);
	// Hit detection in priority order: entity > aspect > attribute > memory
	const hitOrder: Array<GraphNode["nodeType"]> = ["entity", "aspect", "attribute", "memory", undefined];
	for (const tier of hitOrder) {
		for (let i = candidates.length - 1; i >= 0; i--) {
			const n = candidates[i];
			if (n.nodeType !== tier) continue;
			const dx = n.x - wx;
			const dy = n.y - wy;
			const hitR = n.radius + (tier === "entity" ? 6 : tier === "aspect" ? 5 : 4);
			if (dx * dx + dy * dy <= hitR * hitR) return n;
		}
	}
	return null;
}

// ---------------------------------------------------------------------------
// World bounds (for minimap)
// ---------------------------------------------------------------------------

function computeWorldBounds(): { minX: number; maxX: number; minY: number; maxY: number } {
	if (nodes.length === 0) {
		return { minX: -100, maxX: 100, minY: -100, maxY: 100 };
	}
	// Use spatial grid bounds when available (already computed during rebuild)
	if (!gridDirty) {
		return { minX: grid.minX, maxX: grid.maxX, minY: grid.minY, maxY: grid.maxY };
	}
	grid.rebuild(nodes);
	gridDirty = false;
	return { minX: grid.minX, maxX: grid.maxX, minY: grid.minY, maxY: grid.maxY };
}

$effect(() => {
	if (nodes.length > 0) {
		// Rebuild nodeById map and mark grid as dirty
		nodeById = new Map(nodes.map((n) => [n.data.id, n]));
		gridDirty = true;
		colorCache = null;
		worldBounds = computeWorldBounds();
		minimapNeedsRedraw = true;
	}
});

// ---------------------------------------------------------------------------
// Minimap rendering
// ---------------------------------------------------------------------------

function drawMinimap(): void {
	if (!minimapEl || !canvas) return;

	const ctx = minimapEl.getContext("2d");
	if (!ctx) return;

	const { minX, maxX, minY, maxY } = worldBounds;
	const worldW = maxX - minX;
	const worldH = maxY - minY;

	ctx.fillStyle = "#050505";
	ctx.fillRect(0, 0, MINIMAP_WIDTH, MINIMAP_HEIGHT);

	const scaleX = (MINIMAP_WIDTH - 8) / worldW;
	const scaleY = (MINIMAP_HEIGHT - 8) / worldH;
	const scale = Math.min(scaleX, scaleY);

	const offsetX = (MINIMAP_WIDTH - worldW * scale) / 2;
	const offsetY = (MINIMAP_HEIGHT - worldH * scale) / 2;

	ctx.fillStyle = "rgba(140, 140, 150, 0.5)";
	for (const node of nodes) {
		const mx = offsetX + (node.x - minX) * scale;
		const my = offsetY + (node.y - minY) * scale;
		ctx.fillRect(mx - 0.5, my - 0.5, 1, 1);
	}

	const vw = canvas.width / camZoom;
	const vh = canvas.height / camZoom;
	const vx = camX - vw / 2;
	const vy = camY - vh / 2;

	let mvx = offsetX + (vx - minX) * scale;
	let mvy = offsetY + (vy - minY) * scale;
	let mvw = vw * scale;
	let mvh = vh * scale;

	const margin = 2;
	mvx = Math.max(margin, Math.min(MINIMAP_WIDTH - margin - 1, mvx));
	mvy = Math.max(margin, Math.min(MINIMAP_HEIGHT - margin - 1, mvy));
	mvw = Math.max(2, Math.min(MINIMAP_WIDTH - mvx - margin, mvw));
	mvh = Math.max(2, Math.min(MINIMAP_HEIGHT - mvy - margin, mvh));

	ctx.strokeStyle = "rgba(255, 255, 255, 0.75)";
	ctx.lineWidth = 1.5;
	ctx.strokeRect(mvx, mvy, mvw, mvh);

	ctx.fillStyle = "rgba(255, 255, 255, 0.03)";
	ctx.fillRect(mvx, mvy, mvw, mvh);
}

// ---------------------------------------------------------------------------
// Minimap interaction
// ---------------------------------------------------------------------------

function getMinimapClickWorldCoords(event: MouseEvent): [number, number] | null {
	if (!minimapEl) return null;

	const rect = minimapEl.getBoundingClientRect();
	const mx = event.clientX - rect.left;
	const my = event.clientY - rect.top;

	const { minX, maxX, minY, maxY } = worldBounds;
	const worldW = maxX - minX;
	const worldH = maxY - minY;

	const scaleX = (MINIMAP_WIDTH - 8) / worldW;
	const scaleY = (MINIMAP_HEIGHT - 8) / worldH;
	const scale = Math.min(scaleX, scaleY);

	const offsetX = (MINIMAP_WIDTH - worldW * scale) / 2;
	const offsetY = (MINIMAP_HEIGHT - worldH * scale) / 2;

	const wx = minX + (mx - offsetX) / scale;
	const wy = minY + (my - offsetY) / scale;

	return [wx, wy];
}

function handleMinimapMouseDown(event: MouseEvent): void {
	event.preventDefault();
	event.stopPropagation();
	minimapDragging = true;
	handleMinimapNavigate(event);
}

function handleMinimapMouseMove(event: MouseEvent): void {
	if (!minimapDragging) return;
	handleMinimapNavigate(event);
}

function handleMinimapNavigate(event: MouseEvent): void {
	const coords = getMinimapClickWorldCoords(event);
	if (!coords) return;

	const [wx, wy] = coords;
	camX = wx;
	camY = wy;
	minimapNeedsRedraw = true;
	needsRedraw = true;

	if (!animFrame) {
		const ctx = canvas?.getContext("2d");
		if (ctx) {
			animFrame = requestAnimationFrame((ts) => draw(ctx, ts));
		}
	}
}

function handleMinimapMouseUp(): void {
	minimapDragging = false;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function draw(ctx: CanvasRenderingContext2D, now: number): void {
	if (!canvas) return;

	const alpha = (simulation as any)?.alpha?.() ?? 0;
	const simActive = alpha > 0.001;

	// Phase 7: Progressive frame skip — stop RAF when settled and no interaction
	if (!simActive && !needsRedraw) {
		animFrame = 0;
		return;
	}
	needsRedraw = false;

	const heavyGraph = edges.length > 14000 || nodes.length > 2200;
	const settling = alpha > 0 && alpha < 0.05;
	const minFrameMs = heavyGraph ? 33 : settling ? 33 : 16;
	if (now > 0 && now - lastFrameTime < minFrameMs) {
		animFrame = requestAnimationFrame((ts) => draw(ctx, ts));
		return;
	}
	lastFrameTime = now;

	// Phase 7: Coalesced hover — process pending hover once per frame
	if (pendingHover) {
		pendingHover = false;
		const [wx, wy] = screenToWorld(pendingHoverX, pendingHoverY);
		const node = findNodeAt(wx, wy);
		const hoveredId = node?.data.id ?? null;
		if (hoveredId !== lastHoveredId) {
			lastHoveredId = hoveredId;
			onhovernode(node?.data ?? null);
		}
		if (canvas) canvas.style.cursor = node ? "pointer" : "grab";
	}

	const w = canvas.width;
	const h = canvas.height;
	ctx.fillStyle = "#050505";
	ctx.fillRect(0, 0, w, h);
	ctx.save();
	ctx.translate(w / 2, h / 2);
	ctx.scale(camZoom, camZoom);
	ctx.translate(-camX, -camY);

	const selectedId = graphSelected?.id ?? null;

	// Phase 1: Rebuild color cache if invalidated
	if (!colorCache) {
		colorCache = new NodeColorCache(
			nodes, selectedId, embeddingFilterIds, relationLookup,
			pinnedIds, lensIds, clusterLensMode, colorMode, nowMs, sourceFocusSources,
		);
	}

	// --- Draw edges using pre-partitioned arrays (Phase 3) ---
	const edgeBudget = camZoom >= 1.4 ? MAX_EDGES_NEAR : camZoom >= 0.8 ? MAX_EDGES_MID : MAX_EDGES_FAR;

	// Hierarchy edges: single style, batched into one path
	if (hierEdges.length > 0) {
		const hierStep = Math.max(1, Math.ceil(hierEdges.length / edgeBudget));
		ctx.beginPath();
		for (let i = 0; i < hierEdges.length; i += hierStep) {
			const edge = hierEdges[i];
			const s = edge.source as GraphNode;
			const t = edge.target as GraphNode;
			if (typeof s === "number" || typeof t === "number" || !s || !t) continue;
			ctx.moveTo(s.x, s.y);
			ctx.lineTo(t.x, t.y);
		}
		ctx.strokeStyle = "rgba(255, 255, 255, 0.03)";
		ctx.lineWidth = 0.4 / camZoom;
		ctx.stroke();
	}

	// KNN edges: batch by stroke color (Phase 3)
	if (knnEdges.length > 0) {
		const knnStep = Math.max(1, Math.ceil(knnEdges.length / edgeBudget));
		const batches = new Map<string, Array<[number, number, number, number]>>();
		for (let i = 0; i < knnEdges.length; i += knnStep) {
			const edge = knnEdges[i];
			const s = edge.source as GraphNode;
			const t = edge.target as GraphNode;
			if (typeof s === "number" || typeof t === "number" || !s || !t) continue;
			const color = edgeStrokeStyle(s.data.id, t.data.id, embeddingFilterIds, relationLookup, lensIds, clusterLensMode);
			const batch = batches.get(color);
			if (batch) batch.push([s.x, s.y, t.x, t.y]);
			else batches.set(color, [[s.x, s.y, t.x, t.y]]);
		}
		ctx.lineWidth = 0.8 / camZoom;
		for (const [color, segs] of batches) {
			ctx.beginPath();
			for (const [sx, sy, tx, ty] of segs) {
				ctx.moveTo(sx, sy);
				ctx.lineTo(tx, ty);
			}
			ctx.strokeStyle = color;
			ctx.stroke();
		}
	}

	// Dependency edges: styled by type, budgeted
	if (depEdges.length > 0) {
		const depBudget = Math.max(1, Math.floor(edgeBudget / 4));
		const depStep = Math.max(1, Math.ceil(depEdges.length / depBudget));
		for (let i = 0; i < depEdges.length; i += depStep) {
			const edge = depEdges[i];
			const s = edge.source as GraphNode;
			const t = edge.target as GraphNode;
			if (typeof s === "number" || typeof t === "number" || !s || !t) continue;
			const style = dependencyEdgeStyle(edge.dependencyType ?? "", edge.strength ?? 0.5);
			ctx.beginPath();
			if (style.dash.length > 0) {
				ctx.setLineDash(style.dash.map((d) => d / camZoom));
			}
			ctx.moveTo(s.x, s.y);
			ctx.lineTo(t.x, t.y);
			ctx.strokeStyle = style.color;
			ctx.lineWidth = style.width / camZoom;
			ctx.stroke();
			if (style.dash.length > 0) {
				ctx.setLineDash([]);
			}
		}
	}

	// --- Draw nodes in back-to-front order: memory, attribute, aspect, entity ---

	// Memory nodes: batched by fill color (Phase 3)
	{
		const batches = new Map<string, GraphNode[]>();
		const newSeen: GraphNode[] = [];
		const pinned: GraphNode[] = [];
		let selected: GraphNode | null = null;

		for (let i = 0; i < nodes.length; i++) {
			const node = nodes[i];
			if (node.nodeType !== "memory" && node.nodeType !== undefined) continue;
			const fill = colorCache.fills[i];
			const batch = batches.get(fill);
			if (batch) batch.push(node);
			else batches.set(fill, [node]);
			if (colorMode !== "none" && showNewSinceLastSeen && isNewSinceLastSeen(node.data.createdAt, lastSeenMs)) {
				newSeen.push(node);
			}
			if (pinnedIds.has(node.data.id)) pinned.push(node);
			if (selectedId === node.data.id) selected = node;
		}

		for (const [fill, batch] of batches) {
			ctx.beginPath();
			for (const node of batch) {
				ctx.moveTo(node.x + node.radius, node.y);
				ctx.arc(node.x, node.y, node.radius, 0, Math.PI * 2);
			}
			ctx.fillStyle = fill;
			ctx.fill();
		}

		// New-since-last-seen rings
		if (newSeen.length > 0) {
			ctx.beginPath();
			for (const node of newSeen) {
				ctx.moveTo(node.x + node.radius + 2.2, node.y);
				ctx.arc(node.x, node.y, node.radius + 2.2, 0, Math.PI * 2);
			}
			ctx.strokeStyle = "rgba(246, 194, 107, 0.85)";
			ctx.lineWidth = 1.1 / camZoom;
			ctx.stroke();
		}

		// Pinned indicators
		if (pinned.length > 0) {
			ctx.strokeStyle = "rgba(240, 240, 240, 0.8)";
			ctx.lineWidth = 1.2 / camZoom;
			for (const node of pinned) {
				const side = (node.radius + 2.5) * 2;
				ctx.strokeRect(node.x - side / 2, node.y - side / 2, side, side);
			}
		}

		// Selection ring
		if (selected) {
			ctx.beginPath();
			ctx.arc(selected.x, selected.y, selected.radius + 3, 0, Math.PI * 2);
			ctx.strokeStyle = "rgba(255, 255, 255, 0.95)";
			ctx.lineWidth = 1.5 / camZoom;
			ctx.stroke();
		}
	}

	// Attribute nodes (small circles) — use entityFillFast
	for (const node of nodes) {
		if (node.nodeType !== "attribute") continue;
		const who = node.data.who ?? "unknown";
		ctx.beginPath();
		ctx.arc(node.x, node.y, node.radius, 0, Math.PI * 2);
		ctx.fillStyle = entityFillFast(who, 0.3);
		ctx.fill();
		ctx.strokeStyle = entityFillFast(who, 0.5);
		ctx.lineWidth = 0.6 / camZoom;
		ctx.stroke();

		if (selectedId === node.data.id) {
			ctx.beginPath();
			ctx.arc(node.x, node.y, node.radius + 3, 0, Math.PI * 2);
			ctx.strokeStyle = "rgba(255, 255, 255, 0.95)";
			ctx.lineWidth = 1.5 / camZoom;
			ctx.stroke();
		}
	}

	// Aspect nodes (medium circles) — use entityFillFast
	for (const node of nodes) {
		if (node.nodeType !== "aspect") continue;
		const who = node.data.who ?? "unknown";
		ctx.beginPath();
		ctx.arc(node.x, node.y, node.radius, 0, Math.PI * 2);
		ctx.fillStyle = entityFillFast(who, 0.5);
		ctx.fill();
		ctx.strokeStyle = entityFillFast(who, 0.75);
		ctx.lineWidth = 0.8 / camZoom;
		ctx.stroke();

		if (selectedId === node.data.id) {
			ctx.beginPath();
			ctx.arc(node.x, node.y, node.radius + 3, 0, Math.PI * 2);
			ctx.strokeStyle = "rgba(255, 255, 255, 0.95)";
			ctx.lineWidth = 1.5 / camZoom;
			ctx.stroke();
		}

		// Show label on hover/select
		if ((graphHovered && node.data.id === graphHovered.id) ||
			(selectedId === node.data.id)) {
			const fs = Math.max(7, 9 / camZoom);
			ctx.font = `${fs}px var(--font-mono)`;
			ctx.fillStyle = "rgba(210, 210, 210, 0.85)";
			ctx.textAlign = "center";
			ctx.fillText(node.aspectData?.name ?? "", node.x, node.y + node.radius + fs + 1 / camZoom);
			ctx.textAlign = "start";
		}
	}

	// Entity nodes (largest, drawn on top) — use entityFillFast
	for (const node of nodes) {
		if (node.nodeType !== "entity") continue;
		const who = node.entityData?.entityType ?? "unknown";

		// Glow effect
		ctx.save();
		ctx.shadowColor = entityFillFast(who, 0.5);
		ctx.shadowBlur = 12 / camZoom;

		// Hexagonal shape
		hexPath(ctx, node.x, node.y, node.radius);
		ctx.fillStyle = entityFillFast(who, 0.7);
		ctx.fill();
		ctx.restore();

		// Border
		hexPath(ctx, node.x, node.y, node.radius);
		ctx.strokeStyle = entityFillFast(who, 0.9);
		ctx.lineWidth = 1.2 / camZoom;
		ctx.stroke();

		// Selection ring
		if (selectedId === node.data.id) {
			hexPath(ctx, node.x, node.y, node.radius + 4);
			ctx.strokeStyle = "rgba(255, 255, 255, 0.95)";
			ctx.lineWidth = 1.5 / camZoom;
			ctx.stroke();
		}

		// Always-visible name label
		const fs = Math.max(8, 10 / camZoom);
		ctx.font = `bold ${fs}px var(--font-mono)`;
		ctx.fillStyle = "rgba(230, 230, 230, 0.9)";
		ctx.textAlign = "center";
		ctx.fillText(node.entityData?.name ?? "", node.x, node.y + node.radius + fs + 2 / camZoom);
		ctx.textAlign = "start";
	}

	// --- Hover label (Phase 4: O(1) lookup) ---
	if (graphHovered) {
		const node = nodeById.get(graphHovered.id);
		if (node && node.nodeType !== "entity" && node.nodeType !== "aspect") {
			const text = node.nodeType === "attribute"
				? (node.attributeData?.content ?? embeddingLabel(graphHovered))
				: embeddingLabel(graphHovered);
			const fs = 9 / camZoom;
			ctx.font = `${fs}px var(--font-mono)`;
			ctx.fillStyle = "rgba(220, 220, 220, 0.9)";
			ctx.textAlign = "left";
			const maxLen = 80;
			ctx.fillText(
				text.length > maxLen ? `${text.slice(0, maxLen)}...` : text,
				node.x + node.radius + 5 / camZoom,
				node.y + fs * 0.35,
			);
			ctx.textAlign = "start";
		}
	}

	ctx.restore();

	// Draw minimap (throttled)
	if (showMinimap) {
		minimapFrameCount++;
		if (minimapNeedsRedraw || minimapFrameCount >= MINIMAP_FRAME_SKIP) {
			drawMinimap();
			minimapNeedsRedraw = false;
			minimapFrameCount = 0;
		}
	}

	animFrame = requestAnimationFrame((ts) => draw(ctx, ts));
}

export { requestRedraw };

// ---------------------------------------------------------------------------
// Pointer interactions
// ---------------------------------------------------------------------------

function setupInteractions(): void {
	if (!canvas) return;
	if (interactionCleanup) {
		interactionCleanup();
		interactionCleanup = null;
	}

	const target = canvas;

	const onPointerDown = (event: PointerEvent) => {
		const [wx, wy] = screenToWorld(event.clientX, event.clientY);
		const node = findNodeAt(wx, wy);
		didDrag = false;
		if (node) {
			isDragging = true;
			dragNode = node;
			panStartX = event.clientX;
			panStartY = event.clientY;
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
			const dx = event.clientX - panStartX;
			const dy = event.clientY - panStartY;
			if (!didDrag && dx * dx + dy * dy < DRAG_THRESHOLD * DRAG_THRESHOLD) {
				return;
			}
			if (!didDrag) {
				didDrag = true;
				userAdjustedCamera = true;
				dragNode.fx = dragNode.x;
				dragNode.fy = dragNode.y;
				(simulation as any)?.alphaTarget(0.3).restart();
			}
			const [wx, wy] = screenToWorld(event.clientX, event.clientY);
			dragNode.fx = wx;
			dragNode.fy = wy;
			requestRedraw();
			return;
		}
		if (isPanning) {
			userAdjustedCamera = true;
			camX = panCamStartX - (event.clientX - panStartX) / camZoom;
			camY = panCamStartY - (event.clientY - panStartY) / camZoom;
			requestRedraw();
			return;
		}
		// Phase 7: Coalesce hover into RAF — store coords, process in draw()
		pendingHoverX = event.clientX;
		pendingHoverY = event.clientY;
		pendingHover = true;
		requestRedraw();
	};

	const onPointerUp = () => {
		if (isDragging && dragNode) {
			if (didDrag) {
				dragNode.fx = null;
				dragNode.fy = null;
				(simulation as any)?.alphaTarget(0);
			}
			dragNode = null;
			isDragging = false;
			requestRedraw();
			return;
		}
		isPanning = false;
	};

	const onPointerLeave = () => {
		isPanning = false;
		if (lastHoveredId !== null) {
			lastHoveredId = null;
			onhovernode(null);
		}
	};

	const onClick = (event: MouseEvent) => {
		if (didDrag) return;
		const [wx, wy] = screenToWorld(event.clientX, event.clientY);
		const node = findNodeAt(wx, wy);
		onselectnode(node?.data ?? null);
	};

	const onWheel = (event: WheelEvent) => {
		event.preventDefault();
		userAdjustedCamera = true;
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
		requestRedraw();
	};

	target.addEventListener("pointerdown", onPointerDown);
	target.addEventListener("pointermove", onPointerMove);
	target.addEventListener("pointerup", onPointerUp);
	target.addEventListener("pointerleave", onPointerLeave);
	target.addEventListener("click", onClick);
	target.addEventListener("wheel", onWheel, { passive: false });

	interactionCleanup = () => {
		target.removeEventListener("pointerdown", onPointerDown);
		target.removeEventListener("pointermove", onPointerMove);
		target.removeEventListener("pointerup", onPointerUp);
		target.removeEventListener("pointerleave", onPointerLeave);
		target.removeEventListener("click", onClick);
		target.removeEventListener("wheel", onWheel);
	};
}

// Invalidate color cache and redraw when visual props change
$effect(() => {
	graphSelected;
	graphHovered;
	embeddingFilterIds;
	relationLookup;
	pinnedIds;
	lensIds;
	clusterLensMode;
	colorCache = null;
	requestRedraw();
});

// Phase 3: Pre-partition edges by type when edges change
$effect(() => {
	const all = edges;
	const hier: GraphEdge[] = [];
	const knn: GraphEdge[] = [];
	const dep: GraphEdge[] = [];
	for (const edge of all) {
		if (edge.edgeType === "hierarchy") hier.push(edge);
		else if (edge.edgeType === "dependency") dep.push(edge);
		else knn.push(edge);
	}
	hierEdges = hier;
	knnEdges = knn;
	depEdges = dep;
});

// Cleanup on unmount
$effect(() => {
	return () => {
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
	};
});
</script>

<div class="canvas-wrapper">
	<canvas bind:this={canvas} class="main-canvas"></canvas>
	{#if showMinimap}
		<canvas
			bind:this={minimapEl}
			width={MINIMAP_WIDTH}
			height={MINIMAP_HEIGHT}
			class="minimap"
			aria-label="Graph navigation minimap"
			onmousedown={handleMinimapMouseDown}
			onmousemove={handleMinimapMouseMove}
			onmouseup={handleMinimapMouseUp}
			onmouseleave={handleMinimapMouseUp}
		></canvas>
	{/if}
</div>

<style>
	.canvas-wrapper {
		position: relative;
		width: 100%;
		height: 100%;
	}

	.main-canvas {
		position: absolute;
		inset: 0;
		width: 100%;
		height: 100%;
		cursor: grab;
	}

	.minimap {
		position: absolute;
		bottom: 12px;
		right: 12px;
		width: 160px;
		height: 120px;
		border: 1px solid rgba(255, 255, 255, 0.12);
		cursor: crosshair;
		z-index: 10;
	}
</style>

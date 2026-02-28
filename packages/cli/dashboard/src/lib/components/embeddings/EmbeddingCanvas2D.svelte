<script lang="ts">
import { tick } from "svelte";
import {
	forceSimulation,
	forceLink,
	forceManyBody,
	forceCenter,
	forceCollide,
} from "d3-force";
import type { EmbeddingPoint } from "../../api";
import {
	type GraphNode,
	type GraphEdge,
	type RelationKind,
	nodeFillStyle,
	edgeStrokeStyle,
	embeddingLabel,
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
	onselectnode: (embedding: EmbeddingPoint | null) => void;
	onhovernode: (embedding: EmbeddingPoint | null) => void;
}

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
	onselectnode,
	onhovernode,
}: Props = $props();

let canvas = $state<HTMLCanvasElement | null>(null);

// Camera state (internal)
let camX = 0;
let camY = 0;
let camZoom = 1;

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

function requestRedraw(): void {
	needsRedraw = true;
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
	camZoom = 1;
}

export function focusNode(id: string): void {
	const node = nodes.find((entry) => entry.data.id === id);
	if (!node) return;
	camX = node.x;
	camY = node.y;
	camZoom = Math.max(camZoom, 1.6);
}

export function startSimulation(
	graphNodes: GraphNode[],
	graphEdges: GraphEdge[],
): void {
	simulation?.stop();
	simulation = forceSimulation(graphNodes as any)
		.force("link", forceLink(graphEdges).distance(58).strength(0.28))
		.force("charge", forceManyBody().strength(-72))
		.force("center", forceCenter(0, 0))
		.force(
			"collide",
			forceCollide().radius((entry: any) => entry.radius + 2),
		)
		.alphaDecay(0.03)
		.on("tick", requestRedraw);
}

export function stopSimulation(): void {
	simulation?.stop();
	simulation = null;
}

export function startRendering(): void {
	resizeCanvas();
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
	requestRedraw();
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

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function draw(ctx: CanvasRenderingContext2D, now: number): void {
	if (!canvas) return;

	const simActive = (simulation as any)?.alpha?.() > 0.001;
	if (!simActive && !needsRedraw) {
		animFrame = 0;
		return;
	}
	needsRedraw = false;

	const heavyGraph = edges.length > 14000 || nodes.length > 2200;
	const minFrameMs = heavyGraph ? 33 : 16;
	if (now > 0 && now - lastFrameTime < minFrameMs) {
		animFrame = requestAnimationFrame((ts) => draw(ctx, ts));
		return;
	}
	lastFrameTime = now;

	const w = canvas.width;
	const h = canvas.height;
	ctx.fillStyle = "#050505";
	ctx.fillRect(0, 0, w, h);
	ctx.save();
	ctx.translate(w / 2, h / 2);
	ctx.scale(camZoom, camZoom);
	ctx.translate(-camX, -camY);

	const selectedId = graphSelected?.id ?? null;

	const edgeBudget =
		camZoom >= 1.4
			? MAX_EDGES_NEAR
			: camZoom >= 0.8
				? MAX_EDGES_MID
				: MAX_EDGES_FAR;
	const edgeStep = Math.max(1, Math.ceil(edges.length / edgeBudget));
	for (let i = 0; i < edges.length; i += edgeStep) {
		const edge = edges[i];
		const s = edge.source as GraphNode;
		const t = edge.target as GraphNode;
		ctx.beginPath();
		ctx.moveTo(s.x, s.y);
		ctx.lineTo(t.x, t.y);
		ctx.strokeStyle = edgeStrokeStyle(
			s.data.id,
			t.data.id,
			embeddingFilterIds,
			relationLookup,
			lensIds,
			clusterLensMode,
		);
		ctx.lineWidth = 0.8 / camZoom;
		ctx.stroke();
	}

	for (const node of nodes) {
		ctx.beginPath();
		ctx.arc(node.x, node.y, node.radius, 0, Math.PI * 2);
		ctx.fillStyle = nodeFillStyle(
			node,
			selectedId,
			embeddingFilterIds,
			relationLookup,
			pinnedIds,
			lensIds,
			clusterLensMode,
		);
		ctx.fill();

		if (pinnedIds.has(node.data.id)) {
			const side = (node.radius + 2.5) * 2;
			ctx.strokeStyle = "rgba(240, 240, 240, 0.8)";
			ctx.lineWidth = 1.2 / camZoom;
			ctx.strokeRect(node.x - side / 2, node.y - side / 2, side, side);
		}

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
			ctx.fillText(
				text,
				node.x + node.radius + 5 / camZoom,
				node.y + fs * 0.35,
			);
			ctx.textAlign = "start";
		}
	}

	ctx.restore();

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
			camX = panCamStartX - (event.clientX - panStartX) / camZoom;
			camY = panCamStartY - (event.clientY - panStartY) / camZoom;
			requestRedraw();
			return;
		}
		const [wx, wy] = screenToWorld(event.clientX, event.clientY);
		const node = findNodeAt(wx, wy);
		const hoveredId = node?.data.id ?? null;
		if (hoveredId !== lastHoveredId) {
			lastHoveredId = hoveredId;
			onhovernode(node?.data ?? null);
		}
		target.style.cursor = node ? "pointer" : "grab";
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

// Redraw when visual props change (filters, selection, hover, etc.)
$effect(() => {
	graphSelected;
	graphHovered;
	embeddingFilterIds;
	relationLookup;
	pinnedIds;
	lensIds;
	clusterLensMode;
	requestRedraw();
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

<canvas bind:this={canvas} class="canvas"></canvas>

<style>
	.canvas {
		width: 100%;
		height: 100%;
		cursor: grab;
	}
</style>

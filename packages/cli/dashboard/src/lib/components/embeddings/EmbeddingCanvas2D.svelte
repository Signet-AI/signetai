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
	hexToRgb,
	sourceColors,
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
let dragNode: GraphNode | null = null;
let panStartX = 0;
let panStartY = 0;
let panCamStartX = 0;
let panCamStartY = 0;

let simulation: ReturnType<typeof forceSimulation> | null = null;
let animFrame = 0;
let interactionCleanup: (() => void) | null = null;
let resizeListenerAttached = false;
let lastFrameTime = 0;

// Fix 2: idle rAF loop
let needsRedraw = true;

// Fix 3: dedup hover calls
let lastHoveredId: string | null = null;

// Fix 7: spatial index
const GRID_CELL = 30;
let gridCells = new Map<string, number[]>();
let gridDirty = true;

const MAX_EDGES_NEAR = 12000;
const MAX_EDGES_MID = 8000;
const MAX_EDGES_FAR = 5000;

// ---------------------------------------------------------------------------
// Fix 7: spatial index helpers
// ---------------------------------------------------------------------------

function rebuildGrid(): void {
	gridCells.clear();
	for (let i = 0; i < nodes.length; i++) {
		const n = nodes[i];
		const key = `${Math.floor(n.x / GRID_CELL)},${Math.floor(n.y / GRID_CELL)}`;
		const cell = gridCells.get(key);
		if (cell) {
			cell.push(i);
		} else {
			gridCells.set(key, [i]);
		}
	}
	gridDirty = false;
}

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

// Fix 2: requestRedraw exported so parent can trigger redraws if needed
export function requestRedraw(): void {
	needsRedraw = true;
	if (animFrame === 0) {
		const ctx = canvas?.getContext("2d");
		if (ctx) {
			animFrame = requestAnimationFrame((ts) => draw(ctx, ts));
		}
	}
}

export function startSimulation(
	graphNodes: GraphNode[],
	graphEdges: GraphEdge[],
): void {
	simulation?.stop();
	gridDirty = true;
	simulation = forceSimulation(graphNodes as any)
		.force("link", forceLink(graphEdges).distance(58).strength(0.28))
		.force("charge", forceManyBody().strength(-72))
		.force("center", forceCenter(0, 0))
		.force(
			"collide",
			forceCollide().radius((entry: any) => entry.radius + 2),
		)
		.alphaDecay(0.03)
		.on("tick", () => {
			// Fix 7: rebuild spatial index on tick so findNodeAt stays accurate
			gridDirty = true;
			requestRedraw();
		});
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
	const ctx = canvas?.getContext("2d");
	if (ctx) {
		cancelAnimationFrame(animFrame);
		animFrame = 0;
		needsRedraw = true;
		requestRedraw();
	}
}

export function resumeRendering(): void {
	const ctx = canvas?.getContext("2d");
	if (ctx) {
		cancelAnimationFrame(animFrame);
		animFrame = 0;
		needsRedraw = true;
		requestRedraw();
	}
}

export function stopRendering(): void {
	cancelAnimationFrame(animFrame);
	animFrame = 0;
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

// Fix 7: grid-based spatial lookup for O(1) average hit testing
function findNodeAt(wx: number, wy: number): GraphNode | null {
	if (gridDirty) rebuildGrid();

	const cx = Math.floor(wx / GRID_CELL);
	const cy = Math.floor(wy / GRID_CELL);
	let best: GraphNode | null = null;
	let bestI = -1;

	for (let dx = -1; dx <= 1; dx++) {
		for (let dy = -1; dy <= 1; dy++) {
			const key = `${cx + dx},${cy + dy}`;
			const cell = gridCells.get(key);
			if (!cell) continue;
			for (const i of cell) {
				const n = nodes[i];
				const ddx = n.x - wx;
				const ddy = n.y - wy;
				const hitR = n.radius + 4;
				if (ddx * ddx + ddy * ddy <= hitR * hitR) {
					// Prefer the node with the highest index (drawn on top)
					if (i > bestI) {
						bestI = i;
						best = n;
					}
				}
			}
		}
	}
	return best;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function draw(ctx: CanvasRenderingContext2D, now: number): void {
	animFrame = 0;
	if (!canvas) return;

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

	// Fix 2: batch edges by stroke style to reduce canvas state switches
	const edgeBuckets = new Map<string, Array<[GraphNode, GraphNode]>>();
	const lineW = 0.8 / camZoom;
	for (let i = 0; i < edges.length; i += edgeStep) {
		const edge = edges[i];
		const s = edge.source as GraphNode;
		const t = edge.target as GraphNode;
		const style = edgeStrokeStyle(
			s.data.id,
			t.data.id,
			embeddingFilterIds,
			relationLookup,
			lensIds,
			clusterLensMode,
		);
		const bucket = edgeBuckets.get(style);
		if (bucket) {
			bucket.push([s, t]);
		} else {
			edgeBuckets.set(style, [[s, t]]);
		}
	}
	ctx.lineWidth = lineW;
	for (const [style, pairs] of edgeBuckets) {
		ctx.beginPath();
		ctx.strokeStyle = style;
		for (const [s, t] of pairs) {
			ctx.moveTo(s.x, s.y);
			ctx.lineTo(t.x, t.y);
		}
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
			ctx.strokeRect(
				node.x - side / 2,
				node.y - side / 2,
				side,
				side,
			);
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
		const node = nodes.find(
			(entry) => entry.data.id === graphHovered?.id,
		);
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

	// Legend
	const legendSources = [
		"claude-code",
		"clawdbot",
		"openclaw",
		"opencode",
		"manual",
	];
	const lx = 12;
	let ly = h - 12 - legendSources.length * 16;
	ctx.font = "10px var(--font-mono)";
	for (const name of legendSources) {
		const [r, g, b] = hexToRgb(
			sourceColors[name] ?? sourceColors["unknown"],
		);
		ctx.beginPath();
		ctx.arc(lx + 3, ly, 3, 0, Math.PI * 2);
		ctx.fillStyle = `rgba(${r}, ${g}, ${b}, 0.8)`;
		ctx.fill();
		ctx.fillStyle = "rgba(200, 200, 200, 0.4)";
		ctx.fillText(name, lx + 12, ly + 3);
		ly += 16;
	}

	// Fix 2: only schedule next frame if simulation is still warm or a redraw is pending
	needsRedraw = false;
	const simAlpha = (simulation as any)?.alpha?.() ?? 0;
	if (simAlpha > 0.001 || needsRedraw) {
		animFrame = requestAnimationFrame((ts) => draw(ctx, ts));
	}
}

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
		if (node) {
			isDragging = true;
			dragNode = node;
			node.fx = node.x;
			node.fy = node.y;
			(simulation as any)?.alphaTarget(0.3).restart();
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
			requestRedraw();
			return;
		}
		if (isPanning) {
			camX =
				panCamStartX - (event.clientX - panStartX) / camZoom;
			camY =
				panCamStartY - (event.clientY - panStartY) / camZoom;
			requestRedraw();
			return;
		}
		const [wx, wy] = screenToWorld(event.clientX, event.clientY);
		const node = findNodeAt(wx, wy);

		// Fix 3: only fire onhovernode when the hovered node actually changes
		const nextId = node?.data.id ?? null;
		if (nextId !== lastHoveredId) {
			lastHoveredId = nextId;
			onhovernode(node?.data ?? null);
		}

		target.style.cursor = node ? "pointer" : "grab";
	};

	const onPointerUp = () => {
		if (isDragging && dragNode) {
			dragNode.fx = null;
			dragNode.fy = null;
			(simulation as any)?.alphaTarget(0);
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

	const onPointerLeave = () => {
		onPointerUp();
		// Reset hover dedup cache so re-entering fires onhovernode correctly
		lastHoveredId = null;
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
		animFrame = 0;
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

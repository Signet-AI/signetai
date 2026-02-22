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
		.on("tick", () => {});
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
		draw(ctx);
	}
}

export function resumeRendering(): void {
	const ctx = canvas?.getContext("2d");
	if (ctx) {
		cancelAnimationFrame(animFrame);
		draw(ctx);
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

function draw(ctx: CanvasRenderingContext2D): void {
	if (!canvas) return;
	const w = canvas.width;
	const h = canvas.height;
	ctx.fillStyle = "#050505";
	ctx.fillRect(0, 0, w, h);
	ctx.save();
	ctx.translate(w / 2, h / 2);
	ctx.scale(camZoom, camZoom);
	ctx.translate(-camX, -camY);

	const selectedId = graphSelected?.id ?? null;

	for (const edge of edges) {
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
		);
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

	animFrame = requestAnimationFrame(() => draw(ctx));
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
			return;
		}
		if (isPanning) {
			camX =
				panCamStartX - (event.clientX - panStartX) / camZoom;
			camY =
				panCamStartY - (event.clientY - panStartY) / camZoom;
			return;
		}
		const [wx, wy] = screenToWorld(event.clientX, event.clientY);
		const node = findNodeAt(wx, wy);
		onhovernode(node?.data ?? null);
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

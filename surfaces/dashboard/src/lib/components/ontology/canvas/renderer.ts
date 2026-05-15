import type { GraphCanvasEdge, GraphCanvasNode, GraphRenderColors, GraphRenderState } from "./types";
import type { ViewportState } from "./viewport";

interface PreparedEdge {
	startX: number;
	startY: number;
	endX: number;
	endY: number;
	color: string;
	alpha: number;
	width: number;
	dashed: boolean;
	connected: boolean;
}

const edgeBatches = new Map<string, PreparedEdge[]>();

export function renderFrame(
	ctx: CanvasRenderingContext2D,
	nodes: GraphCanvasNode[],
	edges: GraphCanvasEdge[],
	viewport: ViewportState,
	width: number,
	height: number,
	state: GraphRenderState,
	nodeMap: Map<string, GraphCanvasNode>,
	colors: GraphRenderColors,
): void {
	ctx.clearRect(0, 0, width, height);
	drawEdges(ctx, edges, viewport, width, height, state, nodeMap, colors);
	drawNodes(ctx, nodes, viewport, width, height, state, colors);
}

function drawEdges(
	ctx: CanvasRenderingContext2D,
	edges: GraphCanvasEdge[],
	viewport: ViewportState,
	width: number,
	height: number,
	state: GraphRenderState,
	nodeMap: Map<string, GraphCanvasNode>,
	colors: GraphRenderColors,
): void {
	const margin = 120;
	const hasSelection = state.selectedId !== null && state.dimProgress > 0;
	edgeBatches.clear();
	for (const edge of edges) {
		const source = nodeMap.get(edge.sourceId);
		const target = nodeMap.get(edge.targetId);
		if (!source || !target) continue;
		const s = viewport.worldToScreen(source.x, source.y);
		const t = viewport.worldToScreen(target.x, target.y);
		if (
			(s.x < -margin && t.x < -margin) ||
			(s.x > width + margin && t.x > width + margin) ||
			(s.y < -margin && t.y < -margin) ||
			(s.y > height + margin && t.y > height + margin)
		)
			continue;
		if (edge.kind === "mentions" && viewport.zoom < 0.35) continue;
		const dx = t.x - s.x;
		const dy = t.y - s.y;
		const dist = Math.hypot(dx, dy);
		if (dist < 1) continue;
		const ux = dx / dist;
		const uy = dy / dist;
		const sourceRadius = (source.size * viewport.zoom) / 2;
		const targetRadius = (target.size * viewport.zoom) / 2;
		const style = colors.edges[edge.kind];
		const connected =
			!hasSelection ||
			source.id === state.selectedId ||
			target.id === state.selectedId ||
			state.relatedIds.has(source.id) ||
			state.relatedIds.has(target.id);
		const prepared: PreparedEdge = {
			startX: s.x + ux * sourceRadius,
			startY: s.y + uy * sourceRadius,
			endX: t.x - ux * targetRadius,
			endY: t.y - uy * targetRadius,
			color: style.color,
			alpha: connected ? style.alpha : style.alpha * (1 - state.dimProgress * 0.9),
			width: style.width,
			dashed: edge.dashed ?? false,
			connected,
		};
		const key = `${prepared.color}|${prepared.alpha.toFixed(3)}|${prepared.width}|${prepared.dashed}`;
		const bucket = edgeBatches.get(key) ?? [];
		bucket.push(prepared);
		edgeBatches.set(key, bucket);
	}
	ctx.save();
	for (const [key, batch] of edgeBatches) {
		const first = batch[0];
		if (!first) continue;
		ctx.globalAlpha = first.alpha;
		ctx.strokeStyle = first.color;
		ctx.lineWidth = first.width;
		ctx.setLineDash(first.dashed ? [5, 4] : []);
		ctx.beginPath();
		for (const edge of batch) {
			ctx.moveTo(edge.startX, edge.startY);
			ctx.lineTo(edge.endX, edge.endY);
		}
		ctx.stroke();
		if (!key.endsWith("true")) continue;
	}
	ctx.restore();
}

function drawNodes(
	ctx: CanvasRenderingContext2D,
	nodes: GraphCanvasNode[],
	viewport: ViewportState,
	width: number,
	height: number,
	state: GraphRenderState,
	colors: GraphRenderColors,
): void {
	const margin = 80;
	for (const node of nodes) {
		const screen = viewport.worldToScreen(node.x, node.y);
		const size = node.size * viewport.zoom;
		const cullSize = Math.max(size, 3);
		if (
			screen.x + cullSize < -margin ||
			screen.x - cullSize > width + margin ||
			screen.y + cullSize < -margin ||
			screen.y - cullSize > height + margin
		)
			continue;
		const selected = node.id === state.selectedId;
		const hovered = node.id === state.hoveredId;
		const related = state.relatedIds.has(node.id);
		const matched = state.searchMatchIds?.has(node.id) ?? false;
		const dimmed = state.selectedId !== null && !selected && !related;
		const alpha = dimmed ? Math.max(0.12, 1 - state.dimProgress * 0.85) : 1;
		ctx.save();
		ctx.globalAlpha = alpha;
		if (selected || hovered || related || matched)
			drawGlow(
				ctx,
				screen.x,
				screen.y,
				size,
				selected ? colors.selectionGlow : matched ? "rgba(125, 211, 252, 0.2)" : colors.relatedGlow[node.kind],
			);
		if (size < 6 && !selected && !hovered) {
			drawTinyNode(ctx, screen.x, screen.y, Math.max(1.5, size * 0.35), dimmed ? node.dimColor : node.color);
			ctx.restore();
			continue;
		}
		drawNodeShape(
			ctx,
			screen.x,
			screen.y,
			size,
			selected ? colors.selection : dimmed ? node.dimColor : node.color,
			selected || related ? colors.selection : node.color,
			node.shape ?? "circle",
		);
		if (shouldDrawLabel(node, viewport.zoom, selected, hovered, related || matched, size))
			drawLabel(
				ctx,
				node.label,
				screen.x,
				screen.y + size * 0.5 + 4,
				selected ? colors.selection : related || matched ? node.color : dimmed ? colors.textDim : colors.text,
				colors.labelShadow,
				node.kind === "memory" ? 8 : 10,
				viewport.zoom,
			);
		ctx.restore();
	}
}

function drawTinyNode(ctx: CanvasRenderingContext2D, x: number, y: number, radius: number, color: string): void {
	ctx.fillStyle = color;
	ctx.beginPath();
	ctx.arc(x, y, radius, 0, Math.PI * 2);
	ctx.fill();
}

function drawGlow(ctx: CanvasRenderingContext2D, x: number, y: number, size: number, color: string): void {
	ctx.fillStyle = color;
	ctx.beginPath();
	ctx.arc(x, y, Math.max(size * 0.58, 7), 0, Math.PI * 2);
	ctx.fill();
}

function drawNodeShape(
	ctx: CanvasRenderingContext2D,
	x: number,
	y: number,
	size: number,
	fill: string,
	stroke: string,
	shape: string,
): void {
	const radius = Math.max(size * 0.5, 2);
	ctx.fillStyle = fill;
	ctx.strokeStyle = stroke;
	ctx.lineWidth = shape === "hex" ? 1.4 : 1;
	ctx.beginPath();
	if (shape === "hex") {
		for (let i = 0; i < 6; i++) {
			const angle = Math.PI / 6 + (Math.PI * 2 * i) / 6;
			const px = x + Math.cos(angle) * radius;
			const py = y + Math.sin(angle) * radius;
			if (i === 0) ctx.moveTo(px, py);
			else ctx.lineTo(px, py);
		}
		ctx.closePath();
	} else if (shape === "rect") {
		ctx.rect(x - radius, y - radius, radius * 2, radius * 2);
	} else {
		ctx.arc(x, y, radius, 0, Math.PI * 2);
	}
	ctx.fill();
	ctx.stroke();
}

function shouldDrawLabel(
	node: GraphCanvasNode,
	zoom: number,
	selected: boolean,
	hovered: boolean,
	related: boolean,
	size: number,
): boolean {
	if (selected || hovered) return true;
	if (node.kind === "memory" && !related) return false;
	return zoom > 0.58 && size > 3;
}

function drawLabel(
	ctx: CanvasRenderingContext2D,
	text: string,
	x: number,
	y: number,
	color: string,
	shadow: string,
	baseSize: number,
	zoom: number,
): void {
	const label = text.length > 28 ? `${text.slice(0, 28)}...` : text;
	const size = Math.max(7, baseSize * Math.min(zoom, 1.4));
	ctx.font = `${size}px var(--font-mono), monospace`;
	ctx.textAlign = "center";
	ctx.textBaseline = "top";
	ctx.fillStyle = shadow;
	ctx.fillText(label, x + 1, y + 1);
	ctx.fillStyle = color;
	ctx.fillText(label, x, y);
}

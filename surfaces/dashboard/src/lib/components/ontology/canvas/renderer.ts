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
	emphasized: boolean;
}

const edgeBatches = new Map<string, PreparedEdge[]>();
type NodeTone = "selected" | "related" | "dim" | "normal";
const NODE_SPRITES = {
	entity: "/constellation-assets/entity-icon.png",
	aspect: "/constellation-assets/aspect-icon.png",
	attribute: "/constellation-assets/attribute-icon.png",
	memory: "/constellation-assets/attribute-icon.png",
} satisfies Partial<Record<GraphCanvasNode["kind"], string>>;
const spriteCache = new Map<string, HTMLImageElement | null>();

export interface EdgeLineEndpoints {
	startX: number;
	startY: number;
	endX: number;
	endY: number;
}

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
	drawSystemFields(ctx, nodes, viewport, width, height, state);
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
		const endpoints = edgeLineEndpoints(edge, viewport, nodeMap);
		if (!endpoints) continue;
		if (
			(endpoints.startX < -margin && endpoints.endX < -margin) ||
			(endpoints.startX > width + margin && endpoints.endX > width + margin) ||
			(endpoints.startY < -margin && endpoints.endY < -margin) ||
			(endpoints.startY > height + margin && endpoints.endY > height + margin)
		)
			continue;
		const style = colors.edges[edge.kind] ?? colors.edges.about;
		const emphasized = isEdgeEmphasizedForState(edge, state);
		if (!isEdgeVisibleAtLod(edge, viewport.zoom, emphasized)) continue;
		const connected = !hasSelection || emphasized;
		const prepared: PreparedEdge = {
			...endpoints,
			color: style.color,
			alpha:
				(connected
					? Math.min(style.alpha * (emphasized ? 1.25 : 1), 0.85)
					: style.alpha * (1 - state.dimProgress * 0.92)) * edgeLodAlpha(edge, viewport.zoom, emphasized),
			width: style.width * edgeLodWidth(edge, viewport.zoom, emphasized) * (emphasized ? 1.1 : 1),
			dashed: edge.dashed ?? false,
			connected,
			emphasized,
		};
		const key = `${prepared.color}|${prepared.alpha.toFixed(3)}|${prepared.width}|${prepared.dashed}`;
		const bucket = edgeBatches.get(key) ?? [];
		bucket.push(prepared);
		edgeBatches.set(key, bucket);
	}
	ctx.save();
	for (const batch of edgeBatches.values()) {
		const first = batch[0];
		if (!first) continue;
		strokeEdgeBatch(ctx, batch, first);
	}
	ctx.restore();
}

export function isEdgeEmphasizedForState(edge: GraphCanvasEdge, state: GraphRenderState): boolean {
	const activeId = state.selectedId ?? state.hoveredId;
	if (!activeId) return false;
	if (edge.visualOnly || edge.kind === "about") return false;
	const sourceFocused = edge.sourceId === activeId || state.relatedIds.has(edge.sourceId);
	const targetFocused = edge.targetId === activeId || state.relatedIds.has(edge.targetId);
	return sourceFocused && targetFocused;
}

function strokeEdgeBatch(ctx: CanvasRenderingContext2D, batch: PreparedEdge[], style: PreparedEdge): void {
	const hasGlow = batch.some((e) => e.emphasized);
	if (hasGlow) {
		ctx.save();
		ctx.globalAlpha = style.alpha * 0.18;
		ctx.strokeStyle = style.color;
		ctx.lineWidth = style.width * 2.5;
		ctx.lineCap = "round";
		ctx.setLineDash(style.dashed ? [7, 7] : []);
		ctx.beginPath();
		for (const edge of batch) {
			if (!edge.emphasized) continue;
			ctx.moveTo(edge.startX, edge.startY);
			ctx.lineTo(edge.endX, edge.endY);
		}
		ctx.stroke();
		ctx.restore();
	}
	ctx.globalAlpha = style.alpha;
	ctx.strokeStyle = style.color;
	ctx.lineWidth = style.width;
	ctx.lineCap = "round";
	ctx.setLineDash(style.dashed ? [7, 7] : []);
	ctx.beginPath();
	for (const edge of batch) {
		ctx.moveTo(edge.startX, edge.startY);
		ctx.lineTo(edge.endX, edge.endY);
	}
	ctx.stroke();
}

export function edgeLineEndpoints(
	edge: GraphCanvasEdge,
	viewport: ViewportState,
	nodeMap: Map<string, GraphCanvasNode>,
): EdgeLineEndpoints | null {
	const source = nodeMap.get(edge.sourceId);
	const target = nodeMap.get(edge.targetId);
	if (!source || !target) return null;
	const start = viewport.worldToScreen(source.x, source.y);
	const end = viewport.worldToScreen(target.x, target.y);
	if (Math.hypot(end.x - start.x, end.y - start.y) < 1) return null;
	return {
		startX: start.x,
		startY: start.y,
		endX: end.x,
		endY: end.y,
	};
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
		const visualSize = size * (node.iconScale ?? 1);
		const cullSize = Math.max(visualSize, 3);
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
		if (!isNodeVisibleAtLod(node, viewport.zoom, selected || hovered || related || matched)) continue;
		const dimmed = state.selectedId !== null && !selected && !related;
		const tone: NodeTone =
			selected || hovered || matched ? "selected" : related ? "related" : dimmed ? "dim" : "normal";
		const dimFloor = node.kind === "attribute" || node.kind === "aspect" ? 0.34 : 0.12;
		const alpha =
			(tone === "dim" ? Math.max(dimFloor, 1 - state.dimProgress * 0.88) : tone === "related" ? 1 : 1) *
			nodeLodAlpha(node, viewport.zoom, selected || hovered || related || matched);
		ctx.save();
		ctx.globalAlpha = alpha;
		if (visualSize < 6 && !selected && !hovered) {
			drawTinyNode(
				ctx,
				screen.x,
				screen.y,
				Math.max(2.2, visualSize * 0.45),
				tone === "dim" ? node.dimColor : node.color,
				node.kind,
				tone,
			);
			ctx.restore();
			continue;
		}

		// Subtle ambient glow for visible entity nodes at all sizes
		if (node.kind === "entity" && !dimmed && !selected && !related) {
			const ambientGlow = ctx.createRadialGradient(
				screen.x,
				screen.y,
				visualSize * 0.6,
				screen.x,
				screen.y,
				visualSize * 2.2,
			);
			ambientGlow.addColorStop(0, `${node.color}20`);
			ambientGlow.addColorStop(1, "rgba(0,0,0,0)");
			ctx.fillStyle = ambientGlow;
			ctx.beginPath();
			ctx.arc(screen.x, screen.y, visualSize * 2.2, 0, Math.PI * 2);
			ctx.fill();
		}

		drawNodeShape(
			ctx,
			screen.x,
			screen.y,
			visualSize,
			selected ? colors.selection : dimmed ? node.dimColor : node.color,
			selected || related ? colors.selection : node.color,
			node.shape ?? "circle",
			node.kind,
			node.sprite,
			tone,
		);
		const suppressDimAttributeLabel = dimmed && node.kind === "attribute" && !hovered && !matched;
		if (!suppressDimAttributeLabel && shouldDrawLabel(node, viewport.zoom, selected, hovered, related || matched, size))
			drawLabel(
				ctx,
				node.label,
				screen.x,
				screen.y + visualSize * 0.5 + 4,
				selected ? colors.selection : related || matched ? node.color : dimmed ? colors.textDim : colors.text,
				colors.labelShadow,
				node.kind === "memory" ? 8 : 10,
				viewport.zoom,
			);
		ctx.restore();
	}
}

function drawSystemFields(
	ctx: CanvasRenderingContext2D,
	nodes: GraphCanvasNode[],
	viewport: ViewportState,
	width: number,
	height: number,
	state: GraphRenderState,
): void {
	if (state.selectedId !== null) return;
	const margin = 180;
	ctx.save();
	for (const node of nodes) {
		if (node.kind !== "entity") continue;
		const aspects = Math.max(0, Math.floor(node.counts?.aspects ?? 0));
		const attributes = Math.max(0, Math.floor(node.counts?.attributes ?? 0));
		if (aspects === 0 && attributes === 0) continue;
		const screen = viewport.worldToScreen(node.x, node.y);
		const radius = Math.max(28, Math.min(92, ((node.systemRadius ?? node.size * 5) * viewport.zoom) / 4));
		if (
			screen.x + radius < -margin ||
			screen.x - radius > width + margin ||
			screen.y + radius < -margin ||
			screen.y - radius > height + margin
		)
			continue;
		drawEntitySystemField(ctx, screen.x, screen.y, radius, aspects, attributes, node.color, viewport.zoom);
	}
	ctx.restore();
}

function drawEntitySystemField(
	ctx: CanvasRenderingContext2D,
	x: number,
	y: number,
	radius: number,
	aspects: number,
	attributes: number,
	color: string,
	zoom: number,
): void {
	const ringCount = Math.min(3, Math.max(1, Math.ceil(aspects / 5)));
	const density = Math.min(1, Math.sqrt(attributes) / 13);

	// Stronger, more luminous glow
	const glow = ctx.createRadialGradient(x, y, radius * 0.22, x, y, radius * 1.3);
	glow.addColorStop(0, `rgba(96, 165, 250, ${0.04 + density * 0.04})`);
	glow.addColorStop(0.5, `rgba(96, 165, 250, ${0.03 + density * 0.06})`);
	glow.addColorStop(1, "rgba(96, 165, 250, 0)");
	ctx.fillStyle = glow;
	ctx.beginPath();
	ctx.arc(x, y, radius * 1.3, 0, Math.PI * 2);
	ctx.fill();

	// Elegant orbital rings with soft glow
	ctx.strokeStyle = "rgba(96, 165, 250, 0.18)";
	ctx.lineWidth = Math.max(0.8, zoom * 1.2);
	ctx.setLineDash([Math.max(3, radius * 0.04), Math.max(8, radius * 0.12)]);
	for (let i = 0; i < ringCount; i++) {
		ctx.beginPath();
		ctx.arc(x, y, radius * (0.56 + i * 0.26), 0, Math.PI * 2);
		ctx.stroke();
	}
	ctx.setLineDash([]);

	// Orbital ticks (satellites) - slightly larger and more luminous
	const tickCount = Math.min(18, Math.max(3, aspects));
	for (let i = 0; i < tickCount; i++) {
		const angle = -Math.PI / 2 + (Math.PI * 2 * i) / tickCount;
		const orbit = radius * (0.68 + (i % ringCount) * 0.24);
		const tx = x + Math.cos(angle) * orbit;
		const ty = y + Math.sin(angle) * orbit;
		ctx.save();
		ctx.translate(tx, ty);
		ctx.rotate(angle + Math.PI / 4);
		ctx.fillStyle = i < aspects ? color : "rgba(96, 165, 250, 0.32)";
		ctx.globalAlpha = i < aspects ? 0.65 : 0.28;
		const size = Math.max(2.6, Math.min(6, radius * 0.05));
		ctx.fillRect(-size / 2, -size / 2, size, size);
		// Small inner highlight for active ticks
		if (i < aspects) {
			ctx.globalAlpha = 0.4;
			ctx.fillStyle = "rgba(255, 255, 255, 0.7)";
			ctx.fillRect(-size * 0.25, -size * 0.25, size * 0.5, size * 0.5);
		}
		ctx.restore();
	}

	// Attribute density arc
	if (attributes > 0) {
		ctx.strokeStyle = `rgba(167, 139, 250, ${0.08 + density * 0.18})`;
		ctx.lineWidth = Math.max(1.2, zoom * 1.5);
		ctx.beginPath();
		ctx.arc(x, y, radius * 1.04, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * density);
		ctx.stroke();
	}
}

export function isNodeVisibleAtLod(node: GraphCanvasNode, zoom: number, emphasized = false): boolean {
	if (emphasized) return true;
	if (node.kind === "entity") return true;
	if (node.kind === "aspect") return zoom >= 0.09;
	if (node.kind === "attribute") return zoom >= 0.09;
	if (node.kind === "memory") return zoom >= 0.09;
	return zoom >= 0.09;
}

export function isEdgeVisibleAtLod(edge: GraphCanvasEdge, zoom: number, emphasized = false): boolean {
	if (emphasized) return true;
	if (edge.kind === "mentions") return zoom >= 0.18;
	return zoom >= 0.09;
}

export function nodeLodAlpha(node: GraphCanvasNode, zoom: number, emphasized = false): number {
	if (emphasized || zoom >= 0.34) return 1;
	if (node.kind === "entity") return 1;
	if (node.kind === "aspect") return 0.88;
	if (node.kind === "attribute") return 0.68;
	if (node.kind === "memory") return 0.55;
	return 0.68;
}

export function edgeLodAlpha(edge: GraphCanvasEdge, zoom: number, emphasized = false): number {
	if (emphasized || zoom >= 0.34) return 1;
	if (edge.kind === "about") return 0.52;
	if (edge.kind === "has_aspect") return 0.82;
	if (edge.kind === "has_attribute") return 0.65;
	if (edge.kind === "supports") return 0.55;
	return 0.6;
}

function edgeLodWidth(edge: GraphCanvasEdge, zoom: number, emphasized = false): number {
	if (emphasized || zoom >= 0.34) return 1;
	if (edge.kind === "about") return 0.9;
	if (edge.kind === "supports") return 0.88;
	return 0.92;
}

function drawTinyNode(
	ctx: CanvasRenderingContext2D,
	x: number,
	y: number,
	radius: number,
	color: string,
	kind: GraphCanvasNode["kind"],
	tone: NodeTone,
): void {
	ctx.save();
	ctx.translate(x, y);

	// Soft outer bloom for all tiny nodes
	if (tone !== "dim") {
		const bloom = ctx.createRadialGradient(0, 0, radius * 0.5, 0, 0, radius * 2.8);
		bloom.addColorStop(0, color);
		bloom.addColorStop(1, "rgba(0,0,0,0)");
		ctx.fillStyle = bloom;
		ctx.globalAlpha = tone === "selected" ? 0.45 : tone === "related" ? 0.32 : 0.18;
		ctx.beginPath();
		ctx.arc(0, 0, radius * 2.8, 0, Math.PI * 2);
		ctx.fill();
	}

	ctx.globalAlpha = tone === "dim" ? 0.55 : 1;
	ctx.fillStyle = color;
	ctx.strokeStyle =
		tone === "selected" ? "rgba(241, 245, 249, 0.96)" : tone === "related" ? "rgba(180, 230, 255, 0.9)" : color;
	ctx.lineWidth = tone === "selected" ? 1.6 : tone === "related" ? 1.2 : 0.8;
	ctx.beginPath();
	if (kind === "attribute" || kind === "memory") {
		ctx.rotate(Math.PI / 4);
		ctx.rect(-radius, -radius, radius * 2, radius * 2);
	} else if (kind === "aspect") {
		ctx.rect(-radius, -radius, radius * 2, radius * 2);
	} else {
		hexPath(ctx, 0, 0, radius * 1.15);
	}
	ctx.fill();
	ctx.stroke();
	if (tone === "selected" || tone === "related") {
		ctx.rotate(kind === "attribute" || kind === "memory" ? 0 : Math.PI / 4);
		ctx.strokeStyle = tone === "selected" ? "rgba(241, 245, 249, 0.94)" : "rgba(125, 211, 252, 0.86)";
		ctx.lineWidth = tone === "selected" ? 1.1 : 0.85;
		ctx.strokeRect(-radius * 1.75, -radius * 1.75, radius * 3.5, radius * 3.5);
	}
	ctx.restore();
}

function drawNodeShape(
	ctx: CanvasRenderingContext2D,
	x: number,
	y: number,
	size: number,
	fill: string,
	stroke: string,
	shape: string,
	kind: GraphCanvasNode["kind"],
	spritePath: string | undefined,
	tone: NodeTone,
): void {
	const radius = Math.max(size * 0.5, 2);
	const sprite = spriteForKind(kind, spritePath);
	if (sprite && radius >= 4.6) {
		drawSpriteNode(ctx, x, y, radius, sprite, shape, tone, stroke);
		return;
	}
	if (shape === "hex") {
		drawHexGem(ctx, x, y, radius, fill, stroke, tone);
		return;
	}
	if (shape === "rect") {
		drawSquareGem(ctx, x, y, radius, fill, stroke, tone);
		return;
	}
	drawRoundGem(ctx, x, y, radius, fill, stroke, tone);
}

function spriteForKind(kind: GraphCanvasNode["kind"], spritePath?: string): HTMLImageElement | null {
	const path = spritePath ?? NODE_SPRITES[kind as keyof typeof NODE_SPRITES];
	if (!path || typeof Image === "undefined") return null;
	const cached = spriteCache.get(path);
	if (cached !== undefined) return cached?.complete && cached.naturalWidth > 0 ? cached : null;
	const image = new Image();
	image.decoding = "async";
	image.src = path;
	spriteCache.set(path, image);
	return null;
}

function drawSpriteNode(
	ctx: CanvasRenderingContext2D,
	x: number,
	y: number,
	radius: number,
	sprite: HTMLImageElement,
	shape: string,
	tone: NodeTone,
	stroke: string,
): void {
	const scale = shape === "hex" ? 3.05 : 2.72;
	const size = radius * scale;
	ctx.save();
	ctx.imageSmoothingEnabled = true;
	ctx.drawImage(sprite, x - size / 2, y - size / 2, size, size);
	if (tone === "selected" || tone === "related") {
		ctx.strokeStyle = tone === "selected" ? "rgba(241, 245, 249, 0.96)" : stroke;
		ctx.lineWidth = tone === "selected" ? 1.8 : 1.25;
		if (shape === "hex") hexPath(ctx, x, y, radius * 1.55);
		else if (shape === "rect") {
			ctx.beginPath();
			ctx.rect(x - radius * 1.15, y - radius * 1.15, radius * 2.3, radius * 2.3);
		} else {
			ctx.beginPath();
			ctx.arc(x, y, radius * 1.12, 0, Math.PI * 2);
		}
		ctx.stroke();
	}
	ctx.restore();
}

function drawHexGem(
	ctx: CanvasRenderingContext2D,
	x: number,
	y: number,
	radius: number,
	fill: string,
	stroke: string,
	tone: NodeTone,
): void {
	const selected = tone === "selected";
	const related = tone === "related";
	ctx.save();

	// Outer glow bloom
	if (selected || related) {
		const glow = ctx.createRadialGradient(x, y, radius * 0.8, x, y, radius * 2.4);
		glow.addColorStop(0, selected ? "rgba(255, 255, 255, 0.35)" : "rgba(125, 211, 252, 0.22)");
		glow.addColorStop(1, "rgba(0, 0, 0, 0)");
		ctx.fillStyle = glow;
		ctx.beginPath();
		ctx.arc(x, y, radius * 2.4, 0, Math.PI * 2);
		ctx.fill();
	}

	ctx.lineWidth = selected ? 1.9 : related ? 1.55 : 1.15;
	ctx.strokeStyle = selected
		? "rgba(241, 245, 249, 0.96)"
		: related
			? "rgba(180, 214, 255, 0.88)"
			: "rgba(132, 166, 207, 0.68)";
	ctx.fillStyle = tone === "dim" ? "rgba(4, 14, 31, 0.42)" : "rgba(4, 14, 31, 0.84)";
	hexPath(ctx, x, y, radius * 1.12);
	ctx.fill();
	ctx.stroke();

	ctx.strokeStyle = selected ? "rgba(217, 183, 109, 0.92)" : "rgba(166, 124, 58, 0.66)";
	ctx.lineWidth = selected || related ? 1.1 : 0.75;
	hexPath(ctx, x, y, radius * 1.28);
	ctx.stroke();

	const core = ctx.createRadialGradient(x - radius * 0.28, y - radius * 0.28, 1, x, y, radius * 0.74);
	core.addColorStop(0, selected ? "rgba(255, 255, 255, 1)" : "rgba(220, 238, 255, 0.82)");
	core.addColorStop(0.3, fill);
	core.addColorStop(0.78, selected ? "rgba(56, 189, 248, 0.76)" : "rgba(37, 99, 235, 0.52)");
	core.addColorStop(1, tone === "dim" ? "rgba(2, 6, 23, 0.92)" : "rgba(2, 6, 23, 0.82)");
	ctx.fillStyle = core;
	ctx.strokeStyle = selected ? "rgba(241, 245, 249, 0.96)" : stroke;
	ctx.lineWidth = selected ? 1.5 : related ? 1.25 : 0.95;
	hexPath(ctx, x, y, radius * 0.72);
	ctx.fill();
	ctx.stroke();

	ctx.strokeStyle = selected ? "rgba(255, 255, 255, 0.92)" : "rgba(191, 219, 254, 0.68)";
	ctx.lineWidth = selected ? 1.05 : 0.7;
	drawDiamondPath(ctx, x, y, radius * 0.52);
	ctx.stroke();
	ctx.restore();
}

function drawSquareGem(
	ctx: CanvasRenderingContext2D,
	x: number,
	y: number,
	radius: number,
	fill: string,
	stroke: string,
	tone: NodeTone,
): void {
	const selected = tone === "selected";
	const related = tone === "related";
	ctx.save();

	// Outer glow bloom
	if (selected || related) {
		const glow = ctx.createRadialGradient(x, y, radius * 0.8, x, y, radius * 2.2);
		glow.addColorStop(0, selected ? "rgba(255, 255, 255, 0.3)" : "rgba(125, 211, 252, 0.18)");
		glow.addColorStop(1, "rgba(0, 0, 0, 0)");
		ctx.fillStyle = glow;
		ctx.beginPath();
		ctx.arc(x, y, radius * 2.2, 0, Math.PI * 2);
		ctx.fill();
	}

	ctx.fillStyle = tone === "dim" ? "rgba(5, 18, 40, 0.36)" : "rgba(5, 18, 40, 0.78)";
	ctx.strokeStyle = selected
		? "rgba(241, 245, 249, 0.96)"
		: related
			? "rgba(191, 219, 254, 0.86)"
			: "rgba(137, 166, 204, 0.58)";
	ctx.lineWidth = selected ? 1.7 : related ? 1.35 : 0.95;
	ctx.beginPath();
	ctx.rect(x - radius, y - radius, radius * 2, radius * 2);
	ctx.fill();
	ctx.stroke();

	ctx.strokeStyle = selected ? "rgba(217, 183, 109, 0.9)" : "rgba(166, 124, 58, 0.5)";
	ctx.lineWidth = selected || related ? 1 : 0.65;
	drawCornerTicks(ctx, x, y, radius);

	const core = ctx.createRadialGradient(x - radius * 0.22, y - radius * 0.22, 1, x, y, radius * 0.75);
	core.addColorStop(0, selected ? "rgba(255, 255, 255, 1)" : "rgba(224, 242, 254, 0.72)");
	core.addColorStop(0.32, fill);
	core.addColorStop(1, tone === "dim" ? "rgba(30, 41, 59, 0.48)" : "rgba(30, 41, 59, 0.72)");
	ctx.fillStyle = core;
	ctx.strokeStyle = selected ? "rgba(241, 245, 249, 0.94)" : stroke;
	ctx.lineWidth = selected ? 1.25 : 0.9;
	drawDiamondPath(ctx, x, y, radius * 0.62);
	ctx.fill();
	ctx.stroke();
	ctx.restore();
}

function drawRoundGem(
	ctx: CanvasRenderingContext2D,
	x: number,
	y: number,
	radius: number,
	fill: string,
	stroke: string,
	tone: NodeTone,
): void {
	const selected = tone === "selected";
	const related = tone === "related";
	ctx.save();

	// Outer glow bloom
	if (selected || related) {
		const glow = ctx.createRadialGradient(x, y, radius * 0.8, x, y, radius * 2.2);
		glow.addColorStop(0, selected ? "rgba(255, 255, 255, 0.3)" : "rgba(125, 211, 252, 0.18)");
		glow.addColorStop(1, "rgba(0, 0, 0, 0)");
		ctx.fillStyle = glow;
		ctx.beginPath();
		ctx.arc(x, y, radius * 2.2, 0, Math.PI * 2);
		ctx.fill();
	}

	const core = ctx.createRadialGradient(x - radius * 0.26, y - radius * 0.26, 1, x, y, radius);
	core.addColorStop(0, tone === "selected" ? "rgba(255, 255, 255, 1)" : "rgba(240, 249, 255, 0.68)");
	core.addColorStop(0.35, fill);
	core.addColorStop(1, tone === "dim" ? "rgba(2, 6, 23, 0.88)" : "rgba(2, 6, 23, 0.76)");
	ctx.fillStyle = core;
	ctx.strokeStyle = tone === "selected" ? "rgba(241, 245, 249, 0.94)" : stroke;
	ctx.lineWidth = tone === "selected" ? 1.4 : tone === "related" ? 1.2 : 0.9;
	ctx.beginPath();
	ctx.arc(x, y, radius, 0, Math.PI * 2);
	ctx.fill();
	ctx.stroke();
	ctx.restore();
}

function hexPath(ctx: CanvasRenderingContext2D, x: number, y: number, radius: number): void {
	ctx.beginPath();
	for (let i = 0; i < 6; i++) {
		const angle = Math.PI / 6 + (Math.PI * 2 * i) / 6;
		const px = x + Math.cos(angle) * radius;
		const py = y + Math.sin(angle) * radius;
		if (i === 0) ctx.moveTo(px, py);
		else ctx.lineTo(px, py);
	}
	ctx.closePath();
}

function drawDiamondPath(ctx: CanvasRenderingContext2D, x: number, y: number, radius: number): void {
	ctx.beginPath();
	ctx.moveTo(x, y - radius);
	ctx.lineTo(x + radius, y);
	ctx.lineTo(x, y + radius);
	ctx.lineTo(x - radius, y);
	ctx.closePath();
}

function drawCornerTicks(ctx: CanvasRenderingContext2D, x: number, y: number, radius: number): void {
	const tick = Math.max(radius * 0.42, 4);
	const inset = radius * 0.12;
	const left = x - radius - inset;
	const right = x + radius + inset;
	const top = y - radius - inset;
	const bottom = y + radius + inset;
	ctx.beginPath();
	ctx.moveTo(left, top + tick);
	ctx.lineTo(left, top);
	ctx.lineTo(left + tick, top);
	ctx.moveTo(right - tick, top);
	ctx.lineTo(right, top);
	ctx.lineTo(right, top + tick);
	ctx.moveTo(right, bottom - tick);
	ctx.lineTo(right, bottom);
	ctx.lineTo(right - tick, bottom);
	ctx.moveTo(left + tick, bottom);
	ctx.lineTo(left, bottom);
	ctx.lineTo(left, bottom - tick);
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
	const labelWidth = ctx.measureText(label).width + 14;
	// Softer, more integrated label background
	ctx.fillStyle = "rgba(2, 6, 23, 0.62)";
	ctx.fillRect(x - labelWidth / 2, y - 2, labelWidth, size + 6);
	ctx.strokeStyle = "rgba(96, 165, 250, 0.18)";
	ctx.lineWidth = 0.7;
	ctx.beginPath();
	ctx.moveTo(x - labelWidth / 2, y - 2);
	ctx.lineTo(x + labelWidth / 2, y - 2);
	ctx.stroke();
	// Subtle text shadow for depth
	ctx.fillStyle = shadow;
	ctx.fillText(label, x + 1, y + 1);
	ctx.fillStyle = color;
	ctx.fillText(label, x, y);
}

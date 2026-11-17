/*
MIT License

Copyright (c) 2025 supermemory

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

*/
import { categoryColor, type EntityCategory } from "./entity-category";
import { GraphHoverIntent } from "./graph-hover";
import { ViewportState } from "./graph-viewport";
import type { GraphWorkerResponse, GraphWorkerRequest } from "./graph-worker";
import type { LayoutNode } from "./graph-layout";

export type SceneNodeKind =
	| "entity"
	| "source"
	| "aspect"
	| "group"
	| "claimSlot"
	| "attribute"
	| "claim"
	| "constraint"
	| "assertion"
	| "origin"
	| "memory";

export type SceneEdgeKind = "contains" | "organizes" | "describes" | "asserted_by" | "evidenced_by" | "depends_on";

export interface SceneNode {
	id: string;
	label: string;
	kind: SceneNodeKind;
	cluster: string;
	weight: number;
	metric: string;
	confidence?: number;
	detail?: string;
	evidenceRefs?: readonly string[];
	scopeColor?: string;
	category?: EntityCategory;
}

export interface SceneEdge {
	from: string;
	to: string;
	kind: SceneEdgeKind;
	label?: string;
	strength?: number;
}

export interface GraphSceneData {
	nodes: readonly SceneNode[];
	edges: readonly SceneEdge[];
}

export function matchRetrievedNodes(
	nodes: readonly SceneNode[],
	nodeIds: readonly string[],
	evidenceRefs: readonly string[],
): Set<string> {
	const ids = new Set(nodeIds);
	const refs = new Set(evidenceRefs);
	return new Set(
		nodes
			.filter((node) => ids.has(node.id) || refs.has(node.id) || node.evidenceRefs?.some((ref) => refs.has(ref)))
			.map((node) => node.id),
	);
}

export interface GraphSceneHandle {
	setRetrieval(nodeIds: readonly string[], evidenceRefs: readonly string[]): void;
	clearRetrieval(): void;
	setFollowAgent(enabled: boolean): void;
	focusNode(id: string): void;
	resetView(): void;
	clearSelection(): void;
	fit(): void;
	center(): void;
	focusable(): readonly string[];
	zoom(factor: number): void;
	setHiddenKinds(kinds: readonly SceneNodeKind[]): void;
	isolate(cluster: string | null): void;
	dispose(): void;
}

const COLORS: Record<SceneNodeKind, string> = {
	entity: "#eef4ff",
	source: "#8be0ff",
	aspect: "#b9c8ff",
	group: "#8197e8",
	claimSlot: "#8197e8",
	attribute: "#7aa2ff",
	claim: "#93d9ff",
	constraint: "#ff8fab",
	assertion: "#a5b8ff",
	origin: "#56679a",
	memory: "#56679a",
};

const LIGHT_COLORS: Record<SceneNodeKind, string> = {
	entity: "#16213f",
	source: "#0369a1",
	aspect: "#3b4fa0",
	group: "#6274c0",
	claimSlot: "#6274c0",
	attribute: "#2f5bd3",
	claim: "#0e7490",
	constraint: "#be123c",
	assertion: "#4256b8",
	origin: "#94a3b8",
	memory: "#94a3b8",
};

const RETRIEVAL = { dark: "#6ef2c0", light: "#059669" } as const;
const SURFACE = { dark: "#101214", light: "#f5f7f9" } as const;
const BRIDGE = { dark: "#a1a1aa", light: "#52525b" } as const;
const MAX_SOURCE_LABELS = 20;
const SOURCE_LABEL_ZOOM = 3;
const BASE_ENTITY_LABELS = 12;
const GLYPH_SCREEN_RADIUS = 2.4;
const RADIUS: Record<SceneNodeKind, number> = {
	entity: 5,
	source: 2.8,
	aspect: 3.3,
	group: 2.6,
	claimSlot: 2.3,
	attribute: 1.9,
	claim: 2.1,
	constraint: 2.4,
	assertion: 2,
	origin: 1.5,
	memory: 1.5,
};
const MAX_FOCUS_ZOOM = 4;
const FOCUS_REACH = 48;

function tierOf(kind: SceneNodeKind): number {
	if (kind === "entity" || kind === "source") return 0;
	if (kind === "aspect" || kind === "group" || kind === "claimSlot") return 1;
	return 2;
}

function smoothstep(edge0: number, edge1: number, value: number): number {
	const t = Math.min(1, Math.max(0, (value - edge0) / (edge1 - edge0)));
	return t * t * (3 - 2 * t);
}

function detailVisibility(tier: number, detail: number): number {
	if (tier === 0) return 1;
	if (tier === 1) return 0.75 + 0.25 * smoothstep(1, 1.8, detail);
	return 0.55 + 0.45 * smoothstep(1.2, 2.4, detail);
}

function interactive(tier: number, detail: number): boolean {
	if (tier === 0) return true;
	return detail >= (tier === 1 ? 1.35 : 2);
}

function labelPriority(node: LayoutNode, active: LayoutNode | undefined): number {
	if (node.id === active?.id) return 4;
	if (node.kind === "entity") return 2 + node.weight;
	if (node.kind === "source") return 1 + node.weight;
	return node.weight;
}

type Glyph = "circle" | "square" | "hexagon" | "diamond" | "triangle";

const GLYPHS: Record<SceneNodeKind, { readonly shape: Glyph; readonly filled: boolean }> = {
	entity: { shape: "circle", filled: true },
	source: { shape: "square", filled: true },
	aspect: { shape: "hexagon", filled: true },
	group: { shape: "hexagon", filled: false },
	claimSlot: { shape: "diamond", filled: false },
	attribute: { shape: "circle", filled: true },
	claim: { shape: "diamond", filled: true },
	constraint: { shape: "triangle", filled: true },
	assertion: { shape: "circle", filled: false },
	origin: { shape: "square", filled: false },
	memory: { shape: "square", filled: false },
};

function glyphPath(context: CanvasRenderingContext2D, shape: Glyph, x: number, y: number, r: number): void {
	if (shape === "circle") context.arc(x, y, r, 0, Math.PI * 2);
	else if (shape === "square") context.rect(x - r * 0.85, y - r * 0.85, r * 1.7, r * 1.7);
	else if (shape === "hexagon") hexagon(context, x, y, r * 1.1);
	else if (shape === "diamond") {
		context.moveTo(x, y - r * 1.25);
		context.lineTo(x + r * 1.25, y);
		context.lineTo(x, y + r * 1.25);
		context.lineTo(x - r * 1.25, y);
		context.closePath();
	} else {
		context.moveTo(x, y - r * 1.3);
		context.lineTo(x + r * 1.2, y + r * 0.8);
		context.lineTo(x - r * 1.2, y + r * 0.8);
		context.closePath();
	}
}

function hexagon(context: CanvasRenderingContext2D, x: number, y: number, r: number): void {
	for (let side = 0; side < 6; side++) {
		const angle = (Math.PI / 3) * side + Math.PI / 6;
		const px = x + Math.cos(angle) * r;
		const py = y + Math.sin(angle) * r;
		if (side === 0) context.moveTo(px, py);
		else context.lineTo(px, py);
	}
	context.closePath();
}

function pill(context: CanvasRenderingContext2D, x: number, y: number, w: number, h: number): void {
	const r = h / 2;
	context.moveTo(x + r, y);
	context.arcTo(x + w, y, x + w, y + h, r);
	context.arcTo(x + w, y + h, x, y + h, r);
	context.arcTo(x, y + h, x, y, r);
	context.arcTo(x, y, x + w, y, r);
	context.closePath();
}

export function createGraphScene(
	container: HTMLElement,
	data: GraphSceneData,
	onSelect?: (node: SceneNode | null) => void,
	onError?: () => void,
	onUserNavigation?: () => void,
	onIsolate?: (cluster: string | null) => void,
	onZoom?: (percent: number) => void,
	layoutScope?: string,
): GraphSceneHandle {
	const canvas = document.createElement("canvas");
	canvas.tabIndex = 0;
	canvas.setAttribute("aria-busy", "true");
	canvas.setAttribute(
		"aria-label",
		"Memory graph. Drag to pan, scroll to zoom, click a node to select it. With a node selected, arrow keys move between related nodes. Z fits, C centers, Escape clears the selection.",
	);
	canvas.style.cssText = "width:100%;height:100%;display:block;touch-action:none;";
	const context = canvas.getContext("2d");
	if (!context) throw new Error("Canvas is unavailable");
	const tooltip = document.createElement("div");
	tooltip.className = "graph-tooltip";
	tooltip.hidden = true;
	tooltip.setAttribute("role", "status");
	const worker = new Worker(new URL("./graph-worker.ts", import.meta.url), { type: "module" });
	container.append(canvas, tooltip);
	let nodes: LayoutNode[] = [];
	let overviewZoom = Number.POSITIVE_INFINITY;
	let byId = new Map<string, LayoutNode>();
	let edges: Array<{ edge: SceneEdge; from: LayoutNode; to: LayoutNode }> = [];
	let width = 1;
	let height = 1;
	const viewport = new ViewportState();
	let selected: LayoutNode | undefined;
	const hover = new GraphHoverIntent();
	const emphasis = new Map<string, number>();
	let retrieved = new Set<string>();
	let retrievedNeighbors = new Set<string>();
	let pendingRetrieval: { ids: Set<string>; at: number } | undefined;
	let followAgent = true;
	let followDue = false;
	let lastFollow = -Infinity;
	let framing = true;
	const pauseFollow = () => {
		framing = false;
		followAgent = false;
		followDue = false;
		viewport.cancelAnimation();
		onUserNavigation?.();
	};
	let lastDraw = performance.now();
	let frame = 0;
	let disposed = false;
	const pointers = new Map<number, { x: number; y: number }>();
	let pinch: { distance: number; x: number; y: number } | undefined;
	let dragged = false;
	let parentOf = new Map<string, string>();
	let childrenOf = new Map<string, LayoutNode[]>();
	let percent = 0;
	let targets = new Map<string, { x: number; y: number }>();
	let history: Array<{ x: number; y: number; t: number }> = [];
	let drag:
		| { id: number; x: number; y: number; startX: number; startY: number; moved: boolean; node?: LayoutNode }
		| undefined;
	let hiddenKinds = new Set<SceneNodeKind>();
	let isolated: string | undefined;
	let entityRank = new Map<string, number>();
	const tint = (node: SceneNode, dark: boolean) => {
		const colors = dark ? COLORS : LIGHT_COLORS;
		if (node.kind === "constraint" || node.kind === "origin" || node.kind === "memory" || !node.category)
			return colors[node.kind];
		return categoryColor(node.category, dark);
	};
	const bodyOf = (node: SceneNode) => (node.cluster !== node.id && byId.has(node.cluster) ? node.cluster : node.id);
	const radius = (node: SceneNode) =>
		node.kind === "entity" ? 4 + 3 * Math.min(1, Math.max(0, node.weight)) : RADIUS[node.kind];
	const screenRadius = (node: SceneNode) =>
		node.kind === "entity" ? 3 + 2 * Math.min(1, Math.max(0, node.weight)) : node.kind === "source" ? 2.5 : 1.1;
	const maxScreenRadius = (node: SceneNode) =>
		node.kind === "entity" ? 8 : node.kind === "source" ? 5.5 : tierOf(node.kind) === 1 ? 7 : 6;
	const detail = () => (Number.isFinite(overviewZoom) && overviewZoom > 0 ? viewport.zoom / overviewZoom : 1);
	const shown = (node: LayoutNode) =>
		!hiddenKinds.has(node.kind) && (!isolated || node.cluster === isolated || node.id === isolated);
	const showTooltip = (node?: LayoutNode) => {
		tooltip.hidden = !node;
		if (!node) return;
		tooltip.replaceChildren();
		const kind = document.createElement("span");
		kind.className = "graph-tooltip-kind";
		kind.style.color = tint(node, document.documentElement.classList.contains("dark"));
		kind.textContent =
			node.kind === "origin" || node.kind === "memory"
				? "Evidence"
				: node.kind === "claimSlot"
					? "Claim slot"
					: node.kind;
		const title = document.createElement("strong");
		title.textContent = node.detail ?? node.label;
		const meta = document.createElement("span");
		meta.textContent = node.metric;
		tooltip.append(kind, title, meta);
	};
	const draw = (now: number) => {
		frame = 0;
		if (disposed) return;
		const moving = viewport.tick();
		let highlighting = hover.tick(now);
		if (pendingRetrieval) {
			highlighting = true;
			if (now >= pendingRetrieval.at && nodes.length) {
				retrieved = pendingRetrieval.ids;
				retrievedNeighbors = new Set(
					edges
						.filter(({ from, to }) => retrieved.has(from.id) || retrieved.has(to.id))
						.flatMap(({ from, to }) => [from.id, to.id]),
				);
				pendingRetrieval = undefined;
				followDue = followAgent;
				canvas.dataset.retrievedNodes = String(retrieved.size);
			}
		}
		if (followDue && followAgent) {
			highlighting = true;
			if (now - lastFollow >= 1000) {
				const subset = nodes.filter((node) => retrieved.has(node.id) || retrievedNeighbors.has(node.id));
				if (subset.length) fit(subset);
				lastFollow = now;
				followDue = false;
			}
		}
		const blend = 1 - Math.exp(-Math.min(now - lastDraw, 32) / 180);
		lastDraw = now;
		const fade = (key: string, target: number, initial = 1) => {
			const previous = emphasis.get(key) ?? initial;
			const value = Math.abs(previous - target) < 0.005 ? target : previous + (target - previous) * blend;
			emphasis.set(key, value);
			if (value !== target) highlighting = true;
			return value;
		};
		let settling = false;
		for (const node of nodes) {
			const target = targets.get(node.id);
			if (!target || drag?.node === node) continue;
			const dx = target.x - node.x,
				dy = target.y - node.y;
			if (Math.abs(dx) + Math.abs(dy) > 0.1) {
				node.x += dx * 0.35;
				node.y += dy * 0.35;
				settling = true;
			} else {
				node.x = target.x;
				node.y = target.y;
			}
		}
		const ratio = Math.min(devicePixelRatio || 1, 2);
		context.setTransform(ratio, 0, 0, ratio, 0, 0);
		context.clearRect(0, 0, width, height);
		const dark = document.documentElement.classList.contains("dark");
		const tone = dark ? "dark" : "light";
		const foreground = dark ? "#f4f4f5" : "#18181b";
		const active = (hover.active ? byId.get(hover.active) : undefined) ?? (retrieved.size ? undefined : selected);
		const hovered = hover.active ? byId.get(hover.active) : undefined;
		if (tooltip.dataset.node !== (hovered?.id ?? "")) {
			showTooltip(hovered);
			tooltip.dataset.node = hovered?.id ?? "";
		}
		const focus = retrieved.size ? undefined : selected;
		const relevant = (node: LayoutNode) =>
			focus
				? node.id === focus.id || node.cluster === focus.cluster
				: !retrieved.size || retrieved.has(node.id) || retrievedNeighbors.has(node.id);
		const level = detail();
		const appear = fade("appear", 1, 0);
		const dim = fade("dim", focus || retrieved.size ? 1 : 0, 0);
		const visibility = new Map<string, number>();
		for (const node of nodes) {
			const reveal = fade(
				`reveal:${node.id}`,
				(active && node.cluster === active.cluster) || retrieved.has(node.id) || retrievedNeighbors.has(node.id)
					? 1
					: 0,
				0,
			);
			visibility.set(node.id, shown(node) ? Math.max(detailVisibility(tierOf(node.kind), level), reveal) : 0);
		}
		const z = viewport.zoom;
		context.save();
		context.translate(viewport.panX, viewport.panY);
		context.scale(z, z);
		const spokes = new Map<string, Array<{ from: LayoutNode; to: LayoutNode }>>();
		const bridges = new Map<string, Array<{ from: LayoutNode; to: LayoutNode }>>();
		const highlightedEdges: Array<{ key: string; from: LayoutNode; to: LayoutNode; dependency: boolean }> = [];
		for (const { edge, from, to } of edges) {
			const vis = Math.min(visibility.get(from.id) ?? 0, visibility.get(to.id) ?? 0);
			if (vis < 0.02) continue;
			const touches = (node: LayoutNode | undefined) => !!node && (from.id === node.id || to.id === node.id);
			const highlighted = active ? touches(hovered) || touches(focus) : retrieved.has(from.id) || retrieved.has(to.id);
			if (highlighted) {
				highlightedEdges.push({
					key: `edge:${edge.from}:${edge.to}:${edge.kind}`,
					from,
					to,
					dependency: edge.kind === "depends_on",
				});
				continue;
			}
			const local = bodyOf(from) === bodyOf(to);
			const muted = relevant(from) && relevant(to) ? 1 : 1 - dim * 0.8;
			const base = local
				? dark
					? 0.22
					: 0.2
				: (edge.kind === "depends_on" ? (dark ? 0.34 : 0.3) : dark ? 0.12 : 0.1) *
					(1 - 0.6 * smoothstep(1.5, 4, level));
			const bucket = Math.round(Math.min(1, base * vis * muted) * 40);
			if (bucket <= 0) continue;
			const target = local ? spokes : bridges;
			const group = `${bucket}|${local ? tint(byId.get(bodyOf(from)) ?? from, dark) : BRIDGE[tone]}`;
			const list = target.get(group);
			if (list) list.push({ from, to });
			else target.set(group, [{ from, to }]);
		}
		const stroke = (groups: Map<string, Array<{ from: LayoutNode; to: LayoutNode }>>, w: number) => {
			context.lineWidth = w / z;
			for (const [group, list] of groups) {
				const [bucket, color] = group.split("|");
				context.strokeStyle = color ?? BRIDGE[tone];
				context.globalAlpha = (Number(bucket) / 40) * appear;
				context.beginPath();
				for (const { from, to } of list) {
					context.moveTo(from.x, from.y);
					context.lineTo(to.x, to.y);
				}
				context.stroke();
			}
		};
		stroke(spokes, 0.75);
		stroke(bridges, 1);
		const accent = retrieved.size && !active ? RETRIEVAL[tone] : active ? tint(active, dark) : foreground;
		context.strokeStyle = accent;
		context.lineWidth = 1.4 / z;
		for (const { key, from, to, dependency } of highlightedEdges) {
			context.globalAlpha = fade(key, 1, 0) * appear * 0.95;
			context.beginPath();
			context.moveTo(from.x, from.y);
			context.lineTo(to.x, to.y);
			if (dependency) {
				const angle = Math.atan2(to.y - from.y, to.x - from.x);
				const tipX = to.x - Math.cos(angle) * (radius(to) + 3 / z);
				const tipY = to.y - Math.sin(angle) * (radius(to) + 3 / z);
				context.moveTo(tipX - (Math.cos(angle - 0.5) * 6) / z, tipY - (Math.sin(angle - 0.5) * 6) / z);
				context.lineTo(tipX, tipY);
				context.lineTo(tipX - (Math.cos(angle + 0.5) * 6) / z, tipY - (Math.sin(angle + 0.5) * 6) / z);
			}
			context.stroke();
		}
		const surface = SURFACE[tone];
		for (const node of nodes) {
			const vis = visibility.get(node.id) ?? 0;
			if (vis < 0.02) continue;
			const x = node.x * z + viewport.panX;
			const y = node.y * z + viewport.panY;
			if (x < -120 || x > width + 120 || y < -60 || y > height + 60) continue;
			const alpha = fade(`node:${node.id}`, relevant(node) ? 1 : 1 - dim * 0.7) * vis * appear;
			const r = Math.min(Math.max(radius(node), screenRadius(node) / z), maxScreenRadius(node) / z);
			const color = retrieved.has(node.id) ? RETRIEVAL[tone] : tint(node, dark);
			context.globalAlpha = alpha;
			const glyph = GLYPHS[node.kind];
			const legible = r * z >= GLYPH_SCREEN_RADIUS;
			context.beginPath();
			glyphPath(context, legible ? glyph.shape : "circle", node.x, node.y, r);
			if (legible && !glyph.filled) {
				context.fillStyle = surface;
				context.fill();
				context.strokeStyle = color;
				context.lineWidth = 1.2 / z;
				context.stroke();
			} else {
				context.fillStyle = color;
				context.fill();
			}
			if (tierOf(node.kind) === 0) {
				context.strokeStyle = node.scopeColor ?? color;
				context.globalAlpha = alpha * (node.scopeColor ? 0.9 : 0.45);
				context.lineWidth = 1.25 / z;
				context.beginPath();
				context.arc(node.x, node.y, r + 2.5 / z, 0, Math.PI * 2);
				context.stroke();
			}
			const ring = fade(
				`ring:${node.id}`,
				node.id === active?.id || node.id === focus?.id || retrieved.has(node.id) ? 1 : 0,
				0,
			);
			if (ring > 0.005) {
				const reach = r + 6 / z;
				context.globalAlpha = ring * appear;
				context.strokeStyle = retrieved.has(node.id) ? RETRIEVAL[tone] : foreground;
				context.lineWidth = 1 / z;
				context.setLineDash([3 / z, 3 / z]);
				context.beginPath();
				context.arc(node.x, node.y, reach, 0, Math.PI * 2);
				context.stroke();
				context.setLineDash([]);
				context.beginPath();
				for (let tick = 0; tick < 4; tick++) {
					const angle = (Math.PI / 2) * tick + Math.PI / 4;
					context.moveTo(node.x + Math.cos(angle) * (reach + 2 / z), node.y + Math.sin(angle) * (reach + 2 / z));
					context.lineTo(node.x + Math.cos(angle) * (reach + 6 / z), node.y + Math.sin(angle) * (reach + 6 / z));
				}
				context.stroke();
			}
		}
		context.restore();
		const occupied: Array<{ x: number; y: number; w: number; h: number }> = [];
		const free = (x: number, y: number, w: number, h: number) =>
			!occupied.some((box) => x < box.x + box.w + 6 && x + w + 6 > box.x && y < box.y + box.h && y + h > box.y);
		const sourceCount = nodes.reduce((count, node) => count + (node.kind === "source" ? 1 : 0), 0);
		const labelSources = sourceCount <= MAX_SOURCE_LABELS || z >= overviewZoom * SOURCE_LABEL_ZOOM;
		const entityBudget = Math.round(BASE_ENTITY_LABELS * level * level);
		let sourceLabels = 0;
		for (const node of [...nodes].sort((a, b) => labelPriority(b, active) - labelPriority(a, active))) {
			if ((visibility.get(node.id) ?? 0) < 0.5) continue;
			const focused = node.id === active?.id || node.id === hovered?.id;
			const visible =
				focused ||
				retrieved.has(node.id) ||
				(node.kind === "entity" && (entityRank.get(node.id) ?? Number.POSITIVE_INFINITY) < entityBudget) ||
				(node.kind === "source" && labelSources && sourceLabels < MAX_SOURCE_LABELS);
			const labelAlpha = fade(`label:${node.id}`, visible ? 1 : 0, 0);
			if (labelAlpha < 0.005) continue;
			const sx = node.x * z + viewport.panX;
			const sy = node.y * z + viewport.panY;
			const body = byId.get(bodyOf(node));
			const centered = tierOf(node.kind) === 0;
			const outward = !centered && body ? Math.sign(node.x - body.x) || 1 : 1;
			const text = node.label.length > 30 ? `${node.label.slice(0, 29)}…` : node.label;
			context.font = focused
				? "500 12px 'Schibsted Grotesk', sans-serif"
				: node.kind === "entity" || node.kind === "aspect"
					? "500 11.5px 'Schibsted Grotesk', sans-serif"
					: tierOf(node.kind) === 1
						? "italic 10.5px 'Schibsted Grotesk', sans-serif"
						: "10.5px 'Schibsted Grotesk', sans-serif";
			const w = context.measureText(text).width + (focused ? 26 : 0);
			const h = focused ? 22 : 14;
			const x = centered ? sx - w / 2 : outward > 0 ? sx + radius(node) * z + 8 : sx - radius(node) * z - 8 - w;
			const y = centered ? sy + radius(node) * z + 8 : sy - h / 2;
			if (x < 0 || x + w > width || y < 55 || y + h > height - 100) continue;
			if (!focused && !free(x, y, w, h)) continue;
			occupied.push({ x, y, w, h });
			if (node.kind === "source") sourceLabels++;
			context.globalAlpha = labelAlpha * (focused ? 1 : (emphasis.get(`node:${node.id}`) ?? 1)) * appear;
			if (focused) {
				context.beginPath();
				pill(context, x, y, w, h);
				context.fillStyle = dark ? "rgba(8, 12, 26, 0.88)" : "rgba(255, 255, 255, 0.94)";
				context.fill();
				context.strokeStyle = dark ? "rgba(170, 195, 255, 0.18)" : "rgba(22, 33, 63, 0.14)";
				context.lineWidth = 1;
				context.stroke();
				context.beginPath();
				context.arc(x + 11, y + h / 2, 3, 0, Math.PI * 2);
				context.fillStyle = retrieved.has(node.id) ? RETRIEVAL[tone] : tint(node, dark);
				context.fill();
				context.fillStyle = foreground;
				context.fillText(text, x + 19, y + h / 2 + 4);
				continue;
			}
			context.lineJoin = "round";
			context.lineWidth = 3;
			context.strokeStyle = surface;
			context.strokeText(text, x, y + 11);
			context.fillStyle =
				node.kind === "aspect" ? tint(node, dark) : tierOf(node.kind) === 0 ? foreground : dark ? "#a1a1aa" : "#52525b";
			context.fillText(text, x, y + 11);
		}
		context.globalAlpha = 1;
		const zoomed = Math.round(z * 100);
		if (zoomed !== percent) {
			percent = zoomed;
			onZoom?.(zoomed);
		}
		if (hovered && !tooltip.hidden) {
			const sx = hovered.x * z + viewport.panX;
			const sy = hovered.y * z + viewport.panY;
			const reach =
				Math.min(Math.max(radius(hovered), screenRadius(hovered) / z), maxScreenRadius(hovered) / z) * z + 12;
			const w = tooltip.offsetWidth;
			const h = tooltip.offsetHeight;
			const x =
				sx + reach + w <= width - 8
					? sx + reach
					: sx - reach - w >= 8
						? sx - reach - w
						: Math.min(Math.max(8, sx - w / 2), width - w - 8);
			const sideways = x === sx + reach || x === sx - reach - w;
			const y = sideways
				? Math.min(Math.max(8, sy - h / 2), height - h - 8)
				: sy + reach + h <= height - 8
					? sy + reach
					: Math.max(8, sy - reach - h);
			tooltip.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
		}
		if (moving || settling || highlighting) invalidate();
	};
	const invalidate = () => {
		if (!disposed && !frame) frame = requestAnimationFrame(draw);
	};
	const fit = (subset = nodes, animate = true) => {
		const available = width;
		const overview = subset === nodes;
		const anchors = overview ? nodes.filter((node) => tierOf(node.kind) === 0 && shown(node)) : subset;
		const framed = anchors.length ? anchors : subset;
		const bounds = framed.map((node) => ({
			x: node.x,
			y: node.y,
			size: radius(node) + 30,
		}));
		viewport.setMinZoomForNodes(
			nodes.map((node) => ({ x: node.x, y: node.y, size: radius(node) })),
			width,
			height,
		);
		viewport.fitToNodes(bounds, available, height, { animate });
		if (overview) overviewZoom = viewport.restingZoom;
		invalidate();
	};
	const center = () => {
		const anchors = nodes.filter((node) => tierOf(node.kind) === 0 && shown(node));
		if (!anchors.length) return;
		const x = anchors.reduce((sum, node) => sum + node.x, 0) / anchors.length;
		const y = anchors.reduce((sum, node) => sum + node.y, 0) / anchors.length;
		viewport.centerOn(x, y, width, height);
		invalidate();
	};
	const frameCluster = (node: LayoutNode) => {
		const reach = FOCUS_REACH;
		const target = Math.min(MAX_FOCUS_ZOOM, Math.min(width, height) / (reach * 2));
		viewport.focusOn(node.x, node.y, Math.max(target, viewport.restingZoom), width, height);
	};
	const focusNode = (id: string) => {
		selected = byId.get(id);
		hover.clear();
		if (!selected) return;
		if (tierOf(selected.kind) === 0) frameCluster(selected);
		else viewport.centerOn(selected.x, selected.y, width, height);
		invalidate();
	};
	const clearSelection = () => {
		selected = undefined;
		invalidate();
	};
	const select = (node: LayoutNode | undefined) => {
		selected = node;
		onSelect?.(node ?? null);
		invalidate();
	};
	const selectAndCenter = (node: LayoutNode | undefined) => {
		if (!node) return;
		select(node);
		viewport.centerOn(node.x, node.y, width, height);
	};
	const isolate = (cluster: string | null) => {
		isolated = cluster ?? undefined;
		onIsolate?.(cluster);
		hover.clear();
		if (cluster) {
			selected = byId.get(cluster);
			fit(nodes.filter((node) => node.cluster === cluster || node.id === cluster));
		} else {
			fit();
		}
		invalidate();
	};
	const resetView = () => {
		if (isolated) {
			isolated = undefined;
			onIsolate?.(null);
		}
		selected = undefined;
		hover.clear();
		showTooltip();
		fit();
		onSelect?.(null);
	};
	const zoom = (factor: number, x = width / 2, y = height / 2) => {
		viewport.zoomTo(viewport.zoom * factor, x, y);
		invalidate();
	};
	const point = (event: MouseEvent) => {
		const rect = canvas.getBoundingClientRect();
		return { x: event.clientX - rect.left, y: event.clientY - rect.top };
	};
	const hittable = (node: LayoutNode) =>
		shown(node) &&
		(interactive(tierOf(node.kind), detail()) || (selected !== undefined && node.cluster === selected.cluster));
	const hit = (x: number, y: number) =>
		[...nodes]
			.reverse()
			.find(
				(node) =>
					hittable(node) &&
					Math.hypot(node.x * viewport.zoom + viewport.panX - x, node.y * viewport.zoom + viewport.panY - y) <=
						Math.max(8, radius(node) * viewport.zoom + 3),
			);
	const release = () => {
		if (!drag?.node || !drag.moved) return;
		targets.set(drag.node.id, { x: drag.node.x, y: drag.node.y });
		const request: GraphWorkerRequest = { type: "release", id: drag.node.id };
		worker.postMessage(request);
	};
	const spread = () => {
		const [a, b] = [...pointers.values()];
		if (!a || !b) return undefined;
		return { distance: Math.hypot(b.x - a.x, b.y - a.y), x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
	};
	const down = (event: PointerEvent) => {
		if (event.pointerType === "mouse" && event.button !== 0) return;
		pauseFollow();
		const p = point(event);
		pointers.set(event.pointerId, p);
		canvas.setPointerCapture(event.pointerId);
		viewport.cancelAnimation();
		if (pointers.size >= 2) {
			release();
			drag = undefined;
			pinch = spread();
			dragged = true;
			return;
		}
		history = [{ ...p, t: performance.now() }];
		dragged = false;
		const node = hit(p.x, p.y);
		drag = { id: event.pointerId, ...p, startX: p.x, startY: p.y, moved: false, node };
		if (!node) canvas.style.cursor = "grabbing";
	};
	const move = (event: PointerEvent) => {
		const p = point(event);
		if (pointers.has(event.pointerId)) pointers.set(event.pointerId, p);
		if (pinch && pointers.size >= 2) {
			const next = spread();
			if (!next) return;
			viewport.zoomImmediate(next.distance / Math.max(1, pinch.distance), next.x, next.y);
			viewport.pan(next.x - pinch.x, next.y - pinch.y);
			pinch = next;
			invalidate();
			return;
		}
		if (drag) {
			if (drag.id !== event.pointerId) return;
			if (!drag.moved && Math.hypot(p.x - drag.startX, p.y - drag.startY) < 4) return;
			drag.moved = true;
			dragged = true;
			canvas.style.cursor = "grabbing";
			if (drag.node) {
				drag.node.x += (p.x - drag.x) / viewport.zoom;
				drag.node.y += (p.y - drag.y) / viewport.zoom;
				const request: GraphWorkerRequest = { type: "drag", id: drag.node.id, x: drag.node.x, y: drag.node.y };
				worker.postMessage(request);
			} else {
				viewport.pan(p.x - drag.x, p.y - drag.y);
				history.push({ ...p, t: performance.now() });
				if (history.length > 4) history.shift();
			}
			drag.x = p.x;
			drag.y = p.y;
			invalidate();
			return;
		}
		const node = hit(p.x, p.y);
		hover.move(node?.id, performance.now());
		canvas.style.cursor = node ? "grab" : "default";
		invalidate();
	};
	const up = (event: PointerEvent) => {
		pointers.delete(event.pointerId);
		if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
		if (pinch) {
			if (pointers.size < 2) pinch = undefined;
			return;
		}
		if (!drag || drag.id !== event.pointerId) return;
		release();
		if (!drag.node && drag.moved && event.type !== "pointercancel") {
			const newest = history[history.length - 1],
				oldest = history[0];
			if (newest && oldest) {
				const dt = newest.t - oldest.t;
				if (dt > 0 && dt < 200)
					viewport.releaseWithVelocity(((newest.x - oldest.x) / dt) * 16, ((newest.y - oldest.y) / dt) * 16);
			}
		}
		drag = undefined;
		const p = point(event);
		canvas.style.cursor = hit(p.x, p.y) ? "grab" : "default";
		invalidate();
	};
	const click = (event: MouseEvent) => {
		if (dragged || event.detail > 1) return;
		const p = point(event);
		const node = hit(p.x, p.y);
		select(node && node !== selected ? node : undefined);
	};
	const doubleClick = (event: MouseEvent) => {
		const p = point(event);
		pauseFollow();
		zoom(1.5, p.x, p.y);
	};
	const leave = () => {
		if (!drag) {
			hover.clear();
			invalidate();
		}
	};
	const wheel = (event: WheelEvent) => {
		event.preventDefault();
		pauseFollow();
		const p = point(event);
		if (Math.abs(event.deltaX) > Math.abs(event.deltaY)) {
			viewport.pan(-event.deltaX, 0);
		} else {
			viewport.zoomImmediate(event.deltaY > 0 ? 0.97 : 1.03, p.x, p.y);
		}
		invalidate();
	};
	const siblings = (node: LayoutNode) => {
		const parent = parentOf.get(node.id);
		if (parent) return (childrenOf.get(parent) ?? []).filter(shown);
		return nodes
			.filter((other) => tierOf(other.kind) === 0 && shown(other))
			.sort(
				(a, b) =>
					(entityRank.get(a.id) ?? Number.POSITIVE_INFINITY) - (entityRank.get(b.id) ?? Number.POSITIVE_INFINITY),
			);
	};
	const step = (node: LayoutNode, offset: number) => {
		const list = siblings(node);
		const index = list.indexOf(node);
		return list[(index + offset + list.length) % list.length];
	};
	const key = (event: KeyboardEvent) => {
		const target = event.target;
		if (
			event.defaultPrevented ||
			event.isComposing ||
			event.ctrlKey ||
			event.metaKey ||
			event.altKey ||
			(target instanceof Element && target.closest("input, textarea, select, [contenteditable], [role=textbox]"))
		)
			return;
		const current = selected;
		const parent = current ? byId.get(parentOf.get(current.id) ?? "") : undefined;
		const child = current ? (childrenOf.get(current.id) ?? []).find(shown) : undefined;
		const actions: Record<string, (() => void) | undefined> = {
			z: () => fit(),
			c: center,
			"=": () => zoom(1.3),
			"+": () => zoom(1.3),
			"-": () => zoom(1 / 1.3),
			_: () => zoom(1 / 1.3),
			Escape: current ? () => select(undefined) : isolated ? () => isolate(null) : undefined,
			ArrowUp: parent ? () => selectAndCenter(parent) : undefined,
			ArrowDown: child ? () => selectAndCenter(child) : undefined,
			ArrowRight: current ? () => selectAndCenter(step(current, 1)) : undefined,
			ArrowLeft: current ? () => selectAndCenter(step(current, -1)) : undefined,
		};
		const action = actions[event.key.length === 1 ? event.key.toLowerCase() : event.key];
		if (!action) return;
		event.preventDefault();
		pauseFollow();
		action();
	};
	canvas.addEventListener("pointerdown", down);
	canvas.addEventListener("pointermove", move);
	canvas.addEventListener("pointerup", up);
	canvas.addEventListener("pointercancel", up);
	canvas.addEventListener("pointerleave", leave);
	canvas.addEventListener("wheel", wheel, { passive: false });
	canvas.addEventListener("click", click);
	canvas.addEventListener("dblclick", doubleClick);
	window.addEventListener("keydown", key);
	const resize = new ResizeObserver(() => {
		width = Math.max(1, container.clientWidth);
		height = Math.max(1, container.clientHeight);
		const ratio = Math.min(devicePixelRatio || 1, 2);
		canvas.width = Math.round(width * ratio);
		canvas.height = Math.round(height * ratio);
		if (followAgent && retrieved.size)
			fit(nodes.filter((node) => retrieved.has(node.id) || retrievedNeighbors.has(node.id)));
		else if (selected) focusNode(selected.id);
		else fit();
		if (frame) cancelAnimationFrame(frame);
		draw(performance.now());
	});
	resize.observe(container);
	const theme = new MutationObserver(invalidate);
	theme.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
	const deadline = setTimeout(() => {
		worker.terminate();
		onError?.();
	}, 15_000);
	worker.onmessage = (event: MessageEvent<GraphWorkerResponse>) => {
		if (disposed) return;
		clearTimeout(deadline);
		canvas.setAttribute("aria-busy", "false");
		if (nodes.length) {
			targets = new Map(event.data.nodes.map((node) => [node.id, { x: node.x, y: node.y }]));
			if (framing && !selected && !isolated && !retrieved.size) fit(nodes, false);
			if (!event.data.active) framing = false;
			invalidate();
			return;
		}
		canvas.dataset.layout = event.data.origin;
		framing = event.data.active;
		nodes = event.data.nodes;
		byId = new Map(nodes.map((node) => [node.id, node]));
		const clusterSize = new Map<string, number>();
		for (const node of nodes) clusterSize.set(node.cluster, (clusterSize.get(node.cluster) ?? 0) + 1);
		entityRank = new Map(
			nodes
				.filter((node) => node.kind === "entity")
				.sort((a, b) => b.weight - a.weight || (clusterSize.get(b.id) ?? 0) - (clusterSize.get(a.id) ?? 0))
				.map((node, index) => [node.id, index]),
		);
		edges = data.edges.flatMap((edge) => {
			const from = byId.get(edge.from),
				to = byId.get(edge.to);
			return from && to ? [{ edge, from, to }] : [];
		});
		parentOf = new Map();
		childrenOf = new Map();
		for (const { edge, from, to } of edges) {
			if (edge.kind === "depends_on" || parentOf.has(to.id) || tierOf(to.kind) === 0) continue;
			parentOf.set(to.id, from.id);
			const list = childrenOf.get(from.id);
			if (list) list.push(to);
			else childrenOf.set(from.id, [to]);
		}
		fit(nodes, false);
	};
	worker.onerror = () => {
		clearTimeout(deadline);
		worker.terminate();
		onError?.();
	};
	const request: GraphWorkerRequest = { type: "init", data, layoutScope };
	worker.postMessage(request);
	return {
		setRetrieval: (nodeIds, evidenceRefs) => {
			const matched = matchRetrievedNodes(data.nodes, nodeIds, evidenceRefs);
			for (const id of pendingRetrieval?.ids ?? []) matched.add(id);
			pendingRetrieval = { ids: matched, at: pendingRetrieval?.at ?? performance.now() + 180 };
			invalidate();
		},
		clearRetrieval: () => {
			pendingRetrieval = undefined;
			retrieved.clear();
			retrievedNeighbors.clear();
			followDue = false;
			canvas.dataset.retrievedNodes = "0";
			invalidate();
		},
		setFollowAgent: (enabled) => {
			followAgent = enabled;
			if (enabled) lastFollow = -Infinity;
			followDue = enabled && retrieved.size > 0;
			if (!enabled) viewport.cancelAnimation();
			invalidate();
		},
		focusNode,
		resetView,
		clearSelection,
		fit: () => fit(),
		center,
		focusable: () => nodes.map((node) => node.id),
		zoom,
		setHiddenKinds: (kinds) => {
			hiddenKinds = new Set(kinds);
			invalidate();
		},
		isolate,
		dispose: () => {
			if (disposed) return;
			disposed = true;
			clearTimeout(deadline);
			worker.terminate();
			resize.disconnect();
			theme.disconnect();
			cancelAnimationFrame(frame);
			canvas.removeEventListener("pointerdown", down);
			canvas.removeEventListener("pointermove", move);
			canvas.removeEventListener("pointerup", up);
			canvas.removeEventListener("pointercancel", up);
			canvas.removeEventListener("pointerleave", leave);
			canvas.removeEventListener("wheel", wheel);
			canvas.removeEventListener("click", click);
			window.removeEventListener("keydown", key);
			canvas.removeEventListener("dblclick", doubleClick);
			canvas.remove();
			tooltip.remove();
		},
	};
}

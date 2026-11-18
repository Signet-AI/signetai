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
import { categoryColor } from "./entity-category";
import { glPainter } from "./graph-gl";
import { GraphHoverIntent } from "./graph-hover";
import type { LayoutNode } from "./graph-layout";
import { canvasPainter, type Context2D, type GraphPainter, PAINT_SHAPES, type PaintShape } from "./graph-paint";
import type { GraphSceneData, SceneEdge, SceneNode, SceneNodeKind } from "./graph-scene";
import { ViewportState } from "./graph-viewport";
import type { GraphWorkerRequest, GraphWorkerResponse } from "./graph-worker";

export type Surface = HTMLCanvasElement | OffscreenCanvas;

export interface SimulationPort {
	postMessage(message: GraphWorkerRequest): void;
	onmessage: ((event: MessageEvent<GraphWorkerResponse>) => void) | null;
}

export type EngineCommand =
	| { type: "retrieval"; ids: readonly string[] }
	| { type: "clearRetrieval" }
	| { type: "follow"; enabled: boolean }
	| { type: "focus"; id: string }
	| { type: "reset" }
	| { type: "clearSelection" }
	| { type: "fit" }
	| { type: "center" }
	| { type: "zoom"; factor: number }
	| { type: "hidden"; kinds: readonly SceneNodeKind[] }
	| { type: "isolate"; cluster: string | null };

export type EngineInput =
	| EngineCommand
	| { type: "resize"; width: number; height: number; ratio: number }
	| { type: "theme"; dark: boolean }
	| { type: "redraw" }
	| { type: "pointer"; phase: "down" | "move" | "up" | "cancel"; id: number; x: number; y: number; t: number }
	| { type: "leave" }
	| { type: "wheel"; x: number; y: number; dx: number; dy: number }
	| { type: "click"; x: number; y: number; detail: number }
	| { type: "dblclick"; x: number; y: number }
	| { type: "key"; key: string };

export type EngineOutput =
	| { type: "select"; id: string | null }
	| { type: "isolate"; cluster: string | null }
	| { type: "zoom"; percent: number }
	| { type: "navigate" }
	| { type: "hover"; id: string | null }
	| { type: "anchor"; x: number; y: number; reach: number }
	| { type: "cursor"; value: string }
	| { type: "attribute"; name: string; value: string }
	| { type: "keys"; keys: readonly string[] }
	| { type: "error" };

export interface EngineHost {
	emit(output: EngineOutput): void;
	frame(callback: (now: number) => void): number;
	cancel(frame: number): void;
	now(): number;
}

export interface GraphEngine {
	input(message: EngineInput): void;
	dispose(): void;
}

export const ENGINE_KEYS = ["z", "c", "=", "+", "-", "_"] as const;

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
const EDGE_BUCKETS = 40;
const ALPHA_BUCKETS = 64;
const DOT_DEVICE_RADIUS = 2;
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

const GLYPHS: Record<SceneNodeKind, { readonly shape: Exclude<PaintShape, "dot">; readonly filled: boolean }> = {
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

const SHAPE_INDEX = Object.fromEntries(PAINT_SHAPES.map((shape, index) => [shape, index])) as Record<
	PaintShape,
	number
>;

function pill(context: Context2D, x: number, y: number, w: number, h: number): void {
	const r = h / 2;
	context.moveTo(x + r, y);
	context.arcTo(x + w, y, x + w, y + h, r);
	context.arcTo(x + w, y + h, x, y + h, r);
	context.arcTo(x, y + h, x, y, r);
	context.arcTo(x, y, x + w, y, r);
	context.closePath();
}

export function nodeTint(node: SceneNode, dark: boolean): string {
	const colors = dark ? COLORS : LIGHT_COLORS;
	if (node.kind === "constraint" || node.kind === "origin" || node.kind === "memory" || !node.category)
		return colors[node.kind];
	return categoryColor(node.category, dark);
}

function context2d(surface: Surface): Context2D | null {
	return surface.getContext("2d") as Context2D | null;
}

export function createGraphEngine(
	surfaces: { readonly canvas: Surface; readonly overlay: Surface },
	data: GraphSceneData,
	simulation: SimulationPort,
	host: EngineHost,
	layoutScope?: string,
): GraphEngine {
	const gpu = glPainter(surfaces.canvas);
	const context = context2d(gpu ? surfaces.overlay : surfaces.canvas);
	if (!context) throw new Error("Canvas is unavailable");
	const painter: GraphPainter = gpu ?? canvasPainter(context);
	const attributes = new Map<string, string>();
	const attribute = (name: string, value: string) => {
		if (attributes.get(name) === value) return;
		attributes.set(name, value);
		host.emit({ type: "attribute", name, value });
	};
	attribute("data-renderer", gpu ? "webgl2" : "canvas");
	attribute("aria-busy", "true");
	let ratio = 1;
	let darkTheme = true;
	let hoverId: string | null = null;
	let anchor = "";
	let cursor = "";
	let keys = "";
	const setCursor = (value: string) => {
		if (value === cursor) return;
		cursor = value;
		host.emit({ type: "cursor", value });
	};
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
		host.emit({ type: "navigate" });
	};
	let lastDraw = host.now();
	let frame = 0;
	let disposed = false;
	const pointers = new Map<number, { x: number; y: number }>();
	let pinch: { distance: number; x: number; y: number } | undefined;
	let dragged = false;
	let parentOf = new Map<string, string>();
	let childrenOf = new Map<string, LayoutNode[]>();
	let percent = 0;
	let targets: Float64Array | undefined;
	let history: Array<{ x: number; y: number; t: number }> = [];
	let drag:
		| { id: number; x: number; y: number; startX: number; startY: number; moved: boolean; node?: LayoutNode }
		| undefined;
	let hiddenKinds = new Set<SceneNodeKind>();
	let isolated: string | undefined;
	let entityRank = new Map<string, number>();
	let indexOf = new Map<string, number>();
	let bodyIndex = new Int32Array(0);
	let tints: [readonly string[], readonly string[]] = [[], []];
	let edgeFrom = new Int32Array(0);
	let edgeTo = new Int32Array(0);
	let edgeLocal = new Uint8Array(0);
	let edgeTint: [Int32Array, Int32Array] = [new Int32Array(0), new Int32Array(0)];
	let palette: [readonly string[], readonly string[]] = [[], []];
	let labelCandidates: number[] = [];
	const labelLive = new Set<number>();
	let reveal = new Float64Array(0);
	let nodeAlpha = new Float64Array(0);
	let ring = new Float64Array(0);
	let labelAlpha = new Float64Array(0);
	let visibility = new Float64Array(0);
	let segments = new Float64Array(0);
	let points = new Float64Array(0);
	const tint = nodeTint;
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
				attribute("data-retrieved-nodes", String(retrieved.size));
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
		const ease = (previous: number, target: number) => {
			const value = Math.abs(previous - target) < 0.005 ? target : previous + (target - previous) * blend;
			if (value !== target) highlighting = true;
			return value;
		};
		const fade = (key: string, target: number, initial = 1) => {
			const value = ease(emphasis.get(key) ?? initial, target);
			emphasis.set(key, value);
			return value;
		};
		const fadeAt = (values: Float64Array, index: number, target: number) => {
			const value = ease(values[index] ?? 0, target);
			values[index] = value;
			return value;
		};
		let settling = false;
		if (targets) {
			for (const [index, node] of nodes.entries()) {
				if (drag?.node === node) continue;
				const tx = targets[index * 2] ?? node.x;
				const ty = targets[index * 2 + 1] ?? node.y;
				const dx = tx - node.x,
					dy = ty - node.y;
				if (Math.abs(dx) + Math.abs(dy) > 0.1) {
					node.x += dx * 0.35;
					node.y += dy * 0.35;
					settling = true;
				} else {
					node.x = tx;
					node.y = ty;
				}
			}
		}
		const dark = darkTheme;
		const tone = dark ? "dark" : "light";
		const shade = dark ? 1 : 0;
		const foreground = dark ? "#f4f4f5" : "#18181b";
		const active = (hover.active ? byId.get(hover.active) : undefined) ?? (retrieved.size ? undefined : selected);
		const hovered = hover.active ? byId.get(hover.active) : undefined;
		if (hoverId !== (hovered?.id ?? null)) {
			hoverId = hovered?.id ?? null;
			anchor = "";
			host.emit({ type: "hover", id: hoverId });
		}
		const focus = retrieved.size ? undefined : selected;
		const relevant = (node: LayoutNode) =>
			focus
				? node.id === focus.id || node.cluster === focus.cluster
				: !retrieved.size || retrieved.has(node.id) || retrievedNeighbors.has(node.id);
		const level = detail();
		const appear = fade("appear", 1, 0);
		const dim = fade("dim", focus || retrieved.size ? 1 : 0, 0);
		const recalled = retrieved.size > 0;
		const tierVisibility = [detailVisibility(0, level), detailVisibility(1, level), detailVisibility(2, level)];
		for (const [index, node] of nodes.entries()) {
			const revealed = fadeAt(
				reveal,
				index,
				(active && node.cluster === active.cluster) ||
					(recalled && (retrieved.has(node.id) || retrievedNeighbors.has(node.id)))
					? 1
					: 0,
			);
			visibility[index] = shown(node) ? Math.max(tierVisibility[tierOf(node.kind)] ?? 1, revealed) : 0;
		}
		const z = viewport.zoom;
		painter.begin({ ratio, panX: viewport.panX, panY: viewport.panY, zoom: z }, width, height);
		if (gpu) {
			context.setTransform(ratio, 0, 0, ratio, 0, 0);
			context.clearRect(0, 0, width, height);
		}
		const spokes = new Map<number, number[]>();
		const bridges = new Map<number, number[]>();
		const highlightedEdges: Array<{ key: string; from: LayoutNode; to: LayoutNode; dependency: boolean }> = [];
		const hoveredIndex = hovered ? (indexOf.get(hovered.id) ?? -1) : -1;
		const focusIndex = focus ? (indexOf.get(focus.id) ?? -1) : -1;
		const bridgeFade = 1 - 0.6 * smoothstep(1.5, 4, level);
		const spokeBase = dark ? 0.22 : 0.2;
		const dependencyBase = (dark ? 0.34 : 0.3) * bridgeFade;
		const bridgeBase = (dark ? 0.12 : 0.1) * bridgeFade;
		for (const [index, { edge, from, to }] of edges.entries()) {
			const f = edgeFrom[index] ?? 0;
			const t = edgeTo[index] ?? 0;
			const vis = Math.min(visibility[f] ?? 0, visibility[t] ?? 0);
			if (vis < 0.02) continue;
			const highlighted = active
				? (hoveredIndex >= 0 && (f === hoveredIndex || t === hoveredIndex)) ||
					(focusIndex >= 0 && (f === focusIndex || t === focusIndex))
				: recalled && (retrieved.has(from.id) || retrieved.has(to.id));
			if (highlighted) {
				highlightedEdges.push({
					key: `edge:${edge.from}:${edge.to}:${edge.kind}`,
					from,
					to,
					dependency: edge.kind === "depends_on",
				});
				continue;
			}
			const local = edgeLocal[index] === 1;
			const muted = relevant(from) && relevant(to) ? 1 : 1 - dim * 0.8;
			const base = local ? spokeBase : edge.kind === "depends_on" ? dependencyBase : bridgeBase;
			const bucket = Math.round(Math.min(1, base * vis * muted) * EDGE_BUCKETS);
			if (bucket <= 0) continue;
			const groups = local ? spokes : bridges;
			const group = (local ? (edgeTint[shade][index] ?? 0) : 0) * (EDGE_BUCKETS + 1) + bucket;
			const list = groups.get(group);
			if (list) list.push(index);
			else groups.set(group, [index]);
		}
		const stroke = (groups: Map<number, number[]>, w: number, local: boolean) => {
			for (const [group, list] of groups) {
				const bucket = group % (EDGE_BUCKETS + 1);
				const color = local ? (palette[shade][Math.floor(group / (EDGE_BUCKETS + 1))] ?? BRIDGE[tone]) : BRIDGE[tone];
				let count = 0;
				for (const index of list) {
					const from = nodes[edgeFrom[index] ?? 0];
					const to = nodes[edgeTo[index] ?? 0];
					if (!from || !to) continue;
					segments[count * 4] = from.x;
					segments[count * 4 + 1] = from.y;
					segments[count * 4 + 2] = to.x;
					segments[count * 4 + 3] = to.y;
					count++;
				}
				painter.lines(segments, count, color, (bucket / EDGE_BUCKETS) * appear, w);
			}
		};
		stroke(spokes, 0.75, true);
		stroke(bridges, 1, false);
		const accent = retrieved.size && !active ? RETRIEVAL[tone] : active ? tint(active, dark) : foreground;
		for (const { key, from, to, dependency } of highlightedEdges) {
			let arrow: number[] | undefined;
			if (dependency) {
				const angle = Math.atan2(to.y - from.y, to.x - from.x);
				const tipX = to.x - Math.cos(angle) * (radius(to) + 3 / z);
				const tipY = to.y - Math.sin(angle) * (radius(to) + 3 / z);
				arrow = [
					tipX - (Math.cos(angle - 0.5) * 6) / z,
					tipY - (Math.sin(angle - 0.5) * 6) / z,
					tipX,
					tipY,
					tipX - (Math.cos(angle + 0.5) * 6) / z,
					tipY - (Math.sin(angle + 0.5) * 6) / z,
				];
			}
			painter.highlight(from.x, from.y, to.x, to.y, arrow, accent, fade(key, 1, 0) * appear * 0.95, 1.4);
		}
		const surface = SURFACE[tone];
		const glyphs = new Map<string, { color: string; alpha: number; outlined: boolean; members: number[] }>();
		const radii = new Float64Array(nodes.length);
		const shapes = new Uint8Array(nodes.length);
		const marked: number[] = [];
		for (const [index, node] of nodes.entries()) {
			const vis = visibility[index] ?? 0;
			if (vis < 0.02) continue;
			const x = node.x * z + viewport.panX;
			const y = node.y * z + viewport.panY;
			if (x < -120 || x > width + 120 || y < -60 || y > height + 60) continue;
			const alpha = fadeAt(nodeAlpha, index, relevant(node) ? 1 : 1 - dim * 0.7) * vis * appear;
			const r = Math.min(Math.max(radius(node), screenRadius(node) / z), maxScreenRadius(node) / z);
			const color = recalled && retrieved.has(node.id) ? RETRIEVAL[tone] : (tints[shade][index] ?? tint(node, dark));
			const glyph = GLYPHS[node.kind];
			const legible = r * z >= GLYPH_SCREEN_RADIUS;
			const outlined = legible && !glyph.filled;
			const bucket = Math.round(alpha * ALPHA_BUCKETS);
			radii[index] = r;
			shapes[index] = SHAPE_INDEX[legible ? glyph.shape : r * z * ratio < DOT_DEVICE_RADIUS ? "dot" : "circle"];
			const ringed =
				fadeAt(
					ring,
					index,
					node.id === active?.id || node.id === focus?.id || (recalled && retrieved.has(node.id)) ? 1 : 0,
				) > 0.005;
			if (tierOf(node.kind) === 0 || ringed) marked.push(index);
			if (bucket <= 0) continue;
			const key = `${color}|${bucket}|${outlined ? 1 : 0}`;
			const batch = glyphs.get(key);
			if (batch) batch.members.push(index);
			else glyphs.set(key, { color, alpha: bucket / ALPHA_BUCKETS, outlined, members: [index] });
		}
		const outline = { surface, width: 1.2 };
		for (const { color, alpha, outlined, members } of glyphs.values()) {
			let count = 0;
			for (const index of members) {
				const node = nodes[index];
				if (!node) continue;
				points[count * 4] = node.x;
				points[count * 4 + 1] = node.y;
				points[count * 4 + 2] = radii[index] ?? 0;
				points[count * 4 + 3] = shapes[index] ?? 0;
				count++;
			}
			painter.glyphs(points, count, color, alpha, outlined ? outline : undefined);
		}
		for (const index of marked) {
			const node = nodes[index];
			if (!node) continue;
			const r = radii[index] ?? 0;
			const alpha = (nodeAlpha[index] ?? 1) * (visibility[index] ?? 0) * appear;
			const color = recalled && retrieved.has(node.id) ? RETRIEVAL[tone] : (tints[shade][index] ?? tint(node, dark));
			if (tierOf(node.kind) === 0)
				painter.ring(
					node.x,
					node.y,
					r + 2.5 / z,
					node.scopeColor ?? color,
					alpha * (node.scopeColor ? 0.9 : 0.45),
					1.25,
				);
			const ringed = ring[index] ?? 0;
			if (ringed > 0.005)
				painter.selection(
					node.x,
					node.y,
					r + 6 / z,
					retrieved.has(node.id) ? RETRIEVAL[tone] : foreground,
					ringed * appear,
				);
		}
		painter.end();
		const occupied: Array<{ x: number; y: number; w: number; h: number }> = [];
		const free = (x: number, y: number, w: number, h: number) =>
			!occupied.some((box) => x < box.x + box.w + 6 && x + w + 6 > box.x && y < box.y + box.h && y + h > box.y);
		const sourceCount = labelCandidates.reduce((count, index) => count + (nodes[index]?.kind === "source" ? 1 : 0), 0);
		const labelSources = sourceCount <= MAX_SOURCE_LABELS || z >= overviewZoom * SOURCE_LABEL_ZOOM;
		const entityBudget = Math.round(BASE_ENTITY_LABELS * level * level);
		let sourceLabels = 0;
		const candidates = new Set<number>([...labelCandidates, ...labelLive]);
		for (const node of [active, hovered]) {
			const index = node ? indexOf.get(node.id) : undefined;
			if (index !== undefined) candidates.add(index);
		}
		if (recalled) {
			for (const id of retrieved) {
				const index = indexOf.get(id);
				if (index !== undefined) candidates.add(index);
			}
		}
		const ranked = [...candidates]
			.sort((a, b) => a - b)
			.flatMap((index) => nodes[index] ?? [])
			.sort((a, b) => labelPriority(b, active) - labelPriority(a, active));
		for (const node of ranked) {
			const index = indexOf.get(node.id) ?? -1;
			if ((visibility[index] ?? 0) < 0.5) continue;
			const focused = node.id === active?.id || node.id === hovered?.id;
			const visible =
				focused ||
				(recalled && retrieved.has(node.id)) ||
				(node.kind === "entity" && (entityRank.get(node.id) ?? Number.POSITIVE_INFINITY) < entityBudget) ||
				(node.kind === "source" && labelSources && sourceLabels < MAX_SOURCE_LABELS);
			const shownAlpha = fadeAt(labelAlpha, index, visible ? 1 : 0);
			if (shownAlpha > 0) labelLive.add(index);
			else labelLive.delete(index);
			if (shownAlpha < 0.005) continue;
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
			context.globalAlpha = shownAlpha * (focused ? 1 : (nodeAlpha[index] ?? 1)) * appear;
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
			host.emit({ type: "zoom", percent: zoomed });
		}
		if (hovered) {
			const x = hovered.x * z + viewport.panX;
			const y = hovered.y * z + viewport.panY;
			const reach =
				Math.min(Math.max(radius(hovered), screenRadius(hovered) / z), maxScreenRadius(hovered) / z) * z + 12;
			const at = `${x}|${y}|${reach}`;
			if (at !== anchor) {
				anchor = at;
				host.emit({ type: "anchor", x, y, reach });
			}
		}
		if (moving || settling || highlighting) invalidate();
	};
	const invalidate = () => {
		if (!disposed && !frame) frame = host.frame(draw);
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
		host.emit({ type: "select", id: node?.id ?? null });
		invalidate();
	};
	const selectAndCenter = (node: LayoutNode | undefined) => {
		if (!node) return;
		select(node);
		viewport.centerOn(node.x, node.y, width, height);
	};
	const isolate = (cluster: string | null) => {
		isolated = cluster ?? undefined;
		host.emit({ type: "isolate", cluster });
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
			host.emit({ type: "isolate", cluster: null });
		}
		selected = undefined;
		hover.clear();
		fit();
		host.emit({ type: "select", id: null });
	};
	const zoom = (factor: number, x = width / 2, y = height / 2) => {
		viewport.zoomTo(viewport.zoom * factor, x, y);
		invalidate();
	};
	const hittable = (node: LayoutNode) =>
		shown(node) &&
		(interactive(tierOf(node.kind), detail()) || (selected !== undefined && node.cluster === selected.cluster));
	const hit = (x: number, y: number) => {
		for (let index = nodes.length - 1; index >= 0; index--) {
			const node = nodes[index];
			if (!node) continue;
			const dx = node.x * viewport.zoom + viewport.panX - x;
			const dy = node.y * viewport.zoom + viewport.panY - y;
			const reach = Math.max(8, radius(node) * viewport.zoom + 3);
			if (dx * dx + dy * dy <= reach * reach && hittable(node)) return node;
		}
		return undefined;
	};
	const release = () => {
		if (!drag?.node || !drag.moved) return;
		const index = indexOf.get(drag.node.id);
		if (targets && index !== undefined) {
			targets[index * 2] = drag.node.x;
			targets[index * 2 + 1] = drag.node.y;
		}
		const request: GraphWorkerRequest = { type: "release", id: drag.node.id };
		simulation.postMessage(request);
	};
	const spread = () => {
		const [a, b] = [...pointers.values()];
		if (!a || !b) return undefined;
		return { distance: Math.hypot(b.x - a.x, b.y - a.y), x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
	};
	const down = (id: number, p: { x: number; y: number }, t: number) => {
		pauseFollow();
		pointers.set(id, p);
		viewport.cancelAnimation();
		if (pointers.size >= 2) {
			release();
			drag = undefined;
			pinch = spread();
			dragged = true;
			return;
		}
		history = [{ ...p, t }];
		dragged = false;
		const node = hit(p.x, p.y);
		drag = { id, ...p, startX: p.x, startY: p.y, moved: false, node };
		if (!node) setCursor("grabbing");
	};
	const move = (id: number, p: { x: number; y: number }, t: number) => {
		if (pointers.has(id)) pointers.set(id, p);
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
			if (drag.id !== id) return;
			if (!drag.moved && Math.hypot(p.x - drag.startX, p.y - drag.startY) < 4) return;
			drag.moved = true;
			dragged = true;
			setCursor("grabbing");
			if (drag.node) {
				drag.node.x += (p.x - drag.x) / viewport.zoom;
				drag.node.y += (p.y - drag.y) / viewport.zoom;
				const request: GraphWorkerRequest = { type: "drag", id: drag.node.id, x: drag.node.x, y: drag.node.y };
				simulation.postMessage(request);
			} else {
				viewport.pan(p.x - drag.x, p.y - drag.y);
				history.push({ ...p, t });
				if (history.length > 4) history.shift();
			}
			drag.x = p.x;
			drag.y = p.y;
			invalidate();
			return;
		}
		const node = hit(p.x, p.y);
		hover.move(node?.id, t);
		setCursor(node ? "grab" : "default");
		invalidate();
	};
	const up = (id: number, p: { x: number; y: number }, cancelled: boolean) => {
		pointers.delete(id);
		if (pinch) {
			if (pointers.size < 2) pinch = undefined;
			return;
		}
		if (!drag || drag.id !== id) return;
		release();
		if (!drag.node && drag.moved && !cancelled) {
			const newest = history[history.length - 1],
				oldest = history[0];
			if (newest && oldest) {
				const dt = newest.t - oldest.t;
				if (dt > 0 && dt < 200)
					viewport.releaseWithVelocity(((newest.x - oldest.x) / dt) * 16, ((newest.y - oldest.y) / dt) * 16);
			}
		}
		drag = undefined;
		setCursor(hit(p.x, p.y) ? "grab" : "default");
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
	const actions = (): Record<string, (() => void) | undefined> => {
		const current = selected;
		const parent = current ? byId.get(parentOf.get(current.id) ?? "") : undefined;
		const child = current ? (childrenOf.get(current.id) ?? []).find(shown) : undefined;
		return {
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
	};
	const announce = () => {
		const available = Object.entries(actions()).flatMap(([name, action]) => (action ? [name] : []));
		const joined = available.join(" ");
		if (joined === keys) return;
		keys = joined;
		host.emit({ type: "keys", keys: available });
	};
	const deadline = setTimeout(() => host.emit({ type: "error" }), 15_000);
	simulation.onmessage = (event: MessageEvent<GraphWorkerResponse>) => {
		if (disposed) return;
		clearTimeout(deadline);
		attribute("aria-busy", "false");
		const { xy } = event.data;
		if (nodes.length) {
			targets = xy;
			if (framing && !selected && !isolated && !retrieved.size) fit(nodes, false);
			if (!event.data.active) framing = false;
			invalidate();
			announce();
			return;
		}
		attribute("data-layout", event.data.origin);
		attribute("data-layout-engine", event.data.engine);
		framing = event.data.active;
		nodes = data.nodes.map((node, index) => ({ ...node, x: xy[index * 2] ?? 0, y: xy[index * 2 + 1] ?? 0 }));
		byId = new Map(nodes.map((node) => [node.id, node]));
		indexOf = new Map(nodes.map((node, index) => [node.id, index]));
		bodyIndex = Int32Array.from(nodes, (node) => indexOf.get(bodyOf(node)) ?? 0);
		tints = [nodes.map((node) => tint(node, false)), nodes.map((node) => tint(node, true))];
		labelCandidates = nodes.flatMap((node, index) => (tierOf(node.kind) === 0 ? [index] : []));
		labelLive.clear();
		reveal = new Float64Array(nodes.length);
		nodeAlpha = new Float64Array(nodes.length).fill(1);
		ring = new Float64Array(nodes.length);
		labelAlpha = new Float64Array(nodes.length);
		visibility = new Float64Array(nodes.length);
		points = new Float64Array(nodes.length * 4);
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
		segments = new Float64Array(edges.length * 4);
		edgeFrom = Int32Array.from(edges, ({ from }) => indexOf.get(from.id) ?? 0);
		edgeTo = Int32Array.from(edges, ({ to }) => indexOf.get(to.id) ?? 0);
		edgeLocal = Uint8Array.from(edges, (_, index) =>
			bodyIndex[edgeFrom[index] ?? 0] === bodyIndex[edgeTo[index] ?? 0] ? 1 : 0,
		);
		const colors = (shade: 0 | 1) => {
			const list: string[] = [];
			const slot = new Map<string, number>();
			const indices = Int32Array.from(edges, (_, index) => {
				const color = tints[shade][bodyIndex[edgeFrom[index] ?? 0] ?? 0] ?? BRIDGE.dark;
				let at = slot.get(color);
				if (at === undefined) {
					at = list.length;
					slot.set(color, at);
					list.push(color);
				}
				return at;
			});
			return { list, indices };
		};
		const light = colors(0);
		const dark = colors(1);
		palette = [light.list, dark.list];
		edgeTint = [light.indices, dark.indices];
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
		announce();
	};
	const input = (message: EngineInput) => {
		if (disposed) return;
		switch (message.type) {
			case "resize": {
				width = Math.max(1, message.width);
				height = Math.max(1, message.height);
				ratio = message.ratio;
				for (const surface of [surfaces.canvas, surfaces.overlay]) {
					surface.width = Math.round(width * ratio);
					surface.height = Math.round(height * ratio);
				}
				if (followAgent && retrieved.size)
					fit(nodes.filter((node) => retrieved.has(node.id) || retrievedNeighbors.has(node.id)));
				else if (selected) focusNode(selected.id);
				else fit();
				if (frame) host.cancel(frame);
				draw(host.now());
				break;
			}
			case "theme":
				darkTheme = message.dark;
				invalidate();
				break;
			case "redraw":
				invalidate();
				break;
			case "pointer": {
				const p = { x: message.x, y: message.y };
				if (message.phase === "down") down(message.id, p, message.t);
				else if (message.phase === "move") move(message.id, p, message.t);
				else up(message.id, p, message.phase === "cancel");
				break;
			}
			case "leave":
				if (!drag) {
					hover.clear();
					invalidate();
				}
				break;
			case "wheel":
				pauseFollow();
				if (Math.abs(message.dx) > Math.abs(message.dy)) viewport.pan(-message.dx, 0);
				else viewport.zoomImmediate(message.dy > 0 ? 0.97 : 1.03, message.x, message.y);
				invalidate();
				break;
			case "click": {
				if (dragged || message.detail > 1) break;
				const node = hit(message.x, message.y);
				select(node && node !== selected ? node : undefined);
				break;
			}
			case "dblclick":
				pauseFollow();
				zoom(1.5, message.x, message.y);
				break;
			case "key": {
				const action = actions()[message.key];
				if (!action) break;
				pauseFollow();
				action();
				break;
			}
			case "retrieval": {
				const matched = new Set(message.ids);
				for (const id of pendingRetrieval?.ids ?? []) matched.add(id);
				pendingRetrieval = { ids: matched, at: pendingRetrieval?.at ?? host.now() + 180 };
				invalidate();
				break;
			}
			case "clearRetrieval":
				pendingRetrieval = undefined;
				retrieved.clear();
				retrievedNeighbors.clear();
				followDue = false;
				attribute("data-retrieved-nodes", "0");
				invalidate();
				break;
			case "follow":
				followAgent = message.enabled;
				if (message.enabled) lastFollow = -Infinity;
				followDue = message.enabled && retrieved.size > 0;
				if (!message.enabled) viewport.cancelAnimation();
				invalidate();
				break;
			case "focus":
				focusNode(message.id);
				break;
			case "reset":
				resetView();
				break;
			case "clearSelection":
				clearSelection();
				break;
			case "fit":
				fit();
				break;
			case "center":
				center();
				break;
			case "zoom":
				zoom(message.factor);
				break;
			case "hidden":
				hiddenKinds = new Set(message.kinds);
				invalidate();
				break;
			case "isolate":
				isolate(message.cluster);
				break;
		}
		announce();
	};
	const request: GraphWorkerRequest = { type: "init", data, layoutScope };
	simulation.postMessage(request);
	return {
		input,
		dispose: () => {
			if (disposed) return;
			disposed = true;
			clearTimeout(deadline);
			if (frame) host.cancel(frame);
			simulation.onmessage = null;
		},
	};
}

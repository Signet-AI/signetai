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
	focusable(): readonly string[];
	zoom(factor: number): void;
	setHiddenKinds(kinds: readonly SceneNodeKind[]): void;
	isolate(cluster: string | null): void;
	dispose(): void;
}

const COLORS: Record<SceneNodeKind, string> = {
	entity: "#f4f4f5",
	source: "#7c9dff",
	aspect: "#a1a1aa",
	group: "#a1a1aa",
	claimSlot: "#d9a650",
	attribute: "#d9a650",
	claim: "#d9a650",
	constraint: "#e27b7f",
	assertion: "#d9a650",
	origin: "#71717a",
	memory: "#71717a",
};

const LIGHT_COLORS: Record<SceneNodeKind, string> = {
	entity: "#18181b",
	source: "#3b63d9",
	aspect: "#71717a",
	group: "#71717a",
	claimSlot: "#a16207",
	attribute: "#a16207",
	claim: "#a16207",
	constraint: "#be123c",
	assertion: "#a16207",
	origin: "#a1a1aa",
	memory: "#a1a1aa",
};

const RETRIEVAL = { dark: "#7c9dff", light: "#3b63d9" } as const;
const SURFACE = { dark: "#101214", light: "#f5f7f9" } as const;
const MAX_SOURCE_LABELS = 20;
const SOURCE_LABEL_ZOOM = 3;

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
	if (tier === 1) return smoothstep(1.35, 2.1, detail);
	return smoothstep(2.4, 3.6, detail);
}

function labelPriority(node: LayoutNode, active: LayoutNode | undefined): number {
	if (node.id === active?.id) return 4;
	if (node.kind === "entity") return 2 + node.weight;
	if (node.kind === "source") return 1 + node.weight;
	return node.weight;
}

export function createGraphScene(
	container: HTMLElement,
	data: GraphSceneData,
	onSelect?: (node: SceneNode) => void,
	onError?: () => void,
	onUserNavigation?: () => void,
	onIsolate?: (cluster: string | null) => void,
): GraphSceneHandle {
	const canvas = document.createElement("canvas");
	canvas.tabIndex = 0;
	canvas.setAttribute("aria-busy", "true");
	canvas.setAttribute(
		"aria-label",
		"Memory graph. Drag to pan, scroll to zoom. Arrow keys browse nodes, Enter selects, Escape resets.",
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
	const pauseFollow = () => {
		followAgent = false;
		followDue = false;
		viewport.cancelAnimation();
		onUserNavigation?.();
	};
	let lastDraw = performance.now();
	let neighbors = new Set<string>();
	let frame = 0;
	let disposed = false;
	let keyboardIndex = -1;
	let targets = new Map<string, { x: number; y: number }>();
	let history: Array<{ x: number; y: number; t: number }> = [];
	let drag:
		| { id: number; x: number; y: number; startX: number; startY: number; moved: boolean; node?: LayoutNode }
		| undefined;
	let hiddenKinds = new Set<SceneNodeKind>();
	let isolated: string | undefined;
	const radius = (node: SceneNode) =>
		node.kind === "entity"
			? 5 + 4 * Math.min(1, Math.max(0, node.weight))
			: node.kind === "source"
				? 5
				: tierOf(node.kind) === 1
					? 4
					: 3;
	const screenRadius = (node: SceneNode) =>
		node.kind === "entity" ? 3.5 + 2 * Math.min(1, Math.max(0, node.weight)) : node.kind === "source" ? 2.5 : 1.5;
	const detail = () => (Number.isFinite(overviewZoom) && overviewZoom > 0 ? viewport.zoom / overviewZoom : 1);
	const shown = (node: LayoutNode) =>
		!hiddenKinds.has(node.kind) && (!isolated || node.cluster === isolated || node.id === isolated);
	const showTooltip = (node?: LayoutNode) => {
		tooltip.hidden = !node;
		if (!node) return;
		tooltip.replaceChildren();
		const kind = document.createElement("span");
		kind.className = "graph-tooltip-kind";
		kind.style.color = (document.documentElement.classList.contains("dark") ? COLORS : LIGHT_COLORS)[node.kind];
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
		const foreground = dark ? "#e4e4e7" : "#18181b";
		const colors = dark ? COLORS : LIGHT_COLORS;
		const active = (hover.active ? byId.get(hover.active) : undefined) ?? (retrieved.size ? undefined : selected);
		const hovered = hover.active ? byId.get(hover.active) : undefined;
		if (tooltip.dataset.node !== (hovered?.id ?? "")) {
			showTooltip(hovered);
			tooltip.dataset.node = hovered?.id ?? "";
		}
		const relevant = (node: LayoutNode) =>
			active
				? node.id === active.id || node.cluster === active.cluster
				: !retrieved.size || retrieved.has(node.id) || retrievedNeighbors.has(node.id);
		const level = detail();
		const appear = fade("appear", 1, 0);
		const dim = fade("dim", active || retrieved.size ? 1 : 0, 0);
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
		const neutral = dark ? "#a1a1aa" : "#52525b";
		const baseAlpha = dark ? 0.13 : 0.18;
		context.save();
		context.translate(viewport.panX, viewport.panY);
		context.scale(viewport.zoom, viewport.zoom);
		const buckets = new Map<number, Array<{ from: LayoutNode; to: LayoutNode }>>();
		const highlightedEdges: Array<{ key: string; from: LayoutNode; to: LayoutNode; dependency: boolean }> = [];
		for (const { edge, from, to } of edges) {
			const vis = Math.min(visibility.get(from.id) ?? 0, visibility.get(to.id) ?? 0);
			if (vis < 0.02) continue;
			const highlighted = active
				? (from.id === active.id || to.id === active.id) && edge.kind !== "depends_on"
				: retrieved.has(from.id) || retrieved.has(to.id);
			if (highlighted) {
				highlightedEdges.push({
					key: `edge:${edge.from}:${edge.to}:${edge.kind}`,
					from,
					to,
					dependency: edge.kind === "depends_on",
				});
				continue;
			}
			const weight = (edge.kind === "depends_on" ? 1.8 : 1) * (from.cluster === to.cluster ? 1 : 0.45);
			const muted = relevant(from) && relevant(to) ? 1 : 1 - dim * 0.75;
			const alpha = Math.min(1, baseAlpha * weight * vis * muted);
			const bucket = Math.round(alpha * 40);
			if (bucket <= 0) continue;
			const list = buckets.get(bucket);
			if (list) list.push({ from, to });
			else buckets.set(bucket, [{ from, to }]);
		}
		context.strokeStyle = neutral;
		context.lineWidth = 1 / viewport.zoom;
		for (const [bucket, list] of buckets) {
			context.globalAlpha = (bucket / 40) * appear;
			context.beginPath();
			for (const { from, to } of list) {
				context.moveTo(from.x, from.y);
				context.lineTo(to.x, to.y);
			}
			context.stroke();
		}
		const accent = retrieved.size && !active ? RETRIEVAL[dark ? "dark" : "light"] : colors[active?.kind ?? "entity"];
		context.strokeStyle = accent;
		context.lineWidth = 1.5 / viewport.zoom;
		for (const { key, from, to, dependency } of highlightedEdges) {
			context.globalAlpha = fade(key, 0.85, 0) * appear;
			context.beginPath();
			context.moveTo(from.x, from.y);
			context.lineTo(to.x, to.y);
			if (dependency) {
				const angle = Math.atan2(to.y - from.y, to.x - from.x);
				const tipX = to.x - Math.cos(angle) * (radius(to) + 3 / viewport.zoom);
				const tipY = to.y - Math.sin(angle) * (radius(to) + 3 / viewport.zoom);
				context.moveTo(
					tipX - (Math.cos(angle - 0.5) * 6) / viewport.zoom,
					tipY - (Math.sin(angle - 0.5) * 6) / viewport.zoom,
				);
				context.lineTo(tipX, tipY);
				context.lineTo(
					tipX - (Math.cos(angle + 0.5) * 6) / viewport.zoom,
					tipY - (Math.sin(angle + 0.5) * 6) / viewport.zoom,
				);
			}
			context.stroke();
		}
		const surface = SURFACE[dark ? "dark" : "light"];
		for (const node of nodes) {
			const vis = visibility.get(node.id) ?? 0;
			if (vis < 0.02) continue;
			const x = node.x * viewport.zoom + viewport.panX;
			const y = node.y * viewport.zoom + viewport.panY;
			if (x < -120 || x > width + 120 || y < -40 || y > height + 40) continue;
			const alpha = fade(`node:${node.id}`, relevant(node) ? 1 : dark ? 0.2 : 0.28) * vis * appear;
			context.globalAlpha = alpha;
			const r = Math.max(radius(node), screenRadius(node) / viewport.zoom);
			context.beginPath();
			if (node.kind === "source") context.rect(node.x - r, node.y - r, r * 2, r * 2);
			else context.arc(node.x, node.y, r, 0, Math.PI * 2);
			context.fillStyle = node.kind === "entity" ? (node.scopeColor ?? colors[node.kind]) : colors[node.kind];
			context.fill();
			if (tierOf(node.kind) === 0) {
				context.strokeStyle = surface;
				context.lineWidth = 2 / viewport.zoom;
				context.stroke();
			}
			if (node.scopeColor && node.kind !== "entity") {
				context.strokeStyle = node.scopeColor;
				context.lineWidth = 1.25 / viewport.zoom;
				context.stroke();
			}
			const ring = fade(`ring:${node.id}`, node.id === active?.id || retrieved.has(node.id) ? 1 : 0, 0);
			if (ring > 0.005) {
				context.globalAlpha = ring * appear;
				context.strokeStyle = retrieved.has(node.id) ? RETRIEVAL[dark ? "dark" : "light"] : foreground;
				context.lineWidth = 1.5 / viewport.zoom;
				context.beginPath();
				context.arc(node.x, node.y, r + 4 / viewport.zoom, 0, Math.PI * 2);
				context.stroke();
			}
		}
		context.restore();
		const occupied: Array<{ x: number; y: number; w: number }> = [];
		const sourceCount = nodes.reduce((count, node) => count + (node.kind === "source" ? 1 : 0), 0);
		const labelSources = sourceCount <= MAX_SOURCE_LABELS || viewport.zoom >= overviewZoom * SOURCE_LABEL_ZOOM;
		let sourceLabels = 0;
		for (const node of [...nodes].sort((a, b) => labelPriority(b, active) - labelPriority(a, active))) {
			if ((visibility.get(node.id) ?? 0) < 0.5) continue;
			const visible =
				node.id === active?.id ||
				retrieved.has(node.id) ||
				node.kind === "entity" ||
				(node.kind === "source" && labelSources && sourceLabels < MAX_SOURCE_LABELS) ||
				((viewport.zoom > 1.1 || active) &&
					node.cluster === active?.cluster &&
					node.kind !== "origin" &&
					node.kind !== "memory");
			const labelAlpha = fade(`label:${node.id}`, visible ? 1 : 0, 0);
			if (labelAlpha < 0.005) continue;
			const x = node.x * viewport.zoom + viewport.panX + radius(node) * viewport.zoom + 5;
			const y = node.y * viewport.zoom + viewport.panY;
			if (x < 0 || x > width || y < 55 || y > height - 100) continue;
			const text = node.label.length > 30 ? `${node.label.slice(0, 29)}…` : node.label;
			context.font =
				node.id === active?.id || node.kind === "entity"
					? "500 12px 'Schibsted Grotesk', sans-serif"
					: "11px 'Schibsted Grotesk', sans-serif";
			const w = context.measureText(text).width;
			if (occupied.some((label) => Math.abs(label.y - y) < 16 && x < label.x + label.w + 10 && x + w + 10 > label.x))
				continue;
			occupied.push({ x, y, w });
			if (node.kind === "source") sourceLabels++;
			context.globalAlpha = labelAlpha * (emphasis.get(`node:${node.id}`) ?? 1) * appear;
			context.lineJoin = "round";
			context.lineWidth = 3.5;
			context.strokeStyle = surface;
			context.strokeText(text, x, y + 4);
			context.fillStyle = foreground;
			context.fillText(text, x, y + 4);
		}
		context.globalAlpha = 1;
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
		const bounds = framed.map((node) => ({ x: node.x, y: node.y, size: radius(node) + 30 }));
		viewport.setMinZoomForNodes(
			nodes.map((node) => ({ x: node.x, y: node.y, size: radius(node) })),
			width,
			height,
		);
		viewport.fitToNodes(bounds, available, height, { animate });
		if (overview) overviewZoom = viewport.restingZoom;
		invalidate();
	};
	const focusNode = (id: string) => {
		selected = byId.get(id);
		hover.clear();
		if (!selected) return;
		neighbors = new Set(
			edges.filter(({ from, to }) => from.id === id || to.id === id).flatMap(({ from, to }) => [from.id, to.id]),
		);
		fit(
			nodes.filter((node) =>
				selected?.kind === "entity"
					? node.cluster === selected.cluster && !["memory", "origin", "assertion"].includes(node.kind)
					: node.id === id || neighbors.has(node.id),
			),
		);
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
		neighbors.clear();
		showTooltip();
		fit();
	};
	const zoom = (factor: number, x = width / 2, y = height / 2) => {
		viewport.zoomTo(viewport.zoom * factor, x, y);
		invalidate();
	};
	const point = (event: PointerEvent | WheelEvent) => {
		const rect = canvas.getBoundingClientRect();
		return { x: event.clientX - rect.left, y: event.clientY - rect.top };
	};
	const hittable = (node: LayoutNode) =>
		shown(node) &&
		(tierOf(node.kind) === 0 ||
			detailVisibility(tierOf(node.kind), detail()) > 0.3 ||
			(selected !== undefined && node.cluster === selected.cluster));
	const hit = (x: number, y: number) =>
		[...nodes]
			.reverse()
			.find(
				(node) =>
					hittable(node) &&
					Math.hypot(node.x * viewport.zoom + viewport.panX - x, node.y * viewport.zoom + viewport.panY - y) <=
						Math.max(8, radius(node) * viewport.zoom + 3),
			);
	const select = (node: LayoutNode) => {
		focusNode(node.id);
		onSelect?.(node);
	};
	const down = (event: PointerEvent) => {
		pauseFollow();
		const p = point(event);
		history = [{ ...p, t: performance.now() }];
		drag = { id: event.pointerId, ...p, startX: p.x, startY: p.y, moved: false, node: hit(p.x, p.y) };
		viewport.cancelAnimation();
		canvas.setPointerCapture(event.pointerId);
		canvas.focus();
	};
	const move = (event: PointerEvent) => {
		const p = point(event);
		if (drag) {
			if (drag.id !== event.pointerId) return;
			if (!drag.moved && Math.hypot(p.x - drag.startX, p.y - drag.startY) < 4) return;
			drag.moved = true;
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
		canvas.style.cursor = node ? "pointer" : "grab";
		invalidate();
	};
	const up = (event: PointerEvent) => {
		if (!drag || drag.id !== event.pointerId) return;
		if (event.type !== "pointercancel" && !drag.moved && drag.node) select(drag.node);
		if (drag.node && drag.moved) {
			targets.set(drag.node.id, { x: drag.node.x, y: drag.node.y });
			const request: GraphWorkerRequest = { type: "release", id: drag.node.id };
			worker.postMessage(request);
		}
		if (!drag.node && event.type !== "pointercancel") {
			const newest = history[history.length - 1],
				oldest = history[0];
			if (newest && oldest) {
				const dt = newest.t - oldest.t;
				if (dt > 0 && dt < 200)
					viewport.releaseWithVelocity(((newest.x - oldest.x) / dt) * 16, ((newest.y - oldest.y) / dt) * 16);
			}
			invalidate();
		}
		drag = undefined;
		if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
	};
	const doubleClick = (event: MouseEvent) => {
		const rect = canvas.getBoundingClientRect();
		const node = hit(event.clientX - rect.left, event.clientY - rect.top);
		if (node && (node.kind === "entity" || node.kind === "source")) {
			pauseFollow();
			isolate(node.cluster);
		}
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
	const key = (event: KeyboardEvent) => {
		if (["ArrowRight", "ArrowDown", "ArrowLeft", "ArrowUp", "Enter", "Escape", "+", "=", "-"].includes(event.key))
			pauseFollow();
		if (["ArrowRight", "ArrowDown", "ArrowLeft", "ArrowUp"].includes(event.key)) {
			event.preventDefault();
			keyboardIndex =
				(keyboardIndex + (event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1 : 1) + nodes.length) % nodes.length;
			const node = nodes[keyboardIndex];
			if (node) focusNode(node.id);
		}
		if (event.key === "Enter" && selected) select(selected);
		if (event.key === "Escape") resetView();
		if (event.key === "+" || event.key === "=") zoom(1.25);
		if (event.key === "-") zoom(0.8);
	};
	canvas.addEventListener("pointerdown", down);
	canvas.addEventListener("pointermove", move);
	canvas.addEventListener("pointerup", up);
	canvas.addEventListener("pointercancel", up);
	canvas.addEventListener("pointerleave", leave);
	canvas.addEventListener("wheel", wheel, { passive: false });
	canvas.addEventListener("keydown", key);
	canvas.addEventListener("dblclick", doubleClick);
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
			invalidate();
			return;
		}
		nodes = event.data.nodes;
		byId = new Map(nodes.map((node) => [node.id, node]));
		edges = data.edges.flatMap((edge) => {
			const from = byId.get(edge.from),
				to = byId.get(edge.to);
			return from && to ? [{ edge, from, to }] : [];
		});
		fit(nodes, false);
	};
	worker.onerror = () => {
		clearTimeout(deadline);
		worker.terminate();
		onError?.();
	};
	const request: GraphWorkerRequest = { type: "init", data };
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
			canvas.removeEventListener("keydown", key);
			canvas.removeEventListener("dblclick", doubleClick);
			canvas.remove();
			tooltip.remove();
		},
	};
}

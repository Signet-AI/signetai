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
	dispose(): void;
}

const COLORS: Record<SceneNodeKind, string> = {
	entity: "#a1a1aa",
	source: "#38bdf8",
	aspect: "#34d399",
	group: "#60a5fa",
	claimSlot: "#f59e0b",
	attribute: "#a78bfa",
	claim: "#fbbf24",
	constraint: "#fb7185",
	assertion: "#f472b6",
	origin: "#22d3ee",
	memory: "#22d3ee",
};

const LIGHT_COLORS: Record<SceneNodeKind, string> = {
	entity: "#27272a",
	source: "#0369a1",
	aspect: "#047857",
	group: "#1d4ed8",
	claimSlot: "#b45309",
	attribute: "#6d28d9",
	claim: "#a16207",
	constraint: "#be123c",
	assertion: "#a21caf",
	origin: "#0e7490",
	memory: "#0e7490",
};

export function createGraphScene(
	container: HTMLElement,
	data: GraphSceneData,
	onSelect?: (node: SceneNode) => void,
	onError?: () => void,
	onUserNavigation?: () => void,
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
	const radius = (node: SceneNode) =>
		node.kind === "entity" || node.kind === "source" ? 9 : node.kind === "aspect" ? 6 : 4;
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
		if (tooltip.dataset.node !== active?.id) {
			showTooltip(active);
			tooltip.dataset.node = active?.id ?? "";
		}
		const relevant = (node: LayoutNode) =>
			active
				? node.id === active.id || node.cluster === active.cluster
				: !retrieved.size || retrieved.has(node.id) || retrievedNeighbors.has(node.id);
		context.save();
		context.translate(viewport.panX, viewport.panY);
		context.scale(viewport.zoom, viewport.zoom);
		for (const { edge, from, to } of edges) {
			const highlighted = active
				? (from.id === active.id || to.id === active.id) && edge.kind !== "depends_on"
				: retrieved.has(from.id) || retrieved.has(to.id);
			context.globalAlpha = fade(
				`edge:${edge.from}:${edge.to}:${edge.kind}`,
				highlighted
					? 0.8
					: (active || retrieved.size) && (!relevant(from) || !relevant(to))
						? dark
							? 0.08
							: 0.15
						: edge.kind === "depends_on"
							? dark
								? 0.3
								: 0.45
							: dark
								? 0.4
								: 0.55,
				dark ? 0.4 : 0.55,
			);
			context.strokeStyle = highlighted
				? colors[active?.kind ?? "memory"]
				: edge.kind === "depends_on"
					? foreground
					: colors[to.kind];
			context.lineWidth = (highlighted ? 1.7 : 1) / viewport.zoom;
			context.setLineDash(
				edge.kind === "evidenced_by" || edge.kind === "asserted_by" ? [3 / viewport.zoom, 4 / viewport.zoom] : [],
			);
			context.beginPath();
			context.moveTo(from.x, from.y);
			context.lineTo(to.x, to.y);
			context.stroke();
			if (edge.kind === "depends_on") {
				const angle = Math.atan2(to.y - from.y, to.x - from.x);
				const tipX = to.x - Math.cos(angle) * (radius(to) + 3 / viewport.zoom);
				const tipY = to.y - Math.sin(angle) * (radius(to) + 3 / viewport.zoom);
				context.beginPath();
				context.moveTo(
					tipX - (Math.cos(angle - 0.5) * 6) / viewport.zoom,
					tipY - (Math.sin(angle - 0.5) * 6) / viewport.zoom,
				);
				context.lineTo(tipX, tipY);
				context.lineTo(
					tipX - (Math.cos(angle + 0.5) * 6) / viewport.zoom,
					tipY - (Math.sin(angle + 0.5) * 6) / viewport.zoom,
				);
				context.stroke();
			}
		}
		context.setLineDash([]);
		for (const node of nodes) {
			const x = node.x * viewport.zoom + viewport.panX;
			const y = node.y * viewport.zoom + viewport.panY;
			if (x < -120 || x > width + 120 || y < -40 || y > height + 40) continue;
			context.globalAlpha = fade(`node:${node.id}`, relevant(node) ? 1 : dark ? 0.16 : 0.25);
			context.fillStyle = node.kind === "entity" ? foreground : colors[node.kind];
			context.beginPath();
			if (node.kind === "origin" || node.kind === "memory" || node.kind === "source") {
				const r = radius(node);
				context.rect(node.x - r, node.y - r, r * 2, r * 2);
			} else {
				context.arc(node.x, node.y, radius(node), 0, Math.PI * 2);
			}
			context.fill();
			const ring = fade(`ring:${node.id}`, node.id === active?.id || retrieved.has(node.id) ? 1 : 0, 0);
			if (ring > 0.005) {
				context.globalAlpha = ring;
				context.strokeStyle = retrieved.has(node.id) ? colors.memory : foreground;
				context.lineWidth = 1.5 / viewport.zoom;
				context.beginPath();
				context.arc(node.x, node.y, radius(node) + 4 / viewport.zoom, 0, Math.PI * 2);
				context.stroke();
			}
		}
		context.restore();
		const occupied: Array<{ x: number; y: number; w: number }> = [];
		const sourceCount = nodes.reduce((count, node) => count + (node.kind === "source" ? 1 : 0), 0);
		const labelSources = sourceCount <= MAX_SOURCE_LABELS || viewport.zoom >= overviewZoom * SOURCE_LABEL_ZOOM;
		let sourceLabels = 0;
		for (const node of [...nodes].sort((a, b) => labelPriority(b, active) - labelPriority(a, active))) {
			const visible =
				node.id === active?.id ||
				retrieved.has(node.id) ||
				node.kind === "entity" ||
				(node.kind === "source" && labelSources && sourceLabels < MAX_SOURCE_LABELS) ||
				((viewport.zoom > 1.1 || active) && node.cluster === active?.cluster);
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
			context.globalAlpha = labelAlpha * (emphasis.get(`node:${node.id}`) ?? 1);
			context.fillStyle = dark ? "#101113" : "#fafafa";
			context.fillRect(x - 2, y - 9, w + 4, 17);
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
		const bounds = subset.map((node) => ({ x: node.x, y: node.y, size: radius(node) + 30 }));
		viewport.setMinZoomForNodes(
			nodes.map((node) => ({ x: node.x, y: node.y, size: radius(node) })),
			width,
			height,
		);
		viewport.fitToNodes(bounds, available, height, { animate });
		if (subset === nodes) overviewZoom = viewport.restingZoom;
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
		showTooltip(selected);
	};
	const resetView = () => {
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
	const hit = (x: number, y: number) =>
		[...nodes]
			.reverse()
			.find(
				(node) =>
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
	const leave = () => {
		if (!drag) {
			hover.clear();
			showTooltip(selected);
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
			canvas.remove();
			tooltip.remove();
		},
	};
}

const MAX_SOURCE_LABELS = 20;
const SOURCE_LABEL_ZOOM = 3;

function labelPriority(node: LayoutNode, active: LayoutNode | undefined): number {
	if (node.id === active?.id) return 4;
	if (node.kind === "entity") return 2 + node.weight;
	if (node.kind === "source") return 1 + node.weight;
	return node.weight;
}

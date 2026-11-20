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
import type { EntityCategory } from "./entity-category";
import {
	createGraphEngine,
	ENGINE_KEYS,
	type EngineInput,
	type EngineOutput,
	type GraphEngine,
	nodeTint,
} from "./graph-engine";
import type { FontSource, RenderWorkerRequest } from "./graph-render-worker";
import type { GraphWorkerRequest } from "./graph-worker";

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
	createdAt?: number;
	updatedAt?: number;
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
	setColors(colors: ReadonlyMap<string, string> | null): void;
	dispose(): void;
}

const LABEL_FONT = "Schibsted Grotesk";
const LABEL_WEIGHTS = new Set(["400", "500", "normal"]);

function fontSources(): FontSource[] {
	const fonts: FontSource[] = [];
	for (const sheet of Array.from(document.styleSheets)) {
		let rules: CSSRuleList;
		try {
			rules = sheet.cssRules;
		} catch {
			continue;
		}
		for (const rule of Array.from(rules)) {
			if (!(rule instanceof CSSFontFaceRule)) continue;
			const family = rule.style.getPropertyValue("font-family").replace(/["']/g, "").trim();
			const weight = rule.style.getPropertyValue("font-weight").trim() || "400";
			if (family !== LABEL_FONT || !LABEL_WEIGHTS.has(weight)) continue;
			const base = sheet.href ?? document.baseURI;
			const source = rule.style
				.getPropertyValue("src")
				.replace(/url\((["']?)([^"')]+)\1\)/g, (_, _quote: string, url: string) => `url("${new URL(url, base).href}")`);
			const range = rule.style.getPropertyValue("unicode-range").trim();
			fonts.push({
				family,
				source,
				descriptors: {
					weight,
					style: rule.style.getPropertyValue("font-style").trim() || "normal",
					...(range ? { unicodeRange: range } : {}),
				},
			});
		}
	}
	return fonts;
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
	canvas.setAttribute(
		"aria-label",
		"Memory graph. Drag to pan, scroll to zoom, click a node to select it. With a node selected, arrow keys move between related nodes. Z fits, C centers, Escape clears the selection.",
	);
	canvas.style.cssText = "width:100%;height:100%;display:block;touch-action:none;";
	const overlay = document.createElement("canvas");
	overlay.setAttribute("aria-hidden", "true");
	overlay.style.cssText = "position:absolute;inset:0;width:100%;height:100%;pointer-events:none;";
	const tooltip = document.createElement("div");
	tooltip.className = "graph-tooltip";
	tooltip.hidden = true;
	tooltip.setAttribute("role", "status");
	container.append(canvas, overlay, tooltip);
	const byId = new Map(data.nodes.map((node) => [node.id, node]));
	const simulation = new Worker(new URL("./graph-worker.ts", import.meta.url), { type: "module" });
	let keys = new Set<string>(ENGINE_KEYS);
	let width = 1;
	let height = 1;
	let disposed = false;
	let failed = false;
	const dark = () => document.documentElement.classList.contains("dark");
	const fail = () => {
		if (failed || disposed) return;
		failed = true;
		simulation.terminate();
		renderer?.terminate();
		onError?.();
	};
	const showTooltip = (node: SceneNode | undefined) => {
		tooltip.hidden = true;
		tooltip.replaceChildren();
		if (!node) return;
		const kind = document.createElement("span");
		kind.className = "graph-tooltip-kind";
		kind.style.color = nodeTint(node, dark());
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
	const placeTooltip = (sx: number, sy: number, reach: number) => {
		if (!tooltip.childElementCount) return;
		tooltip.hidden = false;
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
	};
	const receive = (output: EngineOutput) => {
		if (disposed) return;
		switch (output.type) {
			case "select":
				onSelect?.(output.id ? (byId.get(output.id) ?? null) : null);
				break;
			case "isolate":
				onIsolate?.(output.cluster);
				break;
			case "zoom":
				onZoom?.(output.percent);
				break;
			case "navigate":
				onUserNavigation?.();
				break;
			case "hover":
				showTooltip(output.id ? byId.get(output.id) : undefined);
				break;
			case "anchor":
				placeTooltip(output.x, output.y, output.reach);
				break;
			case "cursor":
				canvas.style.cursor = output.value;
				break;
			case "attribute":
				canvas.setAttribute(output.name, output.value);
				break;
			case "keys":
				keys = new Set(output.keys);
				break;
			case "error":
				fail();
				break;
		}
	};
	let renderer: Worker | undefined;
	let engine: GraphEngine | undefined;
	const offscreen = typeof OffscreenCanvas !== "undefined" && typeof canvas.transferControlToOffscreen === "function";
	if (offscreen) {
		const worker = new Worker(new URL("./graph-render-worker.ts", import.meta.url), { type: "module" });
		renderer = worker;
		const channel = new MessageChannel();
		const connect: GraphWorkerRequest = { type: "connect", port: channel.port1 };
		simulation.postMessage(connect, [channel.port1]);
		const surface = canvas.transferControlToOffscreen();
		const labels = overlay.transferControlToOffscreen();
		worker.onmessage = (event: MessageEvent<EngineOutput>) => receive(event.data);
		worker.onerror = fail;
		const init: RenderWorkerRequest = {
			type: "init",
			canvas: surface,
			overlay: labels,
			simulation: channel.port2,
			data,
			layoutScope,
			fonts: fontSources(),
			timeOrigin: performance.timeOrigin,
			setup: [{ type: "theme", dark: dark() }],
		};
		worker.postMessage(init, [surface, labels, channel.port2]);
	} else {
		engine = createGraphEngine(
			{ canvas, overlay },
			data,
			simulation,
			{
				emit: receive,
				frame: (callback) => requestAnimationFrame(callback),
				cancel: (frame) => cancelAnimationFrame(frame),
				now: () => performance.now(),
			},
			layoutScope,
		);
		engine.input({ type: "theme", dark: dark() });
	}
	simulation.onerror = fail;
	const send = (input: EngineInput) => {
		if (disposed) return;
		if (engine) engine.input(input);
		else renderer?.postMessage({ type: "input", input } satisfies RenderWorkerRequest);
	};
	const point = (event: MouseEvent) => {
		const rect = canvas.getBoundingClientRect();
		return { x: event.clientX - rect.left, y: event.clientY - rect.top };
	};
	const pointer = (phase: "down" | "move" | "up" | "cancel", event: PointerEvent) =>
		send({ type: "pointer", phase, id: event.pointerId, ...point(event), t: performance.now() });
	const down = (event: PointerEvent) => {
		if (event.pointerType === "mouse" && event.button !== 0) return;
		canvas.setPointerCapture(event.pointerId);
		pointer("down", event);
	};
	const move = (event: PointerEvent) => pointer("move", event);
	const up = (event: PointerEvent) => {
		if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
		pointer(event.type === "pointercancel" ? "cancel" : "up", event);
	};
	const leave = () => send({ type: "leave" });
	const click = (event: MouseEvent) => send({ type: "click", ...point(event), detail: event.detail });
	const doubleClick = (event: MouseEvent) => send({ type: "dblclick", ...point(event) });
	const wheel = (event: WheelEvent) => {
		event.preventDefault();
		send({ type: "wheel", ...point(event), dx: event.deltaX, dy: event.deltaY });
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
		const name = event.key.length === 1 ? event.key.toLowerCase() : event.key;
		if (!keys.has(name)) return;
		event.preventDefault();
		send({ type: "key", key: name });
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
		send({ type: "resize", width, height, ratio: Math.min(devicePixelRatio || 1, 2) });
	});
	resize.observe(container);
	const theme = new MutationObserver(() => send({ type: "theme", dark: dark() }));
	theme.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
	return {
		setRetrieval: (nodeIds, evidenceRefs) =>
			send({ type: "retrieval", ids: [...matchRetrievedNodes(data.nodes, nodeIds, evidenceRefs)] }),
		clearRetrieval: () => send({ type: "clearRetrieval" }),
		setFollowAgent: (enabled) => send({ type: "follow", enabled }),
		focusNode: (id) => send({ type: "focus", id }),
		resetView: () => send({ type: "reset" }),
		clearSelection: () => send({ type: "clearSelection" }),
		fit: () => send({ type: "fit" }),
		center: () => send({ type: "center" }),
		focusable: () => data.nodes.map((node) => node.id),
		zoom: (factor) => send({ type: "zoom", factor }),
		setHiddenKinds: (kinds) => send({ type: "hidden", kinds }),
		isolate: (cluster) => send({ type: "isolate", cluster }),
		setColors: (colors) => send({ type: "colors", colors }),
		dispose: () => {
			if (disposed) return;
			engine?.dispose();
			disposed = true;
			renderer?.terminate();
			simulation.terminate();
			resize.disconnect();
			theme.disconnect();
			canvas.removeEventListener("pointerdown", down);
			canvas.removeEventListener("pointermove", move);
			canvas.removeEventListener("pointerup", up);
			canvas.removeEventListener("pointercancel", up);
			canvas.removeEventListener("pointerleave", leave);
			canvas.removeEventListener("wheel", wheel);
			canvas.removeEventListener("click", click);
			canvas.removeEventListener("dblclick", doubleClick);
			window.removeEventListener("keydown", key);
			canvas.remove();
			overlay.remove();
			tooltip.remove();
		},
	};
}

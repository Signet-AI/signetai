import { graphLayout } from "./graph-layout";
import type { LayoutNode } from "./graph-layout";
import { layoutCacheKey, readLayout, writeLayout, type CachedLayout } from "./graph-layout-cache";
import { type LayoutKernel, loadLayoutKernel } from "./graph-layout-kernel";
import { ForceSimulation, type LayoutEngine } from "./graph-simulation";
import type { GraphSceneData } from "./graph-scene";

export type GraphWorkerRequest =
	| { type: "init"; data: GraphSceneData; layoutScope?: string }
	| { type: "drag"; id: string; x: number; y: number }
	| { type: "release"; id: string }
	| { type: "connect"; port: MessagePort };
export type LayoutOrigin = "cached" | "partial" | "fresh" | "unavailable";
export interface GraphWorkerResponse {
	xy: Float64Array;
	active: boolean;
	origin: LayoutOrigin;
	engine: LayoutEngine;
}
const FRESH_TICKS = 12;
const NEW_NODE_HEAT = 0.1;
const LAYOUT_BUDGET_MS = 30_000;
const DRAG_BUDGET_MS = 8_000;
const SAVE_INTERVAL_MS = 2_000;

interface Channel {
	postMessage(message: GraphWorkerResponse, transfer: Transferable[]): void;
	onmessage: ((event: MessageEvent<GraphWorkerRequest>) => void) | null;
}

const simulation = new ForceSimulation();
const kernel: Promise<{ readonly kernel: LayoutKernel } | { readonly failure: unknown }> = fetch(
	new URL("./graph-layout.wasm", import.meta.url),
)
	.then((response) => {
		if (!response.ok) throw new Error(`HTTP ${response.status}`);
		return response.arrayBuffer();
	})
	.then(loadLayoutKernel)
	.then(
		(loaded) => ({ kernel: loaded }),
		(failure: unknown) => ({ failure }),
	);
let channel = self as unknown as Channel;
let nodes: LayoutNode[] = [];
let byId = new Map<string, LayoutNode>();
let origin: LayoutOrigin = "fresh";
let cacheKey: string | undefined;
let generation = 0;
let lastSave = 0;
let frame: ReturnType<typeof setTimeout> | undefined;
let deadline: ReturnType<typeof setTimeout> | undefined;
const publish = () => {
	const xy = new Float64Array(nodes.length * 2);
	for (const [index, node] of nodes.entries()) {
		xy[index * 2] = node.x;
		xy[index * 2 + 1] = node.y;
	}
	const response: GraphWorkerResponse = { xy, active: simulation.isActive(), origin, engine: simulation.engine() };
	channel.postMessage(response, [xy.buffer]);
};
const save = (heat = simulation.heat()) => {
	lastSave = performance.now();
	if (!cacheKey || !nodes.length) return;
	const key = cacheKey;
	writeLayout(key, nodes, heat).catch((error: unknown) => {
		if (cacheKey === key) cacheKey = undefined;
		console.warn("Graph layout cache write failed; layout caching is off until the graph reloads:", error);
	});
};
const stop = () => {
	const heat = simulation.heat();
	simulation.stop();
	for (const node of nodes) {
		node.fx = null;
		node.fy = null;
	}
	clearTimeout(frame);
	clearTimeout(deadline);
	frame = undefined;
	save(heat);
	publish();
};
const tick = () => {
	publish();
	frame = simulation.isActive() ? setTimeout(tick, 32) : undefined;
	if (frame && performance.now() - lastSave >= SAVE_INTERVAL_MS) save();
	if (!frame) {
		clearTimeout(deadline);
		save();
	}
};
const animate = (budget = DRAG_BUDGET_MS) => {
	if (!frame) frame = setTimeout(tick, 16);
	clearTimeout(deadline);
	deadline = setTimeout(stop, budget);
};
const restore = async (scope: string | undefined): Promise<CachedLayout | undefined | null> => {
	if (!scope) return undefined;
	try {
		cacheKey = await layoutCacheKey(scope);
		return await readLayout(cacheKey);
	} catch (error) {
		console.warn("Graph layout cache unavailable:", error);
		cacheKey = undefined;
		return null;
	}
};
const receive = async (event: MessageEvent<GraphWorkerRequest>) => {
	const request = event.data;
	if (request.type === "connect") {
		channel = request.port as unknown as Channel;
		channel.onmessage = receive;
		return;
	}
	if (request.type === "init") {
		const current = ++generation;
		clearTimeout(frame);
		clearTimeout(deadline);
		frame = undefined;
		cacheKey = undefined;
		const [cached, compiled] = await Promise.all([restore(request.layoutScope), kernel]);
		if (current !== generation) return;
		if ("failure" in compiled)
			console.warn("Graph layout kernel unavailable; laying out with d3-force:", compiled.failure);
		const layout = graphLayout(request.data, cached?.positions);
		nodes = layout.nodes;
		byId = new Map(nodes.map((node) => [node.id, node]));
		simulation.init(nodes, layout.edges, "kernel" in compiled ? compiled.kernel : undefined);
		lastSave = performance.now();
		const added = nodes.length - layout.reused;
		origin = cached === null ? "unavailable" : !layout.reused ? "fresh" : added ? "partial" : "cached";
		if (!layout.reused) {
			simulation.cool(1);
			simulation.tick(FRESH_TICKS);
		} else {
			simulation.cool(Math.max(cached?.heat ?? 0, added ? NEW_NODE_HEAT : 0));
		}
		publish();
		if (simulation.isActive()) animate(LAYOUT_BUDGET_MS);
		return;
	}
	const node = byId.get(request.id);
	if (!node) return;
	if (request.type === "drag") {
		node.fx = request.x;
		node.fy = request.y;
		simulation.reheat();
		animate();
		return;
	}
	node.fx = null;
	node.fy = null;
	simulation.coolDown();
	simulation.settle();
	animate();
};
self.onmessage = receive;

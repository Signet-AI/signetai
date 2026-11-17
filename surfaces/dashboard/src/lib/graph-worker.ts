import { graphLayout } from "./graph-layout";
import type { LayoutNode } from "./graph-layout";
import { layoutCacheKey, readLayout, writeLayout, type CachedLayout } from "./graph-layout-cache";
import { ForceSimulation } from "./graph-simulation";
import type { GraphSceneData } from "./graph-scene";

export type GraphWorkerRequest =
	| { type: "init"; data: GraphSceneData; layoutScope?: string }
	| { type: "drag"; id: string; x: number; y: number }
	| { type: "release"; id: string };
export type LayoutOrigin = "cached" | "partial" | "fresh" | "unavailable";
export interface GraphWorkerResponse {
	nodes: LayoutNode[];
	active: boolean;
	origin: LayoutOrigin;
}
const FRESH_TICKS = 12;
const NEW_NODE_HEAT = 0.1;
const LAYOUT_BUDGET_MS = 30_000;
const DRAG_BUDGET_MS = 8_000;
const SAVE_INTERVAL_MS = 2_000;

const simulation = new ForceSimulation();
let nodes: LayoutNode[] = [];
let byId = new Map<string, LayoutNode>();
let origin: LayoutOrigin = "fresh";
let cacheKey: string | undefined;
let generation = 0;
let lastSave = 0;
let frame: ReturnType<typeof setTimeout> | undefined;
let deadline: ReturnType<typeof setTimeout> | undefined;
const publish = () => self.postMessage({ nodes, active: simulation.isActive(), origin });
const save = (heat = simulation.heat()) => {
	lastSave = performance.now();
	if (!cacheKey || !nodes.length) return;
	writeLayout(cacheKey, nodes, heat).catch((error: unknown) => {
		console.warn("Graph layout cache write failed:", error);
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
self.onmessage = async (event: MessageEvent<GraphWorkerRequest>) => {
	const request = event.data;
	if (request.type === "init") {
		const current = ++generation;
		clearTimeout(frame);
		clearTimeout(deadline);
		frame = undefined;
		cacheKey = undefined;
		const cached = await restore(request.layoutScope);
		if (current !== generation) return;
		const layout = graphLayout(request.data, cached?.positions);
		nodes = layout.nodes;
		byId = new Map(nodes.map((node) => [node.id, node]));
		simulation.init(nodes, layout.edges);
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

import { graphLayout } from "./graph-layout";
import type { LayoutNode } from "./graph-layout";
import { ForceSimulation } from "./graph-simulation";
import type { GraphSceneData } from "./graph-scene";

export type GraphWorkerRequest =
	| { type: "init"; data: GraphSceneData }
	| { type: "drag"; id: string; x: number; y: number }
	| { type: "release"; id: string };
export interface GraphWorkerResponse {
	nodes: LayoutNode[];
	active: boolean;
}

const simulation = new ForceSimulation();
let nodes: LayoutNode[] = [];
let byId = new Map<string, LayoutNode>();
let frame: ReturnType<typeof setTimeout> | undefined;
let deadline: ReturnType<typeof setTimeout> | undefined;
const publish = () => self.postMessage({ nodes, active: simulation.isActive() });
const stop = () => {
	simulation.stop();
	for (const node of nodes) {
		node.fx = null;
		node.fy = null;
	}
	clearTimeout(frame);
	clearTimeout(deadline);
	frame = undefined;
	publish();
};
const tick = () => {
	publish();
	frame = simulation.isActive() ? setTimeout(tick, 32) : undefined;
	if (!frame) clearTimeout(deadline);
};
const animate = () => {
	if (!frame) frame = setTimeout(tick, 16);
	clearTimeout(deadline);
	deadline = setTimeout(stop, 8_000);
};
self.onmessage = (event: MessageEvent<GraphWorkerRequest>) => {
	const request = event.data;
	if (request.type === "init") {
		clearTimeout(frame);
		clearTimeout(deadline);
		const layout = graphLayout(request.data);
		nodes = layout.nodes;
		byId = new Map(nodes.map((node) => [node.id, node]));
		simulation.init(nodes, layout.edges);
		publish();
		animate();
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

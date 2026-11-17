import type { SimulationLinkDatum, SimulationNodeDatum } from "d3-force";
import { ForceSimulation } from "./graph-simulation";
import type { GraphSceneData, SceneEdge, SceneNode } from "./graph-scene";

export interface LayoutNode extends SceneNode, SimulationNodeDatum {
	x: number;
	y: number;
}

export interface LayoutEdge extends SceneEdge, SimulationLinkDatum<LayoutNode> {}

export type LayoutPositions = ReadonlyMap<string, { readonly x: number; readonly y: number }>;

const NEIGHBOR_OFFSET = 24;
export function graphLayout(
	data: GraphSceneData,
	cached: LayoutPositions = new Map(),
): { nodes: LayoutNode[]; edges: LayoutEdge[]; reused: number } {
	const neighbors = new Map<string, string[]>();
	for (const edge of data.edges) {
		for (const [from, to] of [
			[edge.from, edge.to],
			[edge.to, edge.from],
		]) {
			const list = neighbors.get(from);
			if (list) list.push(to);
			else neighbors.set(from, [to]);
		}
	}
	const placed = new Map<string, { x: number; y: number }>();
	for (const node of data.nodes) {
		const known = cached.get(node.id);
		if (known) placed.set(node.id, known);
	}
	const reused = placed.size;
	const queue = [...placed.keys()];
	for (let index = 0; index < queue.length; index++) {
		const anchor = placed.get(queue[index] ?? "");
		if (!anchor) continue;
		for (const id of neighbors.get(queue[index] ?? "") ?? []) {
			if (placed.has(id)) continue;
			const angle = placed.size * 2.4;
			placed.set(id, {
				x: anchor.x + Math.cos(angle) * NEIGHBOR_OFFSET,
				y: anchor.y + Math.sin(angle) * NEIGHBOR_OFFSET,
			});
			queue.push(id);
		}
	}
	const nodes: LayoutNode[] = data.nodes.map((node, index) => {
		const position = placed.get(node.id);
		const angle = index * 2.4;
		return position
			? { ...node, x: position.x, y: position.y }
			: { ...node, x: Math.cos(angle) * Math.sqrt(index) * 15, y: Math.sin(angle) * Math.sqrt(index) * 15 };
	});
	const ids = new Set(nodes.map((node) => node.id));
	const edges = data.edges
		.filter((edge) => ids.has(edge.from) && ids.has(edge.to))
		.map((edge) => ({ ...edge, source: edge.from, target: edge.to }));
	return { nodes, edges, reused };
}

export function layoutGraph(data: GraphSceneData): LayoutNode[] {
	const layout = graphLayout(data);
	const simulation = new ForceSimulation();
	simulation.init(layout.nodes, layout.edges);
	simulation.cool(1);
	simulation.tick(12);
	simulation.destroy();
	return layout.nodes;
}

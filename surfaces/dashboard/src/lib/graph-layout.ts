import type { SimulationLinkDatum, SimulationNodeDatum } from "d3-force";
import { ForceSimulation } from "./graph-simulation";
import type { GraphSceneData, SceneEdge, SceneNode } from "./graph-scene";

export interface LayoutNode extends SceneNode, SimulationNodeDatum {
	x: number;
	y: number;
}

export interface LayoutEdge extends SceneEdge, SimulationLinkDatum<LayoutNode> {}

export function graphLayout(data: GraphSceneData): { nodes: LayoutNode[]; edges: LayoutEdge[] } {
	const nodes: LayoutNode[] = data.nodes.map((node, index) => ({
		...node,
		x: Math.cos(index * 2.4) * Math.sqrt(index) * 15,
		y: Math.sin(index * 2.4) * Math.sqrt(index) * 15,
	}));
	const ids = new Set(nodes.map((node) => node.id));
	const edges = data.edges
		.filter((edge) => ids.has(edge.from) && ids.has(edge.to))
		.map((edge) => ({ ...edge, source: edge.from, target: edge.to }));
	return { nodes, edges };
}

export function layoutGraph(data: GraphSceneData): LayoutNode[] {
	const layout = graphLayout(data);
	const simulation = new ForceSimulation();
	simulation.init(layout.nodes, layout.edges);
	simulation.destroy();
	return layout.nodes;
}

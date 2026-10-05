import type { SimulationLinkDatum, SimulationNodeDatum } from "d3-force";
import { ForceSimulation } from "./graph-simulation";
import type { GraphSceneData, SceneEdge, SceneNode } from "./graph-scene";

export interface LayoutNode extends SceneNode, SimulationNodeDatum {
	x: number;
	y: number;
}

export interface LayoutEdge extends SceneEdge, SimulationLinkDatum<LayoutNode> {}

const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));

function ringOf(node: SceneNode): number {
	if (node.kind === "aspect" || node.kind === "group") return 1;
	if (node.kind === "origin" || node.kind === "memory" || node.kind === "assertion") return 3;
	return 2;
}

function hashUnit(value: string): number {
	let hash = 2166136261;
	for (let i = 0; i < value.length; i++) hash = Math.imul(hash ^ value.charCodeAt(i), 16777619);
	return ((hash >>> 0) % 1000) / 1000;
}

function clusterRadius(size: number): number {
	return 24 + Math.sqrt(size) * 13;
}

function seedPositions(nodes: readonly SceneNode[]): Map<string, { x: number; y: number }> {
	const clusters = new Map<string, SceneNode[]>();
	for (const node of nodes) {
		const members = clusters.get(node.cluster);
		if (members) members.push(node);
		else clusters.set(node.cluster, [node]);
	}
	const ordered = [...clusters.entries()].sort((a, b) => b[1].length - a[1].length || (a[0] < b[0] ? -1 : 1));
	const positions = new Map<string, { x: number; y: number }>();
	let area = 0;
	ordered.forEach(([cluster, members], index) => {
		const radius = clusterRadius(members.length);
		area += Math.PI * (radius + 18) ** 2;
		const distance = index === 0 ? 0 : Math.sqrt(area / Math.PI);
		const cx = Math.cos(index * GOLDEN_ANGLE) * distance;
		const cy = Math.sin(index * GOLDEN_ANGLE) * distance;
		const anchor = members.find((member) => member.id === cluster);
		if (anchor) positions.set(anchor.id, { x: cx, y: cy });
		const rings = new Map<number, SceneNode[]>();
		for (const member of members) {
			if (member === anchor) continue;
			const ring = anchor ? ringOf(member) : 1;
			const list = rings.get(ring);
			if (list) list.push(member);
			else rings.set(ring, [member]);
		}
		for (const [ring, list] of rings) {
			const ringRadius = (radius * ring) / 3;
			list.forEach((member, slot) => {
				const noise = hashUnit(member.id);
				const angle = ((slot + (noise - 0.5) * 0.6) / list.length) * Math.PI * 2 + ring * 0.7;
				const distance = ringRadius * (0.86 + noise * 0.28);
				positions.set(member.id, { x: cx + Math.cos(angle) * distance, y: cy + Math.sin(angle) * distance });
			});
		}
	});
	return positions;
}

export function graphLayout(data: GraphSceneData): { nodes: LayoutNode[]; edges: LayoutEdge[] } {
	const seeds = seedPositions(data.nodes);
	const nodes: LayoutNode[] = data.nodes.map((node) => ({ ...node, ...(seeds.get(node.id) ?? { x: 0, y: 0 }) }));
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

import { type Simulation, forceCollide, forceLink, forceManyBody, forceSimulation, forceX, forceY } from "d3-force";
import type { GraphCanvasEdge, GraphCanvasNode } from "./types";

export interface ForceSimulationOptions {
	chargeStrength: number;
	linkDistance: number;
	linkStrength: number;
	collisionPadding: number;
	preSettleTicks: number;
}

const DEFAULT_OPTIONS: ForceSimulationOptions = {
	chargeStrength: -2000,
	linkDistance: 220,
	linkStrength: 0.15,
	collisionPadding: 18,
	preSettleTicks: 150,
};

export class KnowledgeForceSimulation {
	private sim: Simulation<GraphCanvasNode, GraphCanvasEdge> | null = null;
	private opts: ForceSimulationOptions = DEFAULT_OPTIONS;

	init(nodes: GraphCanvasNode[], edges: GraphCanvasEdge[], opts: Partial<ForceSimulationOptions> = {}): void {
		this.destroy();
		this.opts = { ...DEFAULT_OPTIONS, ...opts };
		const structuralEdges = edges.filter((edge) => !edge.visualOnly);
		for (const edge of structuralEdges) {
			edge.source = edge.sourceId;
			edge.target = edge.targetId;
		}
		this.sim = forceSimulation<GraphCanvasNode>(nodes)
			.alphaDecay(0.025)
			.alphaMin(0.001)
			.velocityDecay(0.45)
			.force(
				"link",
				forceLink<GraphCanvasNode, GraphCanvasEdge>(structuralEdges)
					.id((node) => node.id)
					.distance((edge) => edgeDistance(edge, this.opts.linkDistance))
					.strength((edge) => edgeStrength(edge, this.opts.linkStrength)),
			)
			.force("charge", forceManyBody<GraphCanvasNode>().strength(this.opts.chargeStrength))
			.force(
				"collide",
				forceCollide<GraphCanvasNode>((node) => node.size * 0.5 + this.opts.collisionPadding).strength(0.72),
			)
			.force("x", forceX<GraphCanvasNode>(0).strength(0.06))
			.force("y", forceY<GraphCanvasNode>(0).strength(0.06));

		this.sim.stop();
		this.sim.alpha(1);
		for (let i = 0; i < this.opts.preSettleTicks; i++) this.sim.tick();
		this.sim.alphaTarget(0).restart();
	}

	update(nodes: GraphCanvasNode[], edges: GraphCanvasEdge[]): void {
		if (!this.sim) return;
		this.sim.nodes(nodes);
		const link = this.sim.force<ReturnType<typeof forceLink<GraphCanvasNode, GraphCanvasEdge>>>("link");
		const structuralEdges = edges.filter((edge) => !edge.visualOnly);
		for (const edge of structuralEdges) {
			edge.source = edge.sourceId;
			edge.target = edge.targetId;
		}
		if (link) link.links(structuralEdges);
		this.sim.alpha(0.35).restart();
	}

	reheat(): void {
		this.sim?.alphaTarget(0.3).restart();
	}

	coolDown(): void {
		this.sim?.alphaTarget(0);
	}

	isActive(): boolean {
		return (this.sim?.alpha() ?? 0) > 0.001;
	}

	destroy(): void {
		this.sim?.stop();
		this.sim = null;
	}
}

function edgeDistance(edge: GraphCanvasEdge, fallback: number): number {
	if (edge.kind === "supports") return 64;
	if (edge.kind === "has_attribute") return 115;
	if (edge.kind === "has_aspect") return 180;
	if (edge.kind === "contains") return 170;
	if (edge.kind === "about") return 210;
	if (edge.kind === "updates" || edge.kind === "extends") return 78;
	return fallback;
}

function edgeStrength(edge: GraphCanvasEdge, fallback: number): number {
	if (edge.kind === "supports") return 0.34;
	if (edge.kind === "has_attribute") return 0.44;
	if (edge.kind === "has_aspect") return 0.34;
	if (edge.kind === "contains") return 0.16;
	if (edge.kind === "about") return Math.max(0.06, Math.min(edge.strength ?? fallback, 0.28));
	if (edge.kind === "updates" || edge.kind === "extends") return 0.3;
	return fallback;
}

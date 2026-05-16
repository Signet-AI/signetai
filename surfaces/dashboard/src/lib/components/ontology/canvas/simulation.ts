import { type Simulation, forceCollide, forceLink, forceManyBody, forceSimulation, forceX, forceY } from "d3-force";
import type { GraphCanvasEdge, GraphCanvasNode } from "./types";

export interface ForceSimulationOptions {
	chargeStrength: number;
	linkDistance: number;
	linkStrength: number;
	collisionPadding: number;
	preSettleTicks: number;
	maxActiveTicks: number;
	maxActiveMs: number;
}

const DEFAULT_OPTIONS: ForceSimulationOptions = {
	chargeStrength: -2000,
	linkDistance: 220,
	linkStrength: 0.15,
	collisionPadding: 18,
	preSettleTicks: 150,
	maxActiveTicks: 80,
	maxActiveMs: 1000,
};

export class KnowledgeForceSimulation {
	private sim: Simulation<GraphCanvasNode, GraphCanvasEdge> | null = null;
	private opts: ForceSimulationOptions = DEFAULT_OPTIONS;
	private activeTicks = 0;
	private activeStartedAt = 0;

	init(nodes: GraphCanvasNode[], edges: GraphCanvasEdge[], opts: Partial<ForceSimulationOptions> = {}): void {
		this.destroy();
		this.opts = { ...DEFAULT_OPTIONS, ...opts };
		const structuralEdges = structuralLinks(edges);
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
			.force("charge", forceManyBody<GraphCanvasNode>().strength((node) => this.opts.chargeStrength * chargeMultiplier(node)))
			.force(
				"collide",
				forceCollide<GraphCanvasNode>((node) => node.size * collideMultiplier(node) + this.opts.collisionPadding).strength(0.74),
			)
			.force("x", forceX<GraphCanvasNode>(0).strength(0.06))
			.force("y", forceY<GraphCanvasNode>(0).strength(0.06))
			.on("tick.signetBudget", () => this.enforceBudget());

		this.sim.stop();
		this.sim.alpha(1);
		for (let i = 0; i < this.opts.preSettleTicks; i++) this.sim.tick();
		this.restartWithBudget(0.22, 0);
	}

	update(nodes: GraphCanvasNode[], edges: GraphCanvasEdge[]): void {
		if (!this.sim) return;
		this.sim.nodes(nodes);
		const link = this.sim.force<ReturnType<typeof forceLink<GraphCanvasNode, GraphCanvasEdge>>>("link");
		if (link) link.links(structuralLinks(edges));
		this.restartWithBudget(0.22, 0);
	}

	reheat(): void {
		this.restartWithBudget(0.18, 0.12);
	}

	coolDown(): void {
		this.sim?.alphaTarget(0);
	}

	pause(): void {
		this.sim?.alphaTarget(0);
		this.sim?.alpha(0);
		this.sim?.stop();
	}

	isActive(): boolean {
		return (this.sim?.alpha() ?? 0) > 0.001;
	}

	destroy(): void {
		this.sim?.stop();
		this.sim = null;
	}

	private restartWithBudget(alpha: number, alphaTarget: number): void {
		if (!this.sim) return;
		this.activeTicks = 0;
		this.activeStartedAt = now();
		this.sim.alpha(Math.max(this.sim.alpha(), alpha)).alphaTarget(alphaTarget).restart();
	}

	private enforceBudget(): void {
		if (!this.sim) return;
		this.activeTicks += 1;
		if (this.activeTicks >= this.opts.maxActiveTicks || now() - this.activeStartedAt >= this.opts.maxActiveMs) {
			this.pause();
		}
	}
}

function edgeDistance(edge: GraphCanvasEdge, fallback: number): number {
	const sourceMass = endpointMass(edge.source);
	const targetMass = endpointMass(edge.target);
	const mass = Math.max(sourceMass, targetMass);
	const spread = Math.min(Math.max(endpointSize(edge.source), endpointSize(edge.target)) * 0.68 + mass * 190, 290);
	if (edge.kind === "supports") return 64;
	if (edge.kind === "has_attribute") return 115;
	if (edge.kind === "has_aspect") return 165 + spread;
	if (edge.kind === "contains") return 170;
	if (edge.kind === "about") return 260 + spread;
	if (edge.kind === "updates" || edge.kind === "extends") return 78;
	return fallback;
}

function endpointSize(value: string | GraphCanvasNode): number {
	return typeof value === "string" ? 0 : value.size;
}

function endpointMass(value: string | GraphCanvasNode): number {
	return typeof value === "string" ? 0 : value.mass ?? 0;
}

function chargeMultiplier(node: GraphCanvasNode): number {
	if (node.kind === "entity") return 0.72 + Math.pow(node.mass ?? 0, 1.18) * 8.2;
	if (node.kind === "aspect") return Math.min(1.16, 0.78 + node.size / 160);
	return 0.62;
}

function collideMultiplier(node: GraphCanvasNode): number {
	if (node.kind === "entity") return 0.62 + Math.pow(node.mass ?? 0, 1.08) * 1.65;
	if (node.kind === "aspect") return 0.58;
	return 0.5;
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

function structuralLinks(edges: GraphCanvasEdge[]): GraphCanvasEdge[] {
	return edges
		.filter((edge) => !edge.visualOnly)
		.map((edge) => ({
			...edge,
			source: edge.sourceId,
			target: edge.targetId,
		}));
}

function now(): number {
	return typeof performance === "undefined" ? Date.now() : performance.now();
}

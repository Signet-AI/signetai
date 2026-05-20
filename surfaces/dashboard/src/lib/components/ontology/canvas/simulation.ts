import { type Simulation, forceCollide, forceLink, forceManyBody, forceSimulation, forceX, forceY } from "d3-force";
import type { GraphCanvasEdge, GraphCanvasNode } from "./types";

export interface ForceSimulationOptions {
	chargeStrength: number;
	linkDistance: number;
	linkStrength: number;
	collisionPadding: number;
	solarPadding: number;
	solarStrength: number;
	preSettleTicks: number;
	maxActiveTicks: number;
	maxActiveMs: number;
}

const DEFAULT_OPTIONS: ForceSimulationOptions = {
	chargeStrength: -2000,
	linkDistance: 220,
	linkStrength: 0.15,
	collisionPadding: 18,
	solarPadding: 120,
	solarStrength: 0.34,
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
			.force(
				"charge",
				forceManyBody<GraphCanvasNode>().strength((node) => this.opts.chargeStrength * chargeMultiplier(node)),
			)
			.force(
				"collide",
				forceCollide<GraphCanvasNode>(
					(node) => node.size * collideMultiplier(node) + this.opts.collisionPadding,
				).strength(0.74),
			)
			.force("solar", forceSolarSystems().padding(this.opts.solarPadding).strength(this.opts.solarStrength))
			.force("x", forceX<GraphCanvasNode>((node) => node.zoneX ?? 0).strength(zoneStrength))
			.force("y", forceY<GraphCanvasNode>((node) => node.zoneY ?? 0).strength(zoneStrength))
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
	if (edge.kind === "has_aspect") return Math.max(230 + spread, endpointSystemRadius(edge.target) + 170);
	if (edge.kind === "contains") return 170;
	if (edge.kind === "about") return 260 + spread;
	if (edge.kind === "updates" || edge.kind === "extends") return 78;
	return fallback;
}

function endpointSize(value: string | GraphCanvasNode): number {
	return typeof value === "string" ? 0 : value.size;
}

function endpointMass(value: string | GraphCanvasNode): number {
	return typeof value === "string" ? 0 : (value.mass ?? 0);
}

function endpointSystemRadius(value: string | GraphCanvasNode): number {
	return typeof value === "string" ? 0 : (value.systemRadius ?? value.size);
}

function chargeMultiplier(node: GraphCanvasNode): number {
	if (node.kind === "entity") return 0.72 + (node.mass ?? 0) ** 1.18 * 8.2;
	if (node.kind === "aspect") return Math.min(1.16, 0.78 + node.size / 160);
	return 0.62;
}

function collideMultiplier(node: GraphCanvasNode): number {
	if (node.kind === "entity") return 0.62 + (node.mass ?? 0) ** 1.08 * 1.65;
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

function zoneStrength(node: GraphCanvasNode): number {
	if (node.kind === "entity" && node.zoneX !== undefined && node.zoneY !== undefined) return 0.085;
	return 0.028;
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

interface SolarSystemForce {
	(alpha: number): void;
	initialize(nodes: GraphCanvasNode[]): void;
	padding(value: number): SolarSystemForce;
	strength(value: number): SolarSystemForce;
}

function forceSolarSystems(): SolarSystemForce {
	let nodes: GraphCanvasNode[] = [];
	let padding = 120;
	let strength = 0.34;

	const force = ((alpha: number) => {
		const entities = nodes.filter((node) => node.kind === "entity");
		for (let i = 0; i < entities.length; i++) {
			const a = entities[i];
			if (!a) continue;
			for (let j = i + 1; j < entities.length; j++) {
				const b = entities[j];
				if (!b) continue;
				const min = solarRadius(a) + solarRadius(b) + padding;
				let dx = (b.x ?? 0) - (a.x ?? 0);
				let dy = (b.y ?? 0) - (a.y ?? 0);
				let distance = Math.hypot(dx, dy);
				if (distance >= min) continue;
				if (distance < 0.001) {
					const angle = ((i + 1) * 12.9898 + (j + 1) * 78.233) % (Math.PI * 2);
					dx = Math.cos(angle);
					dy = Math.sin(angle);
					distance = 1;
				}
				const push = ((min - distance) / distance) * strength * alpha;
				const aMass = 1 + (a.mass ?? 0) * 3;
				const bMass = 1 + (b.mass ?? 0) * 3;
				const total = aMass + bMass;
				const aShare = bMass / total;
				const bShare = aMass / total;
				a.vx = (a.vx ?? 0) - dx * push * aShare;
				a.vy = (a.vy ?? 0) - dy * push * aShare;
				b.vx = (b.vx ?? 0) + dx * push * bShare;
				b.vy = (b.vy ?? 0) + dy * push * bShare;
			}
		}
	}) as SolarSystemForce;

	force.initialize = (next: GraphCanvasNode[]) => {
		nodes = next;
	};
	force.padding = (value: number) => {
		padding = value;
		return force;
	};
	force.strength = (value: number) => {
		strength = value;
		return force;
	};
	return force;
}

function solarRadius(node: GraphCanvasNode): number {
	return Math.max(node.systemRadius ?? node.size, node.size * 2);
}

function now(): number {
	return typeof performance === "undefined" ? Date.now() : performance.now();
}

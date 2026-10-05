import * as d3 from "d3-force";
import type { LayoutNode as GraphNode, LayoutEdge as GraphEdge } from "./graph-layout";
const FORCE_CONFIG = {
	alphaDecay: 0.025,
	alphaMin: 0.001,
	velocityDecay: 0.45,
	alphaTarget: 0.3,
	chargeStrength: -2400 / 9,
	collisionRadius: { document: 80 / 3, memory: 48 / 3 },
	collisionStrength: 0.82,
	centeringStrength: 0.06,
	linkDistance: 300 / 3,
	linkStrength: { docMemory: 0.35, version: 0.6, fallback: 0.05 },
	preSettleTicks: 150,
	densePreSettleTicks: 0,
	settleMeanVelocity: 1 / 3,
	settleMaxVelocity: 3 / 3,
	settleStableTicks: 12,
	settleMaxTicks: 360,
};

export const DENSE_GRAPH_STATIC_THRESHOLD = 1500;

export class ForceSimulation {
	private sim: d3.Simulation<GraphNode, GraphEdge> | null = null;
	private holdingHeat = false;

	init(nodes: GraphNode[], edges: GraphEdge[]): void {
		this.destroy();

		try {
			const structuralEdges = edges;

			this.sim = d3
				.forceSimulation<GraphNode>(nodes)
				.alphaDecay(FORCE_CONFIG.alphaDecay)
				.alphaMin(FORCE_CONFIG.alphaMin)
				.velocityDecay(FORCE_CONFIG.velocityDecay);

			this.sim.force(
				"link",
				d3
					.forceLink<GraphNode, GraphEdge>(structuralEdges)
					.id((d) => d.id)
					.distance(FORCE_CONFIG.linkDistance)
					.strength((link) => {
						if (["contains", "organizes", "describes"].includes(link.kind)) return FORCE_CONFIG.linkStrength.docMemory;
						if (link.kind === "asserted_by") return FORCE_CONFIG.linkStrength.version;
						return FORCE_CONFIG.linkStrength.fallback;
					}),
			);

			this.sim.force("charge", d3.forceManyBody<GraphNode>().strength(FORCE_CONFIG.chargeStrength));

			this.sim.force(
				"collide",
				d3
					.forceCollide<GraphNode>()
					.radius((d) =>
						d.kind === "entity" || d.kind === "source"
							? FORCE_CONFIG.collisionRadius.document
							: FORCE_CONFIG.collisionRadius.memory,
					)
					.strength(FORCE_CONFIG.collisionStrength),
			);

			this.sim.force("x", d3.forceX().strength(FORCE_CONFIG.centeringStrength));
			this.sim.force("y", d3.forceY().strength(FORCE_CONFIG.centeringStrength));

			this.sim.stop();
			this.sim.alpha(1);
			const preSettleTicks =
				nodes.length > DENSE_GRAPH_STATIC_THRESHOLD ? FORCE_CONFIG.densePreSettleTicks : FORCE_CONFIG.preSettleTicks;
			for (let i = 0; i < preSettleTicks; i++) this.sim.tick();

			if (nodes.length > DENSE_GRAPH_STATIC_THRESHOLD) {
				this.stop();
			} else {
				this.settle();
			}
		} catch (e) {
			console.error("ForceSimulation.init failed:", e);
			this.destroy();
		}
	}

	update(nodes: GraphNode[], edges: GraphEdge[]): void {
		if (!this.sim) return;
		this.sim.nodes(nodes);
		const linkForce = this.sim.force<d3.ForceLink<GraphNode, GraphEdge>>("link");
		if (linkForce) linkForce.links(edges);
	}

	reheat(): void {
		this.holdingHeat = true;
		this.sim?.on("tick.settle", null);
		this.sim?.alphaTarget(FORCE_CONFIG.alphaTarget).restart();
	}

	settle(): void {
		const sim = this.sim;
		if (!sim || this.holdingHeat) return;
		let ticks = 0;
		let stableTicks = 0;
		sim
			.alphaTarget(FORCE_CONFIG.alphaTarget)
			.on("tick.settle", () => {
				let squaredVelocity = 0;
				let maxSquaredVelocity = 0;
				const nodes = sim.nodes();
				for (const node of nodes) {
					const velocity = (node.vx ?? 0) ** 2 + (node.vy ?? 0) ** 2;
					squaredVelocity += velocity;
					maxSquaredVelocity = Math.max(maxSquaredVelocity, velocity);
				}
				const settled =
					sim.alpha() >= FORCE_CONFIG.alphaTarget * 0.9 &&
					squaredVelocity / Math.max(1, nodes.length) <= FORCE_CONFIG.settleMeanVelocity ** 2 &&
					maxSquaredVelocity <= FORCE_CONFIG.settleMaxVelocity ** 2;
				stableTicks = settled ? stableTicks + 1 : 0;
				if (++ticks >= FORCE_CONFIG.settleMaxTicks || stableTicks >= FORCE_CONFIG.settleStableTicks) {
					sim.alphaTarget(0).on("tick.settle", null);
				}
			})
			.restart();
	}

	coolDown(): void {
		this.holdingHeat = false;
		this.sim?.alphaTarget(0).on("tick.settle", null);
	}

	stop(): void {
		this.coolDown();
		this.sim?.alpha(0).stop();
	}

	isActive(): boolean {
		return Math.max(this.sim?.alpha() ?? 0, this.sim?.alphaTarget() ?? 0) > FORCE_CONFIG.alphaMin;
	}

	destroy(): void {
		this.holdingHeat = false;
		if (this.sim) {
			this.sim.stop();
			this.sim = null;
		}
	}
}

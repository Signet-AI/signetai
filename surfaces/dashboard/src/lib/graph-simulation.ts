import * as d3 from "d3-force";
import type { LayoutNode as GraphNode, LayoutEdge as GraphEdge } from "./graph-layout";
import type { KernelLayout, KernelLink, LayoutKernel } from "./graph-layout-kernel";
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
	settleMeanVelocity: 1 / 3,
	settleMaxVelocity: 3 / 3,
	settleStableTicks: 12,
	settleMaxTicks: 360,
};

const linkStrength = (link: GraphEdge) => {
	if (["contains", "organizes", "describes"].includes(link.kind)) return FORCE_CONFIG.linkStrength.docMemory;
	if (link.kind === "asserted_by") return FORCE_CONFIG.linkStrength.version;
	return FORCE_CONFIG.linkStrength.fallback;
};

const collisionRadius = (node: GraphNode) =>
	node.kind === "entity" || node.kind === "source"
		? FORCE_CONFIG.collisionRadius.document
		: FORCE_CONFIG.collisionRadius.memory;

interface KernelForce extends d3.Force<GraphNode, GraphEdge> {
	dispose(): void;
}

function kernelForce(kernel: LayoutKernel, edges: readonly GraphEdge[]): KernelForce {
	let layout: KernelLayout | undefined;
	let bodies: Array<GraphNode & { vx: number; vy: number }> = [];
	const force = ((alpha: number) => layout?.apply(bodies, alpha)) as KernelForce;
	force.initialize = (nodes) => {
		layout?.dispose();
		layout = undefined;
		bodies = nodes as typeof bodies;
		const byId = new Map(nodes.map((node) => [node.id, node]));
		const indexOf = (end: GraphEdge["source"]) => {
			const node = typeof end === "object" ? end : typeof end === "string" ? byId.get(end) : undefined;
			if (!node) throw new Error(`node not found: ${end}`);
			return node.index ?? -1;
		};
		const count: number[] = [];
		const ends = edges.map((edge) => {
			const source = indexOf(edge.source);
			const target = indexOf(edge.target);
			count[source] = (count[source] || 0) + 1;
			count[target] = (count[target] || 0) + 1;
			return { source, target };
		});
		const links: KernelLink[] = ends.map(({ source, target }, index) => ({
			source,
			target,
			bias: (count[source] ?? 0) / ((count[source] ?? 0) + (count[target] ?? 0)),
			strength: linkStrength(edges[index] as GraphEdge),
			distance: FORCE_CONFIG.linkDistance,
		}));
		layout = kernel.create(
			nodes.map(() => FORCE_CONFIG.chargeStrength),
			nodes.map(collisionRadius),
			links,
			{
				theta2: 0.81,
				distanceMin2: 1,
				distanceMax2: Number.POSITIVE_INFINITY,
				collideStrength: FORCE_CONFIG.collisionStrength,
				centerX: 0,
				centerY: 0,
				centerStrength: FORCE_CONFIG.centeringStrength,
			},
		);
	};
	force.dispose = () => {
		layout?.dispose();
		layout = undefined;
	};
	return force;
}

export type LayoutEngine = "wasm" | "d3";

export class ForceSimulation {
	private sim: d3.Simulation<GraphNode, GraphEdge> | null = null;
	private kernel: KernelForce | null = null;
	private holdingHeat = false;

	engine(): LayoutEngine {
		return this.kernel ? "wasm" : "d3";
	}

	init(nodes: GraphNode[], edges: GraphEdge[], kernel?: LayoutKernel): void {
		this.destroy();

		try {
			const structuralEdges = edges;

			this.sim = d3
				.forceSimulation<GraphNode>(nodes)
				.alphaDecay(FORCE_CONFIG.alphaDecay)
				.alphaMin(FORCE_CONFIG.alphaMin)
				.velocityDecay(FORCE_CONFIG.velocityDecay);

			if (kernel) {
				this.kernel = kernelForce(kernel, structuralEdges);
				this.sim.force("layout", this.kernel);
			} else {
				this.sim.force(
					"link",
					d3
						.forceLink<GraphNode, GraphEdge>(structuralEdges)
						.id((d) => d.id)
						.distance(FORCE_CONFIG.linkDistance)
						.strength(linkStrength),
				);

				this.sim.force("charge", d3.forceManyBody<GraphNode>().strength(FORCE_CONFIG.chargeStrength));

				this.sim.force(
					"collide",
					d3.forceCollide<GraphNode>().radius(collisionRadius).strength(FORCE_CONFIG.collisionStrength),
				);

				this.sim.force("x", d3.forceX().strength(FORCE_CONFIG.centeringStrength));
				this.sim.force("y", d3.forceY().strength(FORCE_CONFIG.centeringStrength));
			}

			this.sim.alpha(0).stop();
		} catch (e) {
			console.error("ForceSimulation.init failed:", e);
			this.destroy();
		}
	}

	tick(count: number): void {
		this.sim?.tick(count);
	}

	cool(alpha: number): void {
		if (alpha > FORCE_CONFIG.alphaMin) this.sim?.alphaTarget(0).alpha(alpha).restart();
	}

	heat(): number {
		return this.sim?.alpha() ?? 0;
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
		this.kernel?.dispose();
		this.kernel = null;
		if (this.sim) {
			this.sim.stop();
			this.sim = null;
		}
	}
}

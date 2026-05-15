// @ts-nocheck
import { describe, expect, it } from "bun:test";
import { KnowledgeForceSimulation } from "./simulation";
import type { GraphCanvasEdge, GraphCanvasNode } from "./types";

function node(id: string, x: number): GraphCanvasNode {
	return {
		id,
		kind: "entity",
		label: id,
		x,
		y: 0,
		size: 50,
		color: "#fff",
		dimColor: "#444",
		shape: "circle",
		data: null,
	};
}

describe("knowledge graph edge identity", () => {
	it("keeps stable sourceId and targetId after d3 mutates source and target", () => {
		const nodes = [node("a", -100), node("b", 100)];
		const edge: GraphCanvasEdge = {
			id: "dependency:a:b",
			sourceId: "a",
			targetId: "b",
			source: "a",
			target: "b",
			label: "depends on",
			kind: "dependency",
			strength: 0.2,
		};
		const sim = new KnowledgeForceSimulation();
		sim.init(nodes, [edge], { preSettleTicks: 4 });

		expect(edge.sourceId).toBe("a");
		expect(edge.targetId).toBe("b");
		expect(typeof edge.source).toBe("object");
		expect(typeof edge.target).toBe("object");
		sim.destroy();
	});
});

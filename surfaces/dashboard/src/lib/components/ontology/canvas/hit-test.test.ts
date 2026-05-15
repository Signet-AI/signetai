// @ts-nocheck
import { describe, expect, it } from "bun:test";
import { SpatialIndex } from "./hit-test";
import type { GraphCanvasNode } from "./types";

function node(overrides: Partial<GraphCanvasNode>): GraphCanvasNode {
	return {
		id: "entity-1",
		kind: "entity",
		label: "Entity",
		x: 0,
		y: 0,
		size: 20,
		color: "#fff",
		...overrides,
	};
}

describe("knowledge graph spatial index", () => {
	it("finds the topmost circular node at a world point", () => {
		const index = new SpatialIndex();
		index.rebuild([node({ id: "bottom", x: 0, y: 0, size: 20 }), node({ id: "top", x: 0, y: 0, size: 10 })]);

		expect(index.queryPoint(2, 2)?.id).toBe("top");
	});

	it("honors rectangular hit areas for entity nodes", () => {
		const index = new SpatialIndex();
		index.rebuild([node({ id: "rect", kind: "entity", x: 50, y: 50, size: 40, shape: "rect" })]);

		expect(index.queryPoint(68, 68)?.id).toBe("rect");
		expect(index.queryPoint(80, 80)).toBeNull();
	});
});

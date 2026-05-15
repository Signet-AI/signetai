// @ts-nocheck
import { describe, expect, it } from "bun:test";
import {
	edgeLineEndpoints,
	edgeLodAlpha,
	isEdgeEmphasizedForState,
	isEdgeVisibleAtLod,
	isNodeVisibleAtLod,
	nodeLodAlpha,
} from "./renderer";
import type { GraphCanvasEdge, GraphCanvasNode } from "./types";
import { ViewportState } from "./viewport";

function node(id: string, x: number, y: number): GraphCanvasNode {
	return {
		id,
		kind: "entity",
		label: id,
		x,
		y,
		size: 40,
		color: "#fff",
		dimColor: "#444",
		shape: "hex",
		data: null,
	};
}

describe("knowledge graph renderer", () => {
	it("draws edges from the current node map instead of stale d3 edge objects", () => {
		const currentSource = node("a", 10, 20);
		const currentTarget = node("b", 110, 40);
		const staleSource = node("a", -500, -500);
		const staleTarget = node("b", -400, -500);
		const edge: GraphCanvasEdge = {
			id: "about:a:b",
			sourceId: "a",
			targetId: "b",
			source: staleSource,
			target: staleTarget,
			label: "about",
			kind: "about",
		};
		const viewport = new ViewportState(100, 50, 2);

		expect(
			edgeLineEndpoints(
				edge,
				viewport,
				new Map([
					["a", currentSource],
					["b", currentTarget],
				]),
			),
		).toEqual({
			startX: 120,
			startY: 90,
			endX: 320,
			endY: 130,
		});

		currentSource.x = 70;
		currentSource.y = 80;

		expect(
			edgeLineEndpoints(
				edge,
				viewport,
				new Map([
					["a", currentSource],
					["b", currentTarget],
				]),
			),
		).toEqual({
			startX: 240,
			startY: 210,
			endX: 320,
			endY: 130,
		});
	});

	it("keeps detail nodes visible at distant zoom but lowers their visual weight", () => {
		const attribute = node("attribute:a", 0, 0);
		attribute.kind = "attribute";
		const edge: GraphCanvasEdge = {
			id: "has_attribute:aspect:a",
			sourceId: "aspect:a",
			targetId: "attribute:a",
			source: "aspect:a",
			target: "attribute:a",
			label: "attribute",
			kind: "has_attribute",
		};

		expect(isNodeVisibleAtLod(attribute, 0.1)).toBe(true);
		expect(isNodeVisibleAtLod(attribute, 0.2, true)).toBe(true);
		expect(nodeLodAlpha(attribute, 0.1)).toBeLessThan(1);
		expect(nodeLodAlpha(attribute, 0.1, true)).toBe(1);
		expect(isEdgeVisibleAtLod(edge, 0.1)).toBe(true);
		expect(isEdgeVisibleAtLod(edge, 0.2, true)).toBe(true);
		expect(edgeLodAlpha(edge, 0.1)).toBeLessThan(1);
		expect(edgeLodAlpha(edge, 0.1, true)).toBe(1);
	});

	it("does not promote dependency edges into selection emphasis", () => {
		const state = {
			selectedId: "entity:nicholai",
			hoveredId: null,
			relatedIds: new Set(["aspect:general", "entity:rust"]),
			searchMatchIds: null,
			dimProgress: 1,
		};
		const aspectEdge: GraphCanvasEdge = {
			id: "has_aspect:entity:nicholai:aspect:general",
			sourceId: "entity:nicholai",
			targetId: "aspect:general",
			source: "entity:nicholai",
			target: "aspect:general",
			label: "aspect",
			kind: "has_aspect",
		};
		const dependencyEdge: GraphCanvasEdge = {
			id: "about:entity:nicholai:entity:rust",
			sourceId: "entity:nicholai",
			targetId: "entity:rust",
			source: "entity:nicholai",
			target: "entity:rust",
			label: "mentions",
			kind: "about",
			visualOnly: true,
		};

		expect(isEdgeEmphasizedForState(aspectEdge, state)).toBe(true);
		expect(isEdgeEmphasizedForState(dependencyEdge, state)).toBe(false);
	});
});

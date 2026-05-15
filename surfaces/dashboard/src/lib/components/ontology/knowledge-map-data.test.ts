// @ts-nocheck
import { describe, expect, it } from "bun:test";
import type { ConstellationGraph } from "$lib/api";
import { buildKnowledgeMapFromConstellation } from "./knowledge-map-data";

const graph: ConstellationGraph = {
	entities: [
		{
			id: "entity-signet",
			name: "Signet",
			entityType: "project",
			mentions: 18,
			pinned: true,
			aspects: [
				{
					id: "aspect-direction",
					name: "product direction",
					weight: 0.9,
					attributes: [
						{
							id: "attr-source-native",
							content: "Signet should treat source artifacts as ground truth and semantic claims as shortcuts.",
							kind: "attribute",
							importance: 0.93,
							memoryId: "mem-source-native",
						},
						{
							id: "attr-weak",
							content: "Low value detail that should not outrank the useful claim.",
							kind: "attribute",
							importance: 0.1,
							memoryId: "mem-weak",
						},
					],
				},
			],
		},
		{
			id: "entity-noisy",
			name: "benchmark-run-1738123-json-artifact",
			entityType: "artifact",
			mentions: 90,
			pinned: false,
			aspects: [],
		},
		{
			id: "entity-nicholai",
			name: "Nicholai Vogel",
			entityType: "person",
			mentions: 8,
			pinned: false,
			aspects: [],
		},
	],
	dependencies: [
		{ sourceEntityId: "entity-signet", targetEntityId: "entity-nicholai", dependencyType: "about", strength: 0.8 },
		{ sourceEntityId: "entity-signet", targetEntityId: "entity-noisy", dependencyType: "generated", strength: 0.9 },
	],
};

describe("knowledge map data", () => {
	it("builds an evidence-first map instead of raw entity/aspect/attribute dumps", () => {
		const map = buildKnowledgeMapFromConstellation(graph, { focusLabel: "Signet", limit: 20 });

		expect(map.nodes.map((node) => node.kind)).toContain("source");
		expect(map.nodes.map((node) => node.kind)).toContain("claim");
		expect(map.nodes.map((node) => node.kind)).toContain("memory");
		expect(map.nodes.some((node) => node.id === "aspect-direction")).toBe(false);
		expect(map.nodes.some((node) => node.id === "attr-source-native")).toBe(false);
		expect(map.nodes.some((node) => node.id === "entity-noisy")).toBe(false);
		expect(map.edges.some((edge) => edge.kind === "supports")).toBe(true);
		expect(map.edges.some((edge) => edge.kind === "about")).toBe(true);
	});

	it("keeps the map bounded and ranks useful people/projects/topics ahead of noisy extracted entities", () => {
		const map = buildKnowledgeMapFromConstellation(graph, { limit: 4 });

		expect(map.nodes).toHaveLength(4);
		expect(map.nodes.map((node) => node.id)).toContain("entity-signet");
		expect(map.nodes.map((node) => node.id)).toContain("entity-nicholai");
		expect(map.nodes.map((node) => node.id)).not.toContain("entity-noisy");
	});

	it("places claims and memories around their parent anchor deterministically", () => {
		const first = buildKnowledgeMapFromConstellation(graph, { limit: 20 });
		const second = buildKnowledgeMapFromConstellation(graph, { limit: 20 });
		const firstClaim = first.nodes.find((node) => node.kind === "claim");
		const secondClaim = second.nodes.find((node) => node.id === firstClaim?.id);

		expect(firstClaim?.parentId).toBe("entity-signet");
		expect(secondClaim?.x).toBe(firstClaim?.x);
		expect(secondClaim?.y).toBe(firstClaim?.y);
	});
});

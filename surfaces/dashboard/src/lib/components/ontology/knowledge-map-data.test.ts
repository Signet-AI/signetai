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
			aspects: [
				{
					id: "aspect-nicholai-preferences",
					name: "preferences",
					weight: 0.7,
					attributes: [],
				},
			],
		},
		{
			id: "entity-empty-person",
			name: "Empty Person",
			entityType: "person",
			mentions: 120,
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
	it("builds a schema-native entity aspect attribute evidence map", () => {
		const map = buildKnowledgeMapFromConstellation(graph, { focusLabel: "Signet", limit: 20 });

		expect(map.nodes.map((node) => node.kind)).toContain("entity");
		expect(map.nodes.map((node) => node.kind)).toContain("aspect");
		expect(map.nodes.map((node) => node.kind)).toContain("attribute");
		expect(map.nodes.map((node) => node.kind)).toContain("memory");
		expect(map.nodes.some((node) => node.id === "aspect:aspect-direction")).toBe(true);
		expect(map.nodes.some((node) => node.id === "attribute:attr-source-native")).toBe(true);
		expect(map.nodes.some((node) => node.id === "entity-noisy")).toBe(false);
		expect(map.nodes.some((node) => node.id === "entity-empty-person")).toBe(false);
		expect(map.edges.some((edge) => edge.kind === "supports")).toBe(true);
		expect(map.edges.some((edge) => edge.kind === "about")).toBe(true);
		expect(map.edges.find((edge) => edge.kind === "about")?.visualOnly).toBe(true);
	});

	it("keeps the map bounded and ranks useful people/projects/topics ahead of noisy extracted entities", () => {
		const map = buildKnowledgeMapFromConstellation(graph, { limit: 4 });

		expect(map.nodes).toHaveLength(4);
		expect(map.nodes.map((node) => node.id)).toContain("entity-signet");
		expect(map.nodes.map((node) => node.id)).toContain("entity-nicholai");
		expect(map.nodes.map((node) => node.id)).not.toContain("entity-noisy");
	});

	it("places attributes and memories around their parent anchor deterministically", () => {
		const first = buildKnowledgeMapFromConstellation(graph, { limit: 20 });
		const second = buildKnowledgeMapFromConstellation(graph, { limit: 20 });
		const firstAttribute = first.nodes.find((node) => node.kind === "attribute");
		const secondAttribute = second.nodes.find((node) => node.id === firstAttribute?.id);
		const memory = first.nodes.find((node) => node.kind === "memory");

		expect(firstAttribute?.parentId).toBe("aspect:aspect-direction");
		expect(memory?.parentId).toBe(firstAttribute?.id);
		expect(secondAttribute?.x).toBe(firstAttribute?.x);
		expect(secondAttribute?.y).toBe(firstAttribute?.y);
	});

	it("reserves graph budget for attributes on visible aspects", () => {
		const crowded: ConstellationGraph = {
			entities: Array.from({ length: 32 }, (_, entityIndex) => ({
				id: `entity-${entityIndex}`,
				name: `Entity ${entityIndex}`,
				entityType: "topic",
				mentions: 20 - (entityIndex % 6),
				pinned: entityIndex === 0,
				aspects: Array.from({ length: 5 }, (_, aspectIndex) => ({
					id: `aspect-${entityIndex}-${aspectIndex}`,
					name: `aspect ${aspectIndex}`,
					weight: 0.8,
					attributes: [
						{
							id: `attr-${entityIndex}-${aspectIndex}`,
							content: `Attribute ${entityIndex}.${aspectIndex}`,
							kind: "attribute",
							importance: 0.05,
							memoryId: `mem-${entityIndex}-${aspectIndex}`,
						},
					],
				})),
			})),
			dependencies: [],
		};

		const map = buildKnowledgeMapFromConstellation(crowded, { limit: 400 });
		const aspectIds = map.nodes.filter((node) => node.kind === "aspect").map((node) => node.id);
		const aspectIdsWithAttributes = new Set(
			map.edges.filter((edge) => edge.kind === "has_attribute").map((edge) => edge.source),
		);

		expect(map.nodes).toHaveLength(400);
		expect(map.nodes.map((node) => node.kind)).toContain("attribute");
		expect(aspectIds.length).toBeGreaterThan(0);
		expect(aspectIds.every((id) => aspectIdsWithAttributes.has(id))).toBe(true);
	});
});

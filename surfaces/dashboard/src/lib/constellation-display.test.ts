import { describe, expect, test } from "bun:test";
import type { GraphSceneData } from "./graph-scene";
import {
	capGraphSceneData,
	MAX_CONSTELLATION_ENTITY_LIMIT,
	MAX_VISIBLE_CONSTELLATION_NODES,
} from "./constellation-display";

describe("constellation display limits", () => {
	test("keeps entity and source anchors within the total node cap and drops dangling edges", () => {
		const scene: GraphSceneData = {
			nodes: [
				{ id: "entity-a", label: "A", kind: "entity", cluster: "entity-a", weight: 1, metric: "" },
				{ id: "attribute-a", label: "A value", kind: "attribute", cluster: "entity-a", weight: 1, metric: "" },
				{ id: "source-a", label: "Source", kind: "source", cluster: "source", weight: 1, metric: "" },
				{ id: "entity-b", label: "B", kind: "entity", cluster: "entity-b", weight: 1, metric: "" },
				{ id: "attribute-b", label: "B value", kind: "attribute", cluster: "entity-b", weight: 1, metric: "" },
			],
			edges: [
				{ from: "entity-a", to: "attribute-a", kind: "contains" },
				{ from: "entity-b", to: "attribute-b", kind: "contains" },
				{ from: "attribute-a", to: "missing", kind: "evidenced_by" },
			],
		};

		const limited = capGraphSceneData(scene, 4);

		expect(limited.capped).toBe(true);
		expect(limited.data.nodes.map((node) => node.id)).toEqual(["entity-a", "source-a", "entity-b", "attribute-a"]);
		expect(limited.data.edges).toEqual([{ from: "entity-a", to: "attribute-a", kind: "contains" }]);
	});

	test("keeps the complete graph when it fits under the cap", () => {
		const scene: GraphSceneData = {
			nodes: [{ id: "entity-a", label: "A", kind: "entity", cluster: "entity-a", weight: 1, metric: "" }],
			edges: [],
		};

		expect(capGraphSceneData(scene, 1)).toEqual({ data: scene, capped: false });
	});

	test("matches the server entity bound and uses a finite total display bound", () => {
		expect(MAX_CONSTELLATION_ENTITY_LIMIT).toBe(300);
		expect(MAX_VISIBLE_CONSTELLATION_NODES).toBe(5_000);
	});
});

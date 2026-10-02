import { describe, expect, test } from "bun:test";
import { layoutGraph } from "./graph-layout";
import type { GraphSceneData, SceneNode } from "./graph-scene";
import { capGraphSceneData } from "./constellation-display";

function node(id: string, kind: SceneNode["kind"], cluster: string): SceneNode {
	return { id, kind, cluster, label: id, metric: "", weight: 1 };
}

const branch: GraphSceneData = {
	nodes: [
		node("entity", "entity", "entity"),
		node("aspect", "aspect", "entity"),
		node("group", "group", "entity"),
		node("slot", "claimSlot", "entity"),
		node("value", "attribute", "entity"),
		node("evidence", "memory", "entity"),
		node("other", "entity", "other"),
	],
	edges: [
		{ from: "entity", to: "aspect", kind: "contains" },
		{ from: "aspect", to: "group", kind: "organizes" },
		{ from: "group", to: "slot", kind: "organizes" },
		{ from: "slot", to: "value", kind: "describes" },
		{ from: "value", to: "evidence", kind: "evidenced_by" },
		{ from: "entity", to: "other", kind: "depends_on" },
	],
};

describe("2D ontology layout", () => {
	test("preserves graph identity, hierarchy, and evidence without mutating the snapshot", () => {
		const original = JSON.stringify(branch);
		const layout = layoutGraph(branch);
		expect(layout.map((node) => node.id)).toEqual(branch.nodes.map((node) => node.id));
		expect(layout.every((node) => Number.isFinite(node.x) && Number.isFinite(node.y))).toBe(true);
		expect(JSON.stringify(branch)).toBe(original);
		expect(layoutGraph(branch)).toEqual(layout);
	});
	test("retains hierarchy anchors before leaf values when capped", () => {
		const limited = capGraphSceneData({ ...branch, nodes: [...branch.nodes].reverse() }, 5);
		expect(new Set(limited.data.nodes.map((node) => node.id))).toEqual(
			new Set(["entity", "other", "aspect", "group", "slot"]),
		);
		expect(limited.data.edges.some((edge) => edge.kind === "depends_on")).toBe(true);
	});
	test("initializes a maximum-size snapshot and ignores dangling links", () => {
		const nodes = Array.from({ length: 5000 }, (_, index) =>
			node(`${index}`, index % 20 === 0 ? "entity" : "attribute", `${Math.floor(index / 20) * 20}`),
		);
		const edges: GraphSceneData["edges"] = nodes
			.slice(1)
			.map((node) => ({ from: node.cluster, to: node.id, kind: "describes" }));
		const start = performance.now();
		const layout = layoutGraph({ nodes, edges: [...edges, { from: "missing", to: "0", kind: "contains" }] });
		expect(layout).toHaveLength(5000);
		expect(layout.every((node) => Number.isFinite(node.x) && Number.isFinite(node.y))).toBe(true);
		expect(performance.now() - start).toBeLessThan(15_000);
	}, 20_000);
});

import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { graphLayout, type LayoutNode } from "./graph-layout";
import { type LayoutKernel, loadLayoutKernel } from "./graph-layout-kernel";
import type { GraphSceneData, SceneEdge, SceneNode, SceneNodeKind } from "./graph-scene";
import { ForceSimulation } from "./graph-simulation";

function constellation(entities: number): GraphSceneData {
	const nodes: SceneNode[] = [];
	const edges: SceneEdge[] = [];
	const add = (id: string, kind: SceneNodeKind, cluster: string) =>
		nodes.push({ id, kind, cluster, label: id, weight: 0.5, metric: "" });
	for (let entity = 0; entity < entities; entity++) {
		const owner = `e${entity}`;
		add(owner, "entity", owner);
		for (let aspect = 0; aspect < 1 + (entity % 4); aspect++) {
			const id = `${owner}a${aspect}`;
			add(id, "aspect", owner);
			edges.push({ from: owner, to: id, kind: "contains" });
			for (let fact = 0; fact < 2 + ((entity + aspect) % 7); fact++) {
				const leaf = `${id}f${fact}`;
				add(leaf, fact % 5 === 0 ? "claim" : "attribute", owner);
				edges.push({ from: id, to: leaf, kind: "describes" });
				if (fact % 3 === 0) {
					add(`${leaf}m`, "memory", owner);
					edges.push({ from: leaf, to: `${leaf}m`, kind: "asserted_by" });
				}
			}
		}
		if (entity % 9 === 0) {
			add(`s${entity}`, "source", `s${entity}`);
			edges.push({ from: `s${entity}`, to: owner, kind: "evidenced_by" });
		}
		if (entity > 0) edges.push({ from: owner, to: `e${(entity * 7) % entity}`, kind: "depends_on" });
	}
	return { nodes, edges };
}

function settle(data: GraphSceneData, kernel?: LayoutKernel): { nodes: LayoutNode[]; alpha: number; engine: string } {
	const { nodes, edges } = graphLayout(data);
	for (const [a, b] of [
		[10, 11],
		[10, 12],
		[40, 41],
	] as const) {
		const from = nodes[b] as LayoutNode;
		const to = nodes[a] as LayoutNode;
		from.x = to.x;
		from.y = to.y;
	}
	const simulation = new ForceSimulation();
	simulation.init(nodes, edges, kernel);
	simulation.cool(1);
	simulation.tick(80);
	const pinned = nodes[3] as LayoutNode;
	pinned.fx = pinned.x + 250;
	pinned.fy = pinned.y - 140;
	simulation.reheat();
	simulation.tick(40);
	pinned.fx = null;
	pinned.fy = null;
	simulation.coolDown();
	simulation.tick(60);
	const alpha = simulation.heat();
	const engine = simulation.engine();
	simulation.destroy();
	return { nodes, alpha, engine };
}

test("the wasm layout kernel reproduces d3-force exactly, step for step", async () => {
	const wasm = new URL("./graph-layout.wasm", import.meta.url);
	let bytes: Buffer;
	try {
		bytes = readFileSync(wasm);
	} catch {
		throw new Error(`${wasm.pathname} is missing. Run bun run build:graph-layout in surfaces/dashboard.`);
	}
	const kernel = await loadLayoutKernel(bytes);
	const data = constellation(220);
	const reference = settle(data);
	const compiled = settle(data, kernel);
	expect(reference.engine).toBe("d3");
	expect(compiled.engine).toBe("wasm");
	expect(compiled.alpha).toBe(reference.alpha);
	expect(compiled.nodes.length).toBeGreaterThan(2000);
	const mismatched = compiled.nodes.filter((node, index) => {
		const expected = reference.nodes[index] as LayoutNode;
		return !(
			Object.is(node.x, expected.x) &&
			Object.is(node.y, expected.y) &&
			Object.is(node.vx, expected.vx) &&
			Object.is(node.vy, expected.vy)
		);
	});
	expect(mismatched.map((node) => node.id)).toEqual([]);
	const start = graphLayout(data).nodes;
	const moved = compiled.nodes.filter((node, index) => node.x !== start[index]?.x).length;
	expect(moved).toBe(compiled.nodes.length);
	expect(compiled.nodes.every((node) => Number.isFinite(node.x) && Number.isFinite(node.y))).toBe(true);
}, 60_000);

test("the wasm layout kernel rejects links that do not resolve, as d3-force does", async () => {
	const kernel = await loadLayoutKernel(readFileSync(new URL("./graph-layout.wasm", import.meta.url)));
	const { nodes } = graphLayout(constellation(2));
	const simulation = new ForceSimulation();
	const error = console.error;
	console.error = () => {};
	try {
		simulation.init(nodes, [{ from: "e0", to: "missing", kind: "contains", source: "e0", target: "missing" }], kernel);
	} finally {
		console.error = error;
	}
	expect(simulation.isActive()).toBe(false);
	expect(simulation.engine()).toBe("d3");
	expect(() =>
		kernel.create([1, 1], [1, 1], [{ source: 0, target: 2, bias: 0.5, strength: 1, distance: 1 }], {
			theta2: 0.81,
			distanceMin2: 1,
			distanceMax2: Number.POSITIVE_INFINITY,
			collideStrength: 1,
			centerX: 0,
			centerY: 0,
			centerStrength: 0.1,
		}),
	).toThrow("outside the node list");
});

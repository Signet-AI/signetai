import { expect, test } from "bun:test";
import type { GraphWorkerRequest, GraphWorkerResponse } from "./graph-worker";
import type { GraphSceneData } from "./graph-scene";

function response(worker: Worker, predicate: (value: GraphWorkerResponse) => boolean): Promise<GraphWorkerResponse> {
	return new Promise((resolve, reject) => {
		const timeout = setTimeout(() => {
			worker.removeEventListener("message", receive);
			reject(new Error("Graph worker did not complete"));
		}, 12_000);
		const receive = (event: MessageEvent<GraphWorkerResponse>) => {
			if (!predicate(event.data)) return;
			clearTimeout(timeout);
			worker.removeEventListener("message", receive);
			resolve(event.data);
		};
		worker.addEventListener("message", receive);
	});
}

const data: GraphSceneData = {
	nodes: [
		{ id: "entity", kind: "entity", cluster: "entity", label: "Entity", weight: 1, metric: "" },
		{ id: "aspect", kind: "aspect", cluster: "entity", label: "Aspect", weight: 1, metric: "" },
		{ id: "attribute", kind: "attribute", cluster: "entity", label: "Attribute", weight: 1, metric: "" },
	],
	edges: [
		{ from: "entity", to: "aspect", kind: "contains" },
		{ from: "aspect", to: "attribute", kind: "describes" },
	],
};

test("dragging crosses the worker boundary, moves connected nodes, and settles after release", async () => {
	const worker = new Worker(new URL("./graph-worker.ts", import.meta.url).href);
	const send = (request: GraphWorkerRequest) => worker.postMessage(request);
	try {
		const initial = response(worker, () => true);
		send({ type: "init", data });
		const before = await initial;
		const root = before.nodes.find((node) => node.id === "entity");
		const aspect = before.nodes.find((node) => node.id === "aspect");
		if (!root || !aspect) throw new Error("Missing graph branch");
		const x = root.x + 400,
			y = root.y + 200;
		const pinned = response(worker, (value) => {
			const root = value.nodes.find((node) => node.id === "entity");
			const linked = value.nodes.find((node) => node.id === aspect.id);
			return (
				!!root && !!linked && Math.abs(root.x - x) < 0.1 && Math.hypot(linked.x - aspect.x, linked.y - aspect.y) > 1
			);
		});
		send({ type: "drag", id: root.id, x, y });
		const dragged = await pinned;
		const moved = dragged.nodes.find((node) => node.id === aspect.id);
		expect(moved).toBeDefined();
		expect(Math.hypot((moved?.x ?? aspect.x) - aspect.x, (moved?.y ?? aspect.y) - aspect.y)).toBeGreaterThan(1);
		expect(dragged.active).toBe(true);
		const settled = response(worker, (value) => !value.active);
		send({ type: "release", id: root.id });
		const after = await settled;
		expect(after.nodes.find((node) => node.id === root.id)?.fx).toBeNull();
		expect(after.nodes.every((node) => typeof node.fx !== "number" && typeof node.fy !== "number")).toBe(true);
		expect(after.nodes.every((node) => Number.isFinite(node.x) && Number.isFinite(node.y))).toBe(true);
	} finally {
		worker.terminate();
	}
}, 20_000);

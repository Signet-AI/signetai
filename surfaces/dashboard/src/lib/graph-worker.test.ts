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

const at = (value: GraphWorkerResponse, id: string) => {
	const index = data.nodes.findIndex((node) => node.id === id);
	return { x: value.xy[index * 2] ?? Number.NaN, y: value.xy[index * 2 + 1] ?? Number.NaN };
};

test("dragging crosses the worker boundary, moves connected nodes, and settles after release", async () => {
	const worker = new Worker(new URL("./graph-worker.ts", import.meta.url).href);
	const send = (request: GraphWorkerRequest) => worker.postMessage(request);
	try {
		const initial = response(worker, () => true);
		send({ type: "init", data });
		const before = await initial;
		expect(before.xy).toBeInstanceOf(Float64Array);
		expect(before.xy).toHaveLength(data.nodes.length * 2);
		const root = at(before, "entity");
		const aspect = at(before, "aspect");
		const x = root.x + 400,
			y = root.y + 200;
		const pinned = response(worker, (value) => {
			const pin = at(value, "entity");
			const linked = at(value, "aspect");
			return Math.abs(pin.x - x) < 0.1 && Math.hypot(linked.x - aspect.x, linked.y - aspect.y) > 1;
		});
		send({ type: "drag", id: "entity", x, y });
		const dragged = await pinned;
		const moved = at(dragged, "aspect");
		expect(Math.hypot(moved.x - aspect.x, moved.y - aspect.y)).toBeGreaterThan(1);
		expect(dragged.active).toBe(true);
		const settled = response(worker, (value) => !value.active);
		send({ type: "release", id: "entity" });
		const after = await settled;
		const released = at(after, "entity");
		expect(Math.hypot(released.x - x, released.y - y)).toBeGreaterThan(1);
		expect(Array.from(after.xy).every(Number.isFinite)).toBe(true);
	} finally {
		worker.terminate();
	}
}, 20_000);

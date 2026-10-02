import { expect, test } from "bun:test";
import { matchRetrievedNodes, type SceneNode } from "./graph-scene";
import { graphEvidenceRefs } from "./constellation-display";

test("imported evidence finds its document and claims by canonical artifact path despite shared native bridge IDs", () => {
	const path = "imports/import:people:revision/Buse.md";
	const provenance = { sourceId: "import:people:revision", sourceKind: "source_import_markdown", sourcePath: path };
	const nodes: SceneNode[] = [
		{
			id: "src_document",
			label: "Buse.md",
			kind: "source",
			cluster: "src_document",
			weight: 1,
			metric: "",
			evidenceRefs: graphEvidenceRefs(provenance),
		},
		{
			id: "claim",
			label: "Claim",
			kind: "attribute",
			cluster: "src_document",
			weight: 1,
			metric: "",
			evidenceRefs: graphEvidenceRefs(provenance),
		},
		{
			id: "other_document",
			label: "Buse.md",
			kind: "source",
			cluster: "other_document",
			weight: 1,
			metric: "",
			evidenceRefs: graphEvidenceRefs({ ...provenance, sourcePath: "imports/other/Buse.md" }),
		},
	];
	expect([...matchRetrievedNodes(nodes, [], [`artifact:${path}`, "source:native-memory-bridge"])]).toEqual([
		"src_document",
		"claim",
	]);
});

test("retrieval matches stable IDs and explicit provenance without guessing labels or clusters", () => {
	const nodes: SceneNode[] = [
		{ id: "entity", label: "Mira", kind: "entity", cluster: "entity", weight: 1, metric: "" },
		{ id: "other", label: "Mira", kind: "entity", cluster: "other", weight: 1, metric: "" },
		{
			id: "claim",
			label: "A claim",
			kind: "attribute",
			cluster: "entity",
			weight: 1,
			metric: "",
			evidenceRefs: ["source:import:one"],
		},
		{ id: "memory:m", label: "Evidence", kind: "memory", cluster: "entity", weight: 1, metric: "" },
	];
	expect([...matchRetrievedNodes(nodes, ["entity"], [])]).toEqual(["entity"]);
	expect([...matchRetrievedNodes(nodes, [], ["source:import:one", "memory:m"])]).toEqual(["claim", "memory:m"]);
	expect([...matchRetrievedNodes(nodes, ["missing", "Mira"], ["artifact:outside-snapshot"])]).toEqual([]);
});

import { mock, spyOn } from "bun:test";
import { Window } from "happy-dom";
import { installDashboardDomGlobals } from "@/test/dom-globals";
import { createGraphScene } from "./graph-scene";
import { ViewportState } from "./graph-viewport";
import type { GraphWorkerResponse } from "./graph-worker";

test("renderer batches retrieval, pauses following on wheel, and cancels pending work on clear/dispose", () => {
	const dom = new Window();
	const restore = installDashboardDomGlobals(dom);
	const previous = new Map<string, PropertyDescriptor | undefined>();
	const globals = (name: string, value: unknown) => {
		previous.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
		Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
	};
	const frames = new Map<number, FrameRequestCallback>();
	let frameId = 0;
	let worker: { onmessage?: (event: { data: GraphWorkerResponse }) => void } | undefined;
	const terminate = mock(() => {});
	class TestWorker {
		onmessage?: (event: { data: GraphWorkerResponse }) => void;
		constructor() {
			worker = this;
		}
		postMessage() {}
		terminate = terminate;
	}
	globals("Worker", TestWorker);
	globals(
		"ResizeObserver",
		class {
			observe() {}
			disconnect() {}
		},
	);
	globals("devicePixelRatio", 1);
	globals("requestAnimationFrame", (callback: FrameRequestCallback) => {
		frames.set(++frameId, callback);
		return frameId;
	});
	globals("cancelAnimationFrame", (id: number) => frames.delete(id));
	const context = new Proxy({}, { get: (_, key) => (key === "measureText" ? () => ({ width: 20 }) : () => {}) });
	Object.defineProperty(dom.HTMLCanvasElement.prototype, "getContext", { value: () => context });
	const fit = spyOn(ViewportState.prototype, "fitToNodes");
	const manual = mock(() => {});
	const nodes: SceneNode[] = [
		{ id: "one", label: "One", kind: "entity", cluster: "one", weight: 1, metric: "" },
		{ id: "two", label: "Two", kind: "aspect", cluster: "one", weight: 1, metric: "" },
	];
	const container = document.createElement("div");
	const scene = createGraphScene(
		container,
		{ nodes, edges: [{ from: "one", to: "two", kind: "contains" }] },
		undefined,
		undefined,
		manual,
	);
	const canvas = container.querySelector("canvas");
	const step = (now: number) => {
		const queued = [...frames.values()];
		frames.clear();
		for (const callback of queued) callback(now);
	};
	try {
		worker?.onmessage?.({ data: { nodes: nodes.map((node, index) => ({ ...node, x: index * 100, y: index * 100 })) } });
		fit.mockClear();
		const now = performance.now();
		scene.setRetrieval(["one"], []);
		scene.setRetrieval(["two"], []);
		step(now + 100);
		expect(canvas?.dataset.retrievedNodes).toBeUndefined();
		expect(fit).not.toHaveBeenCalled();
		step(now + 200);
		expect(canvas?.dataset.retrievedNodes).toBe("2");
		expect(fit).toHaveBeenCalledTimes(1);
		const wheel = new Event("wheel");
		Object.assign(wheel, { deltaX: 0, deltaY: 1, clientX: 0, clientY: 0 });
		canvas?.dispatchEvent(wheel);
		expect(manual).toHaveBeenCalledTimes(1);
		scene.setRetrieval(["one"], []);
		step(now + 1400);
		expect(canvas?.dataset.retrievedNodes).toBe("1");
		expect(fit).toHaveBeenCalledTimes(1);
		scene.clearRetrieval();
		scene.setFollowAgent(true);
		scene.setRetrieval(["two"], []);
		step(now + 1800);
		expect(fit).toHaveBeenCalledTimes(2);
		expect(canvas?.dataset.retrievedNodes).toBe("1");
		scene.setRetrieval(["one"], []);
		scene.clearRetrieval();
		step(now + 2400);
		expect(canvas?.dataset.retrievedNodes).toBe("0");
		scene.dispose();
		expect(frames.size).toBe(0);
		expect(terminate).toHaveBeenCalledTimes(1);
	} finally {
		scene.dispose();
		fit.mockRestore();
		for (const [name, descriptor] of previous) {
			if (descriptor) Object.defineProperty(globalThis, name, descriptor);
			else Reflect.deleteProperty(globalThis, name);
		}
		restore();
		dom.close();
	}
});

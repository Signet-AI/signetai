import { expect, spyOn, test } from "bun:test";
import { Window } from "happy-dom";
import { installDashboardDomGlobals } from "@/test/dom-globals";
import { createGraphScene, type SceneNode } from "./graph-scene";
import { ViewportState } from "./graph-viewport";
import type { GraphWorkerResponse } from "./graph-worker";

test("selection follows the reference interaction model without moving the camera", () => {
	const dom = new Window();
	const restore = installDashboardDomGlobals(dom);
	const previous = new Map<string, PropertyDescriptor | undefined>();
	const globals = (name: string, value: unknown) => {
		previous.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
		Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
	};
	let worker: { onmessage?: (event: { data: GraphWorkerResponse }) => void } | undefined;
	class TestWorker {
		onmessage?: (event: { data: GraphWorkerResponse }) => void;
		constructor() {
			worker = this;
		}
		postMessage() {}
		terminate() {}
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
	globals("OffscreenCanvas", undefined);
	globals("requestAnimationFrame", () => 1);
	globals("cancelAnimationFrame", () => {});
	const context = new Proxy({}, { get: (_, key) => (key === "measureText" ? () => ({ width: 20 }) : () => {}) });
	Object.defineProperty(dom.HTMLCanvasElement.prototype, "getContext", {
		value: (type: string) => (type === "2d" ? context : null),
	});
	const fit = spyOn(ViewportState.prototype, "fitToNodes").mockImplementation(function (this: ViewportState) {
		this.zoom = 1;
		this.panX = 0;
		this.panY = 0;
	});
	const centerOn = spyOn(ViewportState.prototype, "centerOn");
	const focusOn = spyOn(ViewportState.prototype, "focusOn");
	const zoomTo = spyOn(ViewportState.prototype, "zoomTo");
	const selections: Array<string | null> = [];
	const nodes: SceneNode[] = [
		{ id: "one", label: "One", kind: "entity", cluster: "one", weight: 1, metric: "" },
		{ id: "two", label: "Two", kind: "aspect", cluster: "one", weight: 1, metric: "" },
	];
	const container = document.createElement("div");
	document.body.append(container);
	const scene = createGraphScene(container, { nodes, edges: [{ from: "one", to: "two", kind: "contains" }] }, (node) =>
		selections.push(node?.id ?? null),
	);
	const canvas = container.querySelector("canvas");
	const click = (x: number, y: number, detail = 1) =>
		canvas?.dispatchEvent(new MouseEvent("click", { clientX: x, clientY: y, detail, bubbles: true }));
	const press = (key: string, target: EventTarget = document.body) =>
		target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
	try {
		worker?.onmessage?.({
			data: {
				xy: Float64Array.from(nodes.flatMap((_, index) => [index * 100, index * 100])),
				active: false,
				origin: "fresh",
				engine: "d3",
			},
		});
		fit.mockClear();
		click(0, 0);
		click(0, 0);
		click(0, 0);
		click(500, 500);
		expect(selections).toEqual(["one", null, "one", null]);
		click(0, 0, 2);
		expect(selections).toHaveLength(4);
		expect(centerOn).not.toHaveBeenCalled();
		expect(focusOn).not.toHaveBeenCalled();
		expect(fit).not.toHaveBeenCalled();

		click(0, 0);
		const input = document.createElement("input");
		document.body.append(input);
		press("Escape", input);
		press("z", input);
		expect(selections.at(-1)).toBe("one");
		expect(fit).not.toHaveBeenCalled();
		press("ArrowDown");
		expect(selections.at(-1)).toBe("two");
		expect(centerOn).toHaveBeenCalledTimes(1);
		press("ArrowUp");
		expect(selections.at(-1)).toBe("one");
		press("Escape");
		expect(selections.at(-1)).toBeNull();
		press("z");
		expect(fit).toHaveBeenCalledTimes(1);

		canvas?.dispatchEvent(new MouseEvent("dblclick", { clientX: 40, clientY: 30, bubbles: true }));
		expect(zoomTo).toHaveBeenLastCalledWith(1.5, 40, 30);
		click(0, 0);
		const count = selections.length;
		scene.dispose();
		press("Escape");
		expect(selections).toHaveLength(count);
	} finally {
		scene.dispose();
		for (const spy of [fit, centerOn, focusOn, zoomTo]) spy.mockRestore();
		for (const [name, descriptor] of previous) {
			if (descriptor) Object.defineProperty(globalThis, name, descriptor);
			else Reflect.deleteProperty(globalThis, name);
		}
		restore();
		dom.close();
	}
});

import { expect, test } from "bun:test";
import { Window } from "happy-dom";
import { installDashboardDomGlobals } from "@/test/dom-globals";
import type { EngineOutput } from "./graph-engine";
import type { RenderWorkerRequest } from "./graph-render-worker";
import { createGraphScene, type SceneNode } from "./graph-scene";

test("the scene renders in a worker: canvases and the simulation port move there, input and output cross as messages", () => {
	const dom = new Window();
	const restore = installDashboardDomGlobals(dom);
	const previous = new Map<string, PropertyDescriptor | undefined>();
	const globals = (name: string, value: unknown) => {
		previous.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
		Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
	};
	const workers: TestWorker[] = [];
	class TestWorker {
		onmessage?: (event: { data: EngineOutput }) => void;
		onerror?: () => void;
		messages: Array<{ message: unknown; transfer: unknown[] }> = [];
		terminated = 0;
		constructor(readonly url: URL) {
			workers.push(this);
		}
		postMessage(message: unknown, transfer: unknown[] = []) {
			this.messages.push({ message, transfer });
		}
		terminate() {
			this.terminated++;
		}
	}
	class TestOffscreenCanvas {}
	globals("Worker", TestWorker);
	globals("OffscreenCanvas", TestOffscreenCanvas);
	globals(
		"ResizeObserver",
		class {
			observe() {}
			disconnect() {}
		},
	);
	globals("devicePixelRatio", 1);
	const offscreen: TestOffscreenCanvas[] = [];
	Object.defineProperty(dom.HTMLCanvasElement.prototype, "transferControlToOffscreen", {
		configurable: true,
		value: () => {
			const surface = new TestOffscreenCanvas();
			offscreen.push(surface);
			return surface;
		},
	});
	Object.defineProperty(dom.HTMLCanvasElement.prototype, "getContext", {
		configurable: true,
		value: () => {
			throw new Error("the main thread must not draw");
		},
	});
	const nodes: SceneNode[] = [
		{ id: "one", label: "One", kind: "entity", cluster: "one", weight: 1, metric: "" },
		{ id: "two", label: "Two", kind: "aspect", cluster: "one", weight: 1, metric: "" },
	];
	const selections: Array<string | null> = [];
	const container = document.createElement("div");
	document.body.append(container);
	const scene = createGraphScene(container, { nodes, edges: [{ from: "one", to: "two", kind: "contains" }] }, (node) =>
		selections.push(node?.id ?? null),
	);
	const canvas = container.querySelector("canvas");
	const press = (key: string) => {
		const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
		document.body.dispatchEvent(event);
		return event.defaultPrevented;
	};
	try {
		const simulation = workers.find((worker) => worker.url.pathname.endsWith("graph-worker.ts"));
		const renderer = workers.find((worker) => worker.url.pathname.endsWith("graph-render-worker.ts"));
		expect(simulation).toBeDefined();
		expect(renderer).toBeDefined();
		if (!simulation || !renderer) throw new Error("workers missing");
		const connect = simulation.messages[0];
		const init = renderer.messages[0];
		const request = init?.message as Extract<RenderWorkerRequest, { type: "init" }>;
		expect(request.type).toBe("init");
		expect(offscreen).toHaveLength(2);
		expect(init?.transfer).toEqual([offscreen[0], offscreen[1], request.simulation]);
		expect((connect?.message as { type: string }).type).toBe("connect");
		expect(connect?.transfer).toHaveLength(1);
		expect(request.data.nodes).toHaveLength(2);

		const sent = () => renderer.messages.slice(1).map(({ message }) => (message as { input: { type: string } }).input);
		canvas?.dispatchEvent(new MouseEvent("click", { clientX: 4, clientY: 5, detail: 1, bubbles: true }));
		expect(sent()?.at(-1)).toEqual({ type: "click", x: 4, y: 5, detail: 1 });

		expect(press("ArrowDown")).toBe(false);
		const emit = (data: EngineOutput) => renderer.onmessage?.({ data });
		emit({ type: "select", id: "one" });
		emit({ type: "keys", keys: ["z", "Escape", "ArrowDown"] });
		emit({ type: "attribute", name: "data-layout", value: "cached" });
		emit({ type: "cursor", value: "grab" });
		expect(selections).toEqual(["one"]);
		expect(canvas?.dataset.layout).toBe("cached");
		expect(canvas?.style.cursor).toBe("grab");
		expect(press("ArrowDown")).toBe(true);
		expect(sent()?.at(-1)).toEqual({ type: "key", key: "ArrowDown" });

		scene.dispose();
		expect(simulation.terminated).toBe(1);
		expect(renderer.terminated).toBe(1);
		const count = renderer.messages.length;
		press("z");
		expect(renderer.messages.length).toBe(count);
	} finally {
		scene.dispose();
		Reflect.deleteProperty(dom.HTMLCanvasElement.prototype, "transferControlToOffscreen");
		for (const [name, descriptor] of previous) {
			if (descriptor) Object.defineProperty(globalThis, name, descriptor);
			else Reflect.deleteProperty(globalThis, name);
		}
		restore();
		dom.close();
	}
});

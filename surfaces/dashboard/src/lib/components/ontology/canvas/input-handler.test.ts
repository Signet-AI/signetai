// @ts-nocheck
import { describe, expect, test } from "bun:test";
import { SpatialIndex } from "./hit-test";
import { GraphInputHandler } from "./input-handler";
import type { GraphCanvasNode } from "./types";
import { ViewportState } from "./viewport";

type Listener = (event: EventLike) => void;

interface EventLike {
	readonly clientX: number;
	readonly clientY: number;
	readonly button?: number;
	readonly pointerId?: number;
	readonly isPrimary?: boolean;
	preventDefault?: () => void;
}

class FakeCanvas {
	readonly style: { cursor: string } = { cursor: "" };
	readonly captured = new Set<number>();
	readonly released = new Set<number>();
	private readonly listeners = new Map<string, Set<Listener>>();

	constructor(pointerEvents = false) {
		if (pointerEvents) {
			Object.defineProperty(this, "onpointerdown", { value: null, configurable: true });
		}
	}

	addEventListener(name: string, listener: Listener): void {
		const listeners = this.listeners.get(name) ?? new Set<Listener>();
		listeners.add(listener);
		this.listeners.set(name, listeners);
	}

	removeEventListener(name: string, listener: Listener): void {
		this.listeners.get(name)?.delete(listener);
	}

	getBoundingClientRect(): { left: number; top: number } {
		return { left: 0, top: 0 };
	}

	setPointerCapture(pointerId: number): void {
		this.captured.add(pointerId);
	}

	hasPointerCapture(pointerId: number): boolean {
		return this.captured.has(pointerId) && !this.released.has(pointerId);
	}

	releasePointerCapture(pointerId: number): void {
		this.released.add(pointerId);
	}

	fire(name: string, event: EventLike): void {
		for (const listener of this.listeners.get(name) ?? []) {
			listener(event);
		}
	}

	hasListener(name: string): boolean {
		return (this.listeners.get(name)?.size ?? 0) > 0;
	}
}

function node(overrides: Partial<GraphCanvasNode> = {}): GraphCanvasNode {
	return {
		id: "entity-1",
		kind: "entity",
		label: "Entity",
		x: 0,
		y: 0,
		size: 30,
		color: "#fff",
		dimColor: "#444",
		...overrides,
	};
}

function setup(pointerEvents: boolean): {
	canvas: FakeCanvas;
	target: GraphCanvasNode;
	handler: GraphInputHandler;
	dragStarts: GraphCanvasNode[];
	dragEnds: GraphCanvasNode[];
} {
	const canvas = new FakeCanvas(pointerEvents);
	const target = node();
	const spatial = new SpatialIndex();
	spatial.rebuild([target]);
	const dragStarts: GraphCanvasNode[] = [];
	const dragEnds: GraphCanvasNode[] = [];
	const handler = new GraphInputHandler(canvas as unknown as HTMLCanvasElement, new ViewportState(0, 0, 1), spatial, {
		onNodeHover: () => undefined,
		onNodeClick: () => undefined,
		onNodeDragStart: (item) => dragStarts.push(item),
		onNodeDragEnd: (item) => dragEnds.push(item),
		onNodeDoubleClick: () => undefined,
		onRequestRender: () => undefined,
	});
	return { canvas, target, handler, dragStarts, dragEnds };
}

describe("GraphInputHandler", () => {
	test("captures pointer drags so Electron canvas interaction survives frame-shell pointer routing", () => {
		const { canvas, target, handler, dragStarts, dragEnds } = setup(true);

		expect(canvas.hasListener("pointerdown")).toBe(true);
		expect(canvas.hasListener("mousedown")).toBe(false);

		canvas.fire("pointerdown", {
			clientX: 0,
			clientY: 0,
			button: 0,
			pointerId: 7,
			isPrimary: true,
			preventDefault: () => undefined,
		});
		canvas.fire("pointermove", { clientX: 20, clientY: 12, pointerId: 7, isPrimary: true });
		canvas.fire("pointerup", { clientX: 20, clientY: 12, pointerId: 7, isPrimary: true });

		expect(canvas.captured.has(7)).toBe(true);
		expect(canvas.released.has(7)).toBe(true);
		expect(target.x).toBe(20);
		expect(target.y).toBe(12);
		expect(target.fx).toBeNull();
		expect(target.fy).toBeNull();
		expect(dragStarts.map((item) => item.id)).toEqual(["entity-1"]);
		expect(dragEnds.map((item) => item.id)).toEqual(["entity-1"]);

		handler.destroy();
	});

	test("keeps the mouse fallback for non-pointer browsers", () => {
		const { canvas, target, handler, dragStarts, dragEnds } = setup(false);

		expect(canvas.hasListener("pointerdown")).toBe(false);
		expect(canvas.hasListener("mousedown")).toBe(true);

		canvas.fire("mousedown", { clientX: 0, clientY: 0, button: 0 });
		canvas.fire("mousemove", { clientX: 8, clientY: 9 });
		canvas.fire("mouseup", { clientX: 8, clientY: 9 });

		expect(target.x).toBe(8);
		expect(target.y).toBe(9);
		expect(dragStarts.map((item) => item.id)).toEqual(["entity-1"]);
		expect(dragEnds.map((item) => item.id)).toEqual(["entity-1"]);

		handler.destroy();
	});
});

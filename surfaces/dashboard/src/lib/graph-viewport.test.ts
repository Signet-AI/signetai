/*
MIT License

Copyright (c) 2025 supermemory

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

*/
import { describe, it, expect } from "bun:test";
import { ViewportState } from "./graph-viewport";

function makeNode(id: string, x: number, y: number): { id: string; x: number; y: number; size: number } {
	return { id, x, y, size: 50 };
}

function tickUntilSettled(vp: ViewportState, maxIter = 500): void {
	for (let i = 0; i < maxIter; i++) {
		if (!vp.tick()) break;
	}
}

describe("ViewportState", () => {
	it("constructor sets initial values", () => {
		const vp = new ViewportState();
		expect(vp.panX).toBe(0);
		expect(vp.panY).toBe(0);
		expect(vp.zoom).toBe(0.5);
	});

	it("constructor accepts custom initial values", () => {
		const vp = new ViewportState(10, 20, 1.5);
		expect(vp.panX).toBe(10);
		expect(vp.panY).toBe(20);
		expect(vp.zoom).toBe(1.5);
	});

	it("worldToScreen and screenToWorld are inverse operations", () => {
		const vp = new ViewportState(100, 50, 1.5);

		const worldX = 300;
		const worldY = 400;
		const screen = vp.worldToScreen(worldX, worldY);
		const world = vp.screenToWorld(screen.x, screen.y);

		expect(world.x).toBeCloseTo(worldX, 5);
		expect(world.y).toBeCloseTo(worldY, 5);
	});

	it("worldToScreen applies zoom and pan: screen = world * zoom + pan", () => {
		const vp = new ViewportState(10, 20, 2);

		const screen = vp.worldToScreen(100, 200);
		expect(screen.x).toBe(100 * 2 + 10);
		expect(screen.y).toBe(200 * 2 + 20);
	});

	it("screenToWorld reverses: world = (screen - pan) / zoom", () => {
		const vp = new ViewportState(10, 20, 2);

		const world = vp.screenToWorld(210, 420);
		expect(world.x).toBeCloseTo(100, 5);
		expect(world.y).toBeCloseTo(200, 5);
	});

	it("pan offsets correctly and accumulates", () => {
		const vp = new ViewportState(0, 0, 1);
		vp.pan(50, 30);
		expect(vp.panX).toBe(50);
		expect(vp.panY).toBe(30);

		vp.pan(10, 20);
		expect(vp.panX).toBe(60);
		expect(vp.panY).toBe(50);
	});

	it("pan cancels any animated pan target", () => {
		const vp = new ViewportState(0, 0, 1);
		vp.centerOn(500, 500, 800, 600);
		vp.pan(10, 10);

		expect(vp.tick()).toBe(false);
	});

	it("zoomImmediate multiplies current zoom by delta", () => {
		const vp = new ViewportState(0, 0, 1);
		const initialZoom = vp.zoom;
		vp.zoomImmediate(2, 0, 0);
		expect(vp.zoom).toBeCloseTo(initialZoom * 2);
	});

	it("zoomImmediate preserves world point under anchor", () => {
		const vp = new ViewportState(100, 50, 1);
		const anchorX = 400;
		const anchorY = 300;

		const worldBefore = vp.screenToWorld(anchorX, anchorY);
		vp.zoomImmediate(2, anchorX, anchorY);

		const worldAfter = vp.screenToWorld(anchorX, anchorY);

		expect(worldAfter.x).toBeCloseTo(worldBefore.x, 3);
		expect(worldAfter.y).toBeCloseTo(worldBefore.y, 3);
	});

	it("zoomImmediate clamps to MIN_ZOOM (0.1)", () => {
		const vp = new ViewportState(0, 0, 0.5);

		vp.zoomImmediate(0.01, 0, 0);
		expect(vp.zoom).toBeCloseTo(0.1);
	});

	it("can lower the minimum zoom to fit a large loaded graph", () => {
		const vp = new ViewportState(0, 0, 0.5);
		const nodes = [
			makeNode("a", 0, 0),
			makeNode("b", 10_000, 0),
			makeNode("c", 0, 10_000),
			makeNode("d", 10_000, 10_000),
		];

		vp.setMinZoomForNodes(nodes, 800, 600);
		vp.zoomImmediate(0.01, 0, 0);

		expect(vp.zoom).toBeLessThan(0.1);
		expect(vp.zoom).toBeGreaterThan(0.005);
	});

	it("zoomImmediate clamps to MAX_ZOOM (5.0)", () => {
		const vp = new ViewportState(0, 0, 2);

		vp.zoomImmediate(100, 0, 0);
		expect(vp.zoom).toBeCloseTo(5.0);
	});

	it("zoomTo sets target zoom (animated via tick)", () => {
		const vp = new ViewportState(0, 0, 0.5);
		vp.zoomTo(2, 400, 300);

		expect(vp.zoom).toBe(0.5);

		tickUntilSettled(vp);
		expect(vp.zoom).toBeCloseTo(2, 1);
	});

	it("tick returns false when no animation is active", () => {
		const vp = new ViewportState();
		expect(vp.tick()).toBe(false);
	});

	it("tick returns true during inertia", () => {
		const vp = new ViewportState();
		vp.releaseWithVelocity(10, 10);
		expect(vp.tick()).toBe(true);
	});

	it("tick returns true during zoom animation", () => {
		const vp = new ViewportState(0, 0, 0.5);
		vp.zoomTo(2, 0, 0);
		expect(vp.tick()).toBe(true);
	});

	it("tick returns true during pan animation", () => {
		const vp = new ViewportState(0, 0, 1);
		vp.centerOn(500, 500, 800, 600);
		expect(vp.tick()).toBe(true);
	});

	it("fitToNodes centers and scales to fit all nodes", () => {
		const vp = new ViewportState(0, 0, 0.5);
		const nodes = [makeNode("a", 0, 0), makeNode("b", 1000, 0), makeNode("c", 0, 1000), makeNode("d", 1000, 1000)];
		vp.fitToNodes(nodes, 800, 600);
		tickUntilSettled(vp);

		for (const node of nodes) {
			const screen = vp.worldToScreen(node.x, node.y);
			expect(screen.x).toBeGreaterThan(-100);
			expect(screen.x).toBeLessThan(900);
			expect(screen.y).toBeGreaterThan(-100);
			expect(screen.y).toBeLessThan(700);
		}
	});

	it("fitToNodes handles single node without throwing", () => {
		const vp = new ViewportState();
		expect(() => vp.fitToNodes([makeNode("a", 500, 500)], 800, 600)).not.toThrow();
	});

	it("fitToNodes handles empty nodes array without throwing", () => {
		const vp = new ViewportState();
		const zoomBefore = vp.zoom;
		vp.fitToNodes([], 800, 600);

		expect(vp.zoom).toBe(zoomBefore);
	});

	it("centerOn animates pan to center a world point on screen", () => {
		const vp = new ViewportState(0, 0, 1);
		vp.centerOn(500, 300, 800, 600);
		tickUntilSettled(vp);

		const screen = vp.worldToScreen(500, 300);
		expect(screen.x).toBeCloseTo(400, 0);
		expect(screen.y).toBeCloseTo(300, 0);
	});

	it("inertia decays to zero", () => {
		const vp = new ViewportState();
		vp.releaseWithVelocity(100, 100);
		tickUntilSettled(vp);

		expect(vp.tick()).toBe(false);
	});
});

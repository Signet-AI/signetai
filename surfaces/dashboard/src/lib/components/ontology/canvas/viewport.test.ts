// @ts-nocheck
import { describe, expect, it } from "bun:test";
import { ViewportState } from "./viewport";

describe("knowledge graph viewport", () => {
	it("keeps the world coordinate under the cursor stable during immediate zoom", () => {
		const viewport = new ViewportState(100, 80, 1);
		const before = viewport.screenToWorld(240, 180);

		viewport.zoomImmediate(1.5, 240, 180);

		expect(viewport.screenToWorld(240, 180)).toEqual(before);
	});

	it("fits nodes into the viewport with bounded zoom", () => {
		const viewport = new ViewportState(0, 0, 1);

		viewport.fitToNodes(
			[
				{ x: -100, y: -50, size: 20 },
				{ x: 100, y: 50, size: 20 },
			],
			400,
			240,
		);

		for (let i = 0; i < 60; i++) viewport.tick();
		const left = viewport.worldToScreen(-120, -70);
		const right = viewport.worldToScreen(120, 70);

		expect(left.x).toBeGreaterThanOrEqual(-1);
		expect(left.y).toBeGreaterThanOrEqual(-1);
		expect(right.x).toBeLessThanOrEqual(401);
		expect(right.y).toBeLessThanOrEqual(241);
	});

	it("honors a tighter max zoom for focused neighborhoods", () => {
		const viewport = new ViewportState(0, 0, 0.4);

		viewport.fitToNodes([{ x: 10, y: 10, size: 20 }], 800, 600, { maxZoom: 1.05 });

		for (let i = 0; i < 60; i++) viewport.tick();

		expect(viewport.zoom).toBeLessThanOrEqual(1.051);
	});

	it("moves programmatic focus toward one stable camera target", () => {
		const viewport = new ViewportState(0, 0, 0.25);

		viewport.fitToNodes([{ x: 500, y: -200, size: 20 }], 800, 600, { maxZoom: 0.7 });

		let previousDistance = Number.POSITIVE_INFINITY;
		for (let i = 0; i < 30; i++) {
			viewport.tick();
			const screen = viewport.worldToScreen(500, -200);
			const distance = Math.hypot(screen.x - 400, screen.y - 300);
			expect(distance).toBeLessThanOrEqual(previousDistance + 0.001);
			previousDistance = distance;
		}
	});
});

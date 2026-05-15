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
});

import { describe, expect, test } from "bun:test";
import { graphHomeCameraDistance } from "./graph-camera";

const sceneSource = await Bun.file(new URL("./graph-scene.ts", import.meta.url)).text();

describe("graph home camera framing", () => {
	test("preserves the desktop home distance on a wide canvas", () => {
		expect(graphHomeCameraDistance(1920, 1080)).toBe(520);
	});

	test("uses a capped pullback on the tall narrow canvas without making the scene vanish", () => {
		const distance = graphHomeCameraDistance(620, 940);
		expect(distance).toBeGreaterThanOrEqual(590);
		expect(distance).toBeLessThanOrEqual(620);
	});

	test("caps the adjustment even on extremely tall canvases", () => {
		expect(graphHomeCameraDistance(500, 1000)).toBe(620);
	});

	test("uses the capped distance for initial framing and untouched resize framing", () => {
		expect(sceneSource).toContain("graphHomeCameraDistance(w, h)");
		expect(sceneSource).toContain("graphHomeCameraDistance(nw, nh)");
	});
});

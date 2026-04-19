// @ts-nocheck
import { describe, expect, it } from "bun:test";
import { clampPage } from "./plugin-pagination";

describe("plugin pagination", () => {
	it("clamps stale page indexes when refreshed data has fewer pages", () => {
		expect(clampPage(4, 6, 5)).toBe(1);
		expect(clampPage(3, 2, 5)).toBe(0);
	});

	it("keeps valid page indexes unchanged", () => {
		expect(clampPage(1, 12, 5)).toBe(1);
	});
});

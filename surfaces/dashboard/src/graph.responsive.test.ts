import { describe, expect, test } from "bun:test";

const stylesheet = await Bun.file(new URL("./index.css", import.meta.url)).text();

describe("graph responsive overlays", () => {
	test("preserves a minimum graph scene height when a constrained window would clip the dock", () => {
		expect(stylesheet).toMatch(/@media \(max-width: 900px\)[\s\S]*\.graph-view-root \{ min-height: 360px;/);
	});

	test("reserves space for the legend and wraps the mobile density HUD", () => {
		expect(stylesheet).toMatch(/\.graph-hud \{[^}]*max-width: calc\(100% - 76px\);[^}]*flex-wrap: wrap;/);
		expect(stylesheet).toMatch(
			/@media \(max-width: 640px\)[\s\S]*\.graph-hud-density input\[type="range"\] \{ width: 56px;/,
		);
	});

	test("lets the query input shrink instead of forcing the graph dock out of view", () => {
		expect(stylesheet).toMatch(/\.gd-input \{[^}]*min-width: 0;/);
	});
});

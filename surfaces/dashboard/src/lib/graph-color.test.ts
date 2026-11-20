import { describe, expect, test } from "bun:test";
import { colorNodes, DEFAULT_COLOR_CONFIG, GRAPH_COLOR_MODES, rampPosition, sampleRamp } from "./graph-color";
import type { SceneNode } from "./graph-scene";

const node = (id: string, cluster: string, confidence?: number): SceneNode => ({
	id,
	label: id,
	kind: confidence === undefined ? "group" : "attribute",
	cluster,
	weight: 1,
	metric: "",
	...(confidence === undefined ? {} : { confidence }),
});

describe("graph color", () => {
	test("log scale gives recent ages more of the ramp than a linear scale", () => {
		const linear = { ...DEFAULT_COLOR_CONFIG, log: false };
		const log = { ...DEFAULT_COLOR_CONFIG, log: true };
		expect(rampPosition(linear, 1, 0, 45)).toBeCloseTo(1 / 45);
		expect(rampPosition(log, 1, 0, 45)).toBeCloseTo(Math.log(2) / Math.log(46));
		expect(rampPosition(log, 45, 0, 45)).toBe(1);
	});

	test("bands snap positions to evenly spaced steps", () => {
		const banded = { ...DEFAULT_COLOR_CONFIG, bands: 4 };
		expect([0, 0.2, 0.3, 0.6, 1].map((value) => rampPosition(banded, value, 0, 1))).toEqual([0, 0, 1 / 3, 2 / 3, 1]);
	});

	test("unvalued nodes take their cluster's mean or the missing color", () => {
		const nodes = [node("a", "x", 0), node("b", "x", 1), node("g", "x"), node("lone", "y")];
		const config = { ...DEFAULT_COLOR_CONFIG, stops: ["#000000", "#ffffff"], interpolation: "rgb" as const };
		const inherited = colorNodes(nodes, config);
		expect(inherited.colors.get("a")).toBe("#000000");
		expect(inherited.colors.get("b")).toBe("#ffffff");
		expect(inherited.colors.get("g")).toBe(sampleRamp(config.stops, 0.5, "rgb"));
		expect(inherited.colors.get("lone")).toBe(config.missing);
		expect(colorNodes(nodes, { ...config, inherit: false }).colors.get("g")).toBe(config.missing);
	});

	test("the shipped modes keep category as the uncolored default", () => {
		expect(GRAPH_COLOR_MODES.map((mode) => [mode.key, mode.config?.variable ?? null])).toEqual([
			["category", null],
			["mentions", "mentions"],
			["age", "created"],
		]);
	});
});

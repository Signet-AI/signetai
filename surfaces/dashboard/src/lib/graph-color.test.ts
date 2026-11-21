import { describe, expect, test } from "bun:test";
import {
	colorNodes,
	DEFAULT_COLOR_CONFIG,
	GRAPH_COLOR_MODES,
	parseColorConfig,
	rampPosition,
	sampleRamp,
} from "./graph-color";
import { entitySceneNode } from "./constellation-display";
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
		const linear = { ...DEFAULT_COLOR_CONFIG, scale: "linear" as const };
		const log = { ...DEFAULT_COLOR_CONFIG, scale: "log" as const };
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

	test("mentions color raw counts on entity and source-document nodes, not connected sources", () => {
		const mentions = GRAPH_COLOR_MODES.find((mode) => mode.key === "mentions")?.config;
		if (!mentions) throw new Error("mentions mode is missing");
		const entity = (id: string, entityType: string, count: number) => ({
			id,
			agentId: "default",
			name: id,
			entityType,
			mentions: count,
			pinned: false,
			aspects: [],
		});
		const rows = [
			entity("few", "person", 25),
			entity("many", "project", 100),
			entity("doc", "source_document", 4),
			entity("ref", "source_document_reference", 64),
		];
		const nodes: SceneNode[] = [
			...rows.map((row) => entitySceneNode(row, 100)),
			{ id: "source:vault", label: "vault", kind: "source", cluster: "source", weight: 1, metric: "" },
		];
		expect(nodes.map((node) => node.kind)).toEqual(["entity", "entity", "source", "source", "source"]);
		const coloring = colorNodes(nodes, mentions);
		expect([coloring.valued, coloring.min, coloring.max]).toEqual([4, 4, 100]);
		const colors = rows.map((row) => coloring.colors.get(row.id));
		expect(new Set(colors).size).toBe(4);
		expect(colors).not.toContain(mentions.missing);
		expect(coloring.colors.get("source:vault")).toBe(mentions.missing);
		const share = (count: number) => Math.sqrt(count / 100);
		expect(rampPosition(mentions, 25, 4, 100)).toBe(
			rampPosition({ ...mentions, scale: "linear" }, share(25), share(4), share(100)),
		);
	});

	test("age colors read the clock once, so identical timestamps share a color", () => {
		const age = GRAPH_COLOR_MODES.find((mode) => mode.key === "age")?.config;
		if (!age) throw new Error("age mode is missing");
		const created = Date.UTC(2026, 0, 1);
		const nodes: SceneNode[] = ["a", "b", "c"].map((id) => ({
			id,
			label: id,
			kind: "entity",
			cluster: id,
			weight: 1,
			metric: "",
			createdAt: created,
		}));
		const realNow = Date.now;
		let clock = created + 10 * 86_400_000;
		Date.now = () => clock++;
		try {
			const coloring = colorNodes(nodes, age);
			expect(new Set(coloring.colors.values()).size).toBe(1);
			expect(coloring.min).toBe(coloring.max);
		} finally {
			Date.now = realNow;
		}
		const later = colorNodes(nodes, age, created + 11 * 86_400_000);
		expect(later.min).toBe(11);
	});

	test("stored lab presets with the legacy log flag load as log scale", () => {
		expect(parseColorConfig({ variable: "created", stops: ["#000000"], log: true })?.scale).toBe("log");
		expect(parseColorConfig({ variable: "created", stops: ["#000000"], scale: "sqrt" })?.scale).toBe("sqrt");
	});

	test("the shipped modes keep category as the uncolored default", () => {
		expect(GRAPH_COLOR_MODES.map((mode) => [mode.key, mode.config?.variable ?? null])).toEqual([
			["category", null],
			["mentions", "mentions"],
			["age", "created"],
		]);
	});
});

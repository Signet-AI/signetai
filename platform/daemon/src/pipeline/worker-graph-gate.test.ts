import { describe, expect, test } from "bun:test";
import { DEFAULT_PIPELINE_V2 } from "../memory-config";
import { shouldPersistExtractionGraph } from "./worker";

describe("shouldPersistExtractionGraph", () => {
	test("persists extracted graph entities by default", () => {
		const cfg = {
			...DEFAULT_PIPELINE_V2,
			graph: {
				...DEFAULT_PIPELINE_V2.graph,
				enabled: true,
			},
		};

		expect(shouldPersistExtractionGraph(cfg, 2)).toBe(true);
	});

	test("respects explicit extraction write opt-out", () => {
		const cfg = {
			...DEFAULT_PIPELINE_V2,
			graph: {
				...DEFAULT_PIPELINE_V2.graph,
				enabled: true,
				extractionWritesEnabled: false,
			},
		};

		expect(shouldPersistExtractionGraph(cfg, 2)).toBe(false);
	});

	test("requires the explicit extraction write gate", () => {
		const cfg = {
			...DEFAULT_PIPELINE_V2,
			graph: {
				...DEFAULT_PIPELINE_V2.graph,
				enabled: true,
				extractionWritesEnabled: true,
			},
		};

		expect(shouldPersistExtractionGraph(cfg, 2)).toBe(true);
		expect(shouldPersistExtractionGraph(cfg, 0)).toBe(false);
	});
});

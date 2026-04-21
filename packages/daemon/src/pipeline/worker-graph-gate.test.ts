import { describe, expect, test } from "bun:test";
import { DEFAULT_PIPELINE_V2 } from "../memory-config";
import { shouldPersistExtractionGraph } from "./worker";

describe("shouldPersistExtractionGraph", () => {
	test("does not let graph reads imply background extraction graph writes", () => {
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

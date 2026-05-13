import { describe, expect, it } from "bun:test";
import { modelPresetsForProvider } from "./llm-model-catalog";

describe("modelPresetsForProvider", () => {
	it("returns checked presets for catalog-owned providers", () => {
		expect(modelPresetsForProvider("codex").map((preset) => preset.value)).toContain("gpt-5.4-mini");
	});

	it("ignores inherited object keys instead of indexing prototype values", () => {
		expect(modelPresetsForProvider("constructor")).toEqual([]);
		expect(modelPresetsForProvider("__proto__")).toEqual([]);
	});
});

import { describe, expect, it } from "bun:test";
import { MODEL_DEFAULTS, modelPresetsForProvider } from "./llm-model-catalog";

describe("modelPresetsForProvider", () => {
	it("returns checked presets for catalog-owned providers", () => {
		expect(modelPresetsForProvider("codex").map((preset) => preset.value)).toContain("gpt-5.4-mini");
	});

	it("returns the managed Kimi model with harness source", () => {
		const presets = modelPresetsForProvider("kimi");
		expect(presets.map((preset) => preset.value)).toEqual(["kimi-code/kimi-for-coding"]);
		expect(presets.map((preset) => preset.label)).toEqual(["Kimi for Coding"]);
		expect(presets.every((preset) => preset.source === "harness")).toBe(true);
	});

	it("defaults kimi to its managed coding model", () => {
		expect(MODEL_DEFAULTS.kimi).toBe("kimi-code/kimi-for-coding");
	});

	it("ignores inherited object keys instead of indexing prototype values", () => {
		expect(modelPresetsForProvider("constructor")).toEqual([]);
		expect(modelPresetsForProvider("__proto__")).toEqual([]);
	});
});

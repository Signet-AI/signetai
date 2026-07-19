import { describe, expect, it } from "bun:test";
import { MODEL_DEFAULTS, modelPresetsForProvider } from "./llm-model-catalog";

describe("modelPresetsForProvider", () => {
	it("returns checked presets for catalog-owned providers", () => {
		expect(modelPresetsForProvider("codex").map((preset) => preset.value)).toContain("gpt-5.4-mini");
	});

	it("returns the kimi presets with harness source", () => {
		const presets = modelPresetsForProvider("kimi");
		expect(presets.map((preset) => preset.value)).toEqual(["kimi-k3", "kimi-k2.7", "kimi-k2.6"]);
		expect(presets.map((preset) => preset.label)).toEqual(["Kimi K3", "Kimi K2.7", "Kimi K2.6"]);
		expect(presets.every((preset) => preset.source === "harness")).toBe(true);
	});

	it("defaults kimi to kimi-k2.7", () => {
		expect(MODEL_DEFAULTS.kimi).toBe("kimi-k2.7");
	});

	it("ignores inherited object keys instead of indexing prototype values", () => {
		expect(modelPresetsForProvider("constructor")).toEqual([]);
		expect(modelPresetsForProvider("__proto__")).toEqual([]);
	});
});

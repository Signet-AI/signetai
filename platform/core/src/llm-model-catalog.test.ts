import { describe, expect, it } from "bun:test";
import { modelPresetsForProvider } from "./llm-model-catalog";

describe("modelPresetsForProvider", () => {
	it("returns checked presets for catalog-owned providers", () => {
		expect(modelPresetsForProvider("codex").map((preset) => preset.value)).toContain("gpt-5.4-mini");
		expect(modelPresetsForProvider("codex").map((preset) => preset.value)).toContain("gpt-5.6-luna");
		expect(modelPresetsForProvider("anthropic").map((preset) => preset.value)).toContain("claude-sonnet-4-6");
		expect(modelPresetsForProvider("openrouter").map((preset) => preset.value)).toContain("deepseek/deepseek-v4-pro");
	});

	it("ignores inherited object keys instead of indexing prototype values", () => {
		expect(modelPresetsForProvider("constructor")).toEqual([]);
		expect(modelPresetsForProvider("__proto__")).toEqual([]);
	});
});

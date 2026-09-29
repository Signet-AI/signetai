import { describe, expect, it } from "bun:test";
import { MODEL_DEFAULTS, modelPresetsForProvider } from "./llm-model-catalog";

describe("modelPresetsForProvider", () => {
	it("returns checked presets for catalog-owned providers", () => {
		expect(modelPresetsForProvider("codex").map((preset) => preset.value)).toContain("gpt-6.1-sol");
		expect(modelPresetsForProvider("codex").map((preset) => preset.value)).not.toContain("gpt-5.4-mini");
		expect(modelPresetsForProvider("anthropic").map((preset) => preset.value)).toContain("claude-sonnet-5-5");
		expect(modelPresetsForProvider("anthropic").map((preset) => preset.value)).toContain("claude-opus-5-5");
		expect(modelPresetsForProvider("openrouter").map((preset) => preset.value)).toContain("deepseek/deepseek-v4-pro");
		expect(modelPresetsForProvider("openrouter").map((preset) => preset.value)).toContain(
			"anthropic/claude-sonnet-5.5",
		);
		expect(MODEL_DEFAULTS.codex).toBe("gpt-6-luna");
	});

	it("ignores inherited object keys instead of indexing prototype values", () => {
		expect(modelPresetsForProvider("constructor")).toEqual([]);
		expect(modelPresetsForProvider("__proto__")).toEqual([]);
	});
});

import { describe, expect, it } from "bun:test";
import { getBuiltinModels } from "@earendil-works/pi-ai/providers/all";
import type { ModelRegistryEntry } from "@signet/core";
import { PIPELINE_MODEL_CATALOG } from "@signet/core";
import {
	getAvailableModels,
	getModelsByProvider,
	getRegistryStatus,
	markDeprecatedVersions,
	refreshRegistry,
} from "./model-registry";

describe("static model registry", () => {
	it("preserves entries instead of synthesizing deprecation from model names", () => {
		const entries: ModelRegistryEntry[] = [
			{
				id: "provider/known-older",
				provider: "checked-provider",
				label: "Known older",
				tier: "mid",
				deprecated: false,
			},
			{
				id: "provider/known-newer",
				provider: "checked-provider",
				label: "Known newer",
				tier: "high",
				deprecated: false,
			},
		];
		const result = markDeprecatedVersions(entries);
		expect(result).toEqual(entries);
		expect(result).not.toBe(entries);
	});

	it("exposes checked ACPX passthrough presets without invented Codex names", () => {
		const acpx = getAvailableModels("acpx").map((model) => model.id);
		expect(acpx).toContain("gpt-5.4-mini");
		expect(acpx).toContain("haiku");
		expect(acpx).toContain("opencode/gemini-3-flash");
		expect(acpx).not.toContain("gpt-5-codex");
		expect(acpx).not.toContain("gpt-5-codex-mini");
	});

	it("groups checked catalog entries by provider", () => {
		const byProvider = getModelsByProvider();
		expect(byProvider.codex.map((model) => model.id)).toContain("gpt-6.1-sol");
		expect(byProvider.codex.map((model) => model.id)).not.toContain("gpt-5.4-mini");
		expect(byProvider.anthropic.map((model) => model.id)).toContain("claude-sonnet-5-5");
		expect(byProvider.openrouter.map((model) => model.id)).toContain("anthropic/claude-sonnet-5.5");
		expect(byProvider.acpx.map((model) => model.id)).toContain("gpt-5.4-mini");
	});

	it("keeps Pi-backed presets present in the bundled SDK registries", () => {
		for (const [provider, sdkProvider] of [
			["codex", "openai-codex"],
			["anthropic", "anthropic"],
			["openrouter", "openrouter"],
		] as const) {
			const available = new Set(getBuiltinModels(sdkProvider).map((model) => model.id));
			expect(PIPELINE_MODEL_CATALOG[provider].every((preset) => available.has(preset.value))).toBe(true);
		}
	});

	it("keeps refresh API-compatible without changing the static catalog", async () => {
		const before = getModelsByProvider();
		await refreshRegistry();
		expect(getModelsByProvider()).toEqual(before);
		expect(getRegistryStatus().initialized).toBe(true);
	});
});

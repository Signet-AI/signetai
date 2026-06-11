import { describe, expect, it } from "bun:test";
import type { ModelRegistryEntry } from "@signetai/core";
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
		expect(acpx).toContain("google/gemini-2.5-flash");
		expect(acpx).not.toContain("gpt-5-codex");
		expect(acpx).not.toContain("gpt-5-codex-mini");
	});

	it("groups checked catalog entries by provider", () => {
		const byProvider = getModelsByProvider();
		expect(byProvider.codex.map((model) => model.id)).toEqual([
			"gpt-5.4-mini",
			"gpt-5.4",
			"gpt-5.5",
			"gpt-5.3-codex",
			"gpt-5.3-codex-spark",
			"gpt-5.2",
		]);
		expect(byProvider.acpx.map((model) => model.id)).toContain("gpt-5.4-mini");
	});

	it("keeps refresh API-compatible without changing the static catalog", async () => {
		const before = getModelsByProvider();
		await refreshRegistry();
		expect(getModelsByProvider()).toEqual(before);
		expect(getRegistryStatus().initialized).toBe(true);
	});
});

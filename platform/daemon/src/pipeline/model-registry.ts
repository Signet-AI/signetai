import { type ModelRegistryEntry, PIPELINE_MODEL_CATALOG, type PipelineModelPreset } from "@signetai/core";

function toEntry(provider: string, preset: PipelineModelPreset): ModelRegistryEntry {
	return {
		id: preset.value,
		provider,
		label: preset.label,
		tier: preset.tier,
		deprecated: false,
	};
}

function catalogEntries(provider: string): ModelRegistryEntry[] {
	const presets = Object.prototype.hasOwnProperty.call(PIPELINE_MODEL_CATALOG, provider)
		? PIPELINE_MODEL_CATALOG[provider as keyof typeof PIPELINE_MODEL_CATALOG]
		: [];
	return presets.map((preset) => toEntry(provider, preset));
}

function allCatalogEntries(): ModelRegistryEntry[] {
	return Object.keys(PIPELINE_MODEL_CATALOG).flatMap(catalogEntries);
}

export function markDeprecatedVersions(entries: readonly ModelRegistryEntry[]): ModelRegistryEntry[] {
	return entries.map((entry) => ({ ...entry }));
}

export function initModelRegistry(): void {
	// Kept as an API-compatible no-op. Model IDs now come from the checked-in
	// provider/harness catalog in @signetai/core, not runtime synthesis or probing.
}

export async function refreshRegistry(): Promise<void> {
	// Deliberately static. Local/provider discovery should be explicit per
	// provider setup flow, never a background registry that invents options.
}

export function getAvailableModels(provider?: string, includeDeprecated = false): ModelRegistryEntry[] {
	const models = provider ? catalogEntries(provider) : allCatalogEntries();
	return includeDeprecated ? models : models.filter((model) => !model.deprecated);
}

export function getModelsByProvider(): Record<string, ModelRegistryEntry[]> {
	const result: Record<string, ModelRegistryEntry[]> = {};
	for (const provider of Object.keys(PIPELINE_MODEL_CATALOG)) {
		const entries = catalogEntries(provider).filter((model) => !model.deprecated);
		if (entries.length > 0) result[provider] = entries;
	}
	return result;
}

export function getRegistryStatus(): {
	initialized: boolean;
	lastRefreshAt: number;
	modelCounts: Record<string, number>;
} {
	const modelCounts: Record<string, number> = {};
	for (const [provider, models] of Object.entries(getModelsByProvider())) {
		modelCounts[provider] = models.length;
	}
	return { initialized: true, lastRefreshAt: 0, modelCounts };
}

export function stopModelRegistry(): void {
	// no-op
}

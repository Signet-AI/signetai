import type { SkillSearchResult } from "$lib/api";
import type { ProviderFilter } from "$lib/stores/skills.svelte";

export function getSkillsProviderLabel(value: ProviderFilter): string {
	if (value === "signet") return "Signet";
	if (value === "skills.sh") return "skills.sh";
	if (value === "clawhub") return "ClawHub";
	return "All providers";
}

export function normalizeSkillsProviderFilter(value: string): ProviderFilter {
	if (value === "signet" || value === "skills.sh" || value === "clawhub") return value;
	return "all";
}

export function filterSkillsByProvider(
	items: readonly SkillSearchResult[],
	provider: ProviderFilter,
): SkillSearchResult[] {
	if (provider === "all") return [...items];
	return items.filter((item) => item.provider === provider);
}

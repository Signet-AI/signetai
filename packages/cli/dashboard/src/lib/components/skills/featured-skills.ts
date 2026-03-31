import type { SkillSearchResult } from "$lib/api";

export function isOfficialSkill(item: SkillSearchResult): boolean {
	if (item.provider === "signet") return true;
	return item.official === true;
}

function parseTime(input: string | undefined): number {
	if (!input) return 0;
	const time = Date.parse(input);
	return Number.isFinite(time) ? time : 0;
}

function fallbackWeight(item: SkillSearchResult): number {
	return item.popularityScore ?? item.installsRaw ?? 0;
}

function compareUsage(a: SkillSearchResult, b: SkillSearchResult): number {
	const featuredDiff = (b.featuredScore ?? 0) - (a.featuredScore ?? 0);
	if (featuredDiff !== 0) return featuredDiff;
	const useDiff = (b.useCount ?? 0) - (a.useCount ?? 0);
	if (useDiff !== 0) return useDiff;
	const timeDiff = parseTime(b.lastUsedAt) - parseTime(a.lastUsedAt);
	if (timeDiff !== 0) return timeDiff;
	const fallbackDiff = fallbackWeight(b) - fallbackWeight(a);
	if (fallbackDiff !== 0) return fallbackDiff;
	return a.name.localeCompare(b.name);
}

export function getFeaturedOfficialSkills(items: readonly SkillSearchResult[], limit = 6): SkillSearchResult[] {
	return [...items]
		.filter(isOfficialSkill)
		.sort((a, b) => {
			const builtInDiff = Number(b.builtin === true) - Number(a.builtin === true);
			if (builtInDiff !== 0) return builtInDiff;
			return compareUsage(a, b);
		})
		.slice(0, limit);
}

export function omitFeaturedSkills(
	items: readonly SkillSearchResult[],
	featured: readonly SkillSearchResult[],
): SkillSearchResult[] {
	const names = new Set(featured.map((item) => item.name));
	return items.filter((item) => !names.has(item.name));
}

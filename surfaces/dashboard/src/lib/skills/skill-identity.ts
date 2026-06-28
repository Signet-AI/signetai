import type { Skill, SkillSearchResult } from "$lib/api";

export function isSkillSearchResult(item: Skill | SkillSearchResult): item is SkillSearchResult {
	return "installed" in item && "fullName" in item;
}

export function skillIdentityKey(item: Skill | SkillSearchResult): string {
	if (isSkillSearchResult(item)) {
		if (item.catalogKey) return item.catalogKey;
		return `${item.provider ?? "external"}:${item.fullName}:${item.name}`;
	}
	return `installed:${item.name}`;
}

export function skillRenderKey(item: Skill | SkillSearchResult, index: number): string {
	return `${skillIdentityKey(item)}:${index}`;
}

export function skillSource(item: Skill | SkillSearchResult): string | undefined {
	return isSkillSearchResult(item) ? item.fullName : undefined;
}

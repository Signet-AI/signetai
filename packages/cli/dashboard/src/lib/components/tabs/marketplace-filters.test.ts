// @ts-nocheck
import { describe, expect, it } from "bun:test";
import {
	filterSkillsByProvider,
	getSkillsProviderLabel,
	normalizeSkillsProviderFilter,
} from "./marketplace-filters";

const items = [
	{
		name: "official-a",
		fullName: "Signet-AI/signetai",
		installs: "--",
		installsRaw: 10,
		popularityScore: 10,
		description: "official",
		installed: false,
		provider: "signet",
	},
	{
		name: "community-a",
		fullName: "someone/community-a",
		installs: "--",
		installsRaw: 100,
		popularityScore: 100,
		description: "community",
		installed: false,
		provider: "skills.sh",
	},
];

describe("marketplace skill provider filter", () => {
	it("selects the signet provider and round-trips the rail label", () => {
		const provider = normalizeSkillsProviderFilter("signet");
		expect(provider).toBe("signet");
		expect(getSkillsProviderLabel(provider)).toBe("Signet");
		expect(filterSkillsByProvider(items, provider).map((item) => item.name)).toEqual(["official-a"]);
	});

	it("falls back to all providers for unknown values", () => {
		const provider = normalizeSkillsProviderFilter("nope");
		expect(provider).toBe("all");
		expect(getSkillsProviderLabel(provider)).toBe("All providers");
		expect(filterSkillsByProvider(items, provider).map((item) => item.name)).toEqual([
			"official-a",
			"community-a",
		]);
	});
});

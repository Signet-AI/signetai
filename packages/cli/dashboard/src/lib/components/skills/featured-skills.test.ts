// @ts-nocheck
import { describe, expect, it } from "bun:test";
import { getFeaturedOfficialSkills, omitFeaturedSkills } from "./featured-skills";

const items = [
	{
		name: "community-top",
		fullName: "someone/community-top",
		installs: "9.9K",
		installsRaw: 9900,
		popularityScore: 9900,
		description: "community",
		installed: false,
		provider: "skills.sh",
	},
	{
		name: "official-built-in-low",
		fullName: "Signet-AI/signetai",
		installs: "built-in",
		installsRaw: 100000,
		popularityScore: 200000,
		useCount: 2,
		description: "official built in low",
		installed: false,
		provider: "signet",
		official: true,
		builtin: true,
	},
	{
		name: "official-built-in-high",
		fullName: "Signet-AI/signetai",
		installs: "built-in",
		installsRaw: 100000,
		popularityScore: 100000,
		useCount: 8,
		description: "official built in high",
		installed: false,
		provider: "signet",
		official: true,
		builtin: true,
	},
	{
		name: "official-high",
		fullName: "Signet-AI/signetai",
		installs: "--",
		installsRaw: 1000,
		popularityScore: 50000,
		useCount: 11,
		description: "official high",
		installed: false,
		provider: "signet",
		official: true,
	},
	{
		name: "official-low",
		fullName: "Signet-AI/signetai",
		installs: "--",
		installsRaw: 100,
		popularityScore: 1000,
		useCount: 1,
		description: "official low",
		installed: false,
		provider: "signet",
		official: true,
	},
];

describe("featured official skills", () => {
	it("keeps built-in official skills ahead of other official skills", () => {
		const featured = getFeaturedOfficialSkills(items, 4);
		expect(featured.map((item) => item.name)).toEqual([
			"official-built-in-high",
			"official-built-in-low",
			"official-high",
			"official-low",
		]);
	});

	it("uses popularity fallback ordering when usage data is absent within each built-in bucket", () => {
		const featured = getFeaturedOfficialSkills(
			items.map((item) => ({ ...item, useCount: undefined, lastUsedAt: undefined, featuredScore: undefined })),
			4,
		);
		expect(featured.map((item) => item.name)).toEqual([
			"official-built-in-low",
			"official-built-in-high",
			"official-high",
			"official-low",
		]);
	});

	it("removes featured skills from the main browse grid", () => {
		const featured = getFeaturedOfficialSkills(items, 2);
		const rest = omitFeaturedSkills(items, featured);
		expect(rest.map((item) => item.name)).toEqual(["community-top", "official-high", "official-low"]);
	});
});

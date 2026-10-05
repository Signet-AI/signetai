import { describe, expect, it } from "bun:test";
import { findUnresolvedRelativeTime } from "./claim-relative-time";

describe("claim relative time", () => {
	it("finds relative times that go stale once the conversation is over", () => {
		const cases: readonly [string, string][] = [
			["The user went hiking yesterday.", "yesterday"],
			["The user spent $120 on bus fare last month.", "last month"],
			["The user is hosting a barbecue this weekend.", "this weekend"],
			["The user adopted a cat three weeks ago.", "three weeks ago"],
			["The user started a pottery class 2 months ago.", "2 months ago"],
			["The user moves to Denver next Saturday.", "next Saturday"],
			["The user finishes the course in a few weeks.", "in a few weeks"],
			["The user got promoted earlier this year.", "earlier this year"],
		];
		for (const [text, phrase] of cases) expect(findUnresolvedRelativeTime(text)).toBe(phrase);
	});

	it("allows absolute dates, vague times, and fixed calendar phrases", () => {
		const allowed = [
			"On 2023-03-19 the user completed the Walk for Hunger.",
			"The user recently started learning Spanish.",
			"The user's wedding is in the last week of May 2024.",
			"The user has lived in Denver since May 2024.",
			"The user prefers to work in the morning.",
			"The user takes a monthly yoga class.",
		];
		for (const text of allowed) expect(findUnresolvedRelativeTime(text)).toBeNull();
	});
});

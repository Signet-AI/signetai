import { describe, expect, it } from "bun:test";
import { findUnresolvedRelativeTime, findUntimedIsoDate } from "./claim-relative-time";

describe("claim relative time", () => {
	it("finds relative times that go stale once the conversation is over", () => {
		const cases: readonly [string, string][] = [
			["The user went hiking yesterday.", "yesterday"],
			["The user spent $120 on bus fare last month.", "last month"],
			["The user is hosting a barbecue this weekend.", "this weekend"],
			["The user adopted a cat three weeks ago.", "three weeks ago"],
			["The user started a pottery class 2 months ago.", "2 months ago"],
			["The user moves to Denver next Saturday.", "next Saturday"],
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
			"On 2023-05-26 the user binge-watched an entire season of The Crown in one day.",
			"The user finishes the course in a few weeks, which is what the instructor promised.",
			"On 2023-05-29 the user planned to follow up the next week (week of 2023-06-05) with the recruiter.",
			"The user ran a campaign in April 2023 ('last month' as of 2023-05-20).",
			"On 19 March 2023 the user said they had started running last month.",
		];
		for (const text of allowed) expect(findUnresolvedRelativeTime(text)).toBeNull();
	});
});

describe("findUntimedIsoDate", () => {
	it("flags a dated claim that sets no claim time", () => {
		expect(findUntimedIsoDate("The user saw Queen live with their parents shortly before 2023-04-15.", {})).toBe(
			"2023-04-15",
		);
	});

	it("accepts any claim time field, and undated text", () => {
		const text = "As of 2023-05-23 the user was thinking of getting a new wireless mouse.";
		expect(findUntimedIsoDate(text, { valid_from: "2023-05-23" })).toBeNull();
		expect(findUntimedIsoDate(text, { occurred_at: "2023-05-23" })).toBeNull();
		expect(findUntimedIsoDate("The user's lease ends 2024-06-30.", { valid_until: "2024-06-30" })).toBeNull();
		expect(findUntimedIsoDate("Acme plans to travel on 2026-08-03.", { review_after: "2026-08-03" })).toBeNull();
		expect(findUntimedIsoDate("The user prefers to work in the morning.", {})).toBeNull();
		expect(findUntimedIsoDate("The user ran a campaign in April 2023.", {})).toBeNull();
	});
});

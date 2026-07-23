import { describe, expect, it } from "bun:test";
import { firstCandidateBlockedBy } from "./extraction-status";

describe("firstCandidateBlockedBy", () => {
	it("returns the first routing candidate's valid gate reasons in order", () => {
		expect(
			firstCandidateBlockedBy({
				trace: {
					candidates: [
						{
							blockedBy: [
								"privacy gate (restricted_remote)",
								"missing credential for issue-1003",
								42,
								"",
								"account state missing",
							],
						},
						{ blockedBy: ["second candidate reason"] },
					],
				},
			}),
		).toEqual(["privacy gate (restricted_remote)", "missing credential for issue-1003", "account state missing"]);
	});

	it("returns an empty array when the router failure has no candidate trace", () => {
		expect(firstCandidateBlockedBy(undefined)).toEqual([]);
		expect(firstCandidateBlockedBy({ trace: { candidates: [] } })).toEqual([]);
		expect(firstCandidateBlockedBy({ trace: { candidates: [{ blockedBy: "not-an-array" }] } })).toEqual([]);
	});
});

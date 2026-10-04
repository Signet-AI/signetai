import { describe, expect, it } from "bun:test";
import { applyDampening } from "./dampening";

const config = {
	gravityEnabled: true,
	hubEnabled: false,
	resolutionEnabled: false,
	hubPercentile: 0.9,
	hubPenalty: 0.7,
	gravityPenalty: 0.5,
	resolutionBoost: 1.2,
};

describe("recall dampening", () => {
	it("does not rank a penalized no-overlap semantic hit below weaker unpenalized hits", () => {
		const dampened = applyDampening(
			[
				{
					id: "spotify",
					score: 0.36,
					source: "sec",
					content: "The user listens to indie rock on Spotify.",
					type: "fact",
				},
				{
					id: "guppies",
					score: 0.27,
					source: "vector",
					content: "One of the user's guppies was quarantined.",
					type: "fact",
				},
			],
			"music streaming service",
			config,
		);

		expect(dampened.map((row) => row.id)).toEqual(["spotify", "guppies"]);
		expect(dampened[0]?.score).toBeLessThan(0.36);
	});

	it("leaves semantic hits that share a query term undampened", () => {
		const [row] = applyDampening(
			[{ id: "music", score: 0.6, source: "vector", content: "The user streams music daily.", type: "fact" }],
			"music streaming service",
			config,
		);

		expect(row?.score).toBe(0.6);
	});
});

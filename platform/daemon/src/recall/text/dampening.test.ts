import { describe, expect, it } from "bun:test";
import { applyDampening } from "./dampening";

const config = {
	gravityEnabled: true,
	hubEnabled: false,
	resolutionEnabled: false,
	hubPercentile: 0.9,
	hubMinShare: 0.25,
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

	it("penalizes only hub entities that cover a large share of the agent's memories", () => {
		const hubConfig = { ...config, gravityEnabled: false, hubEnabled: true };
		const rows = () => [
			{
				id: "spotify",
				score: 0.4,
				source: "vector",
				content: "The user listens to indie rock on Spotify.",
				type: "fact",
			},
			{ id: "other", score: 0.3, source: "vector", content: "The user keeps guppies.", type: "fact" },
		];
		const entities = new Map([
			["spotify", new Set(["concerts"])],
			["other", new Set(["aquarium"])],
		]);
		const degrees = new Map([
			["concerts", 6],
			["aquarium", 2],
		]);

		const topical = applyDampening(rows(), "music streaming", hubConfig, entities, degrees, 200);
		expect(topical.find((row) => row.id === "spotify")?.score).toBe(0.4);

		const generic = applyDampening(rows(), "music streaming", hubConfig, entities, degrees, 20);
		expect(generic.find((row) => row.id === "spotify")?.score).toBeCloseTo(0.28);
	});
});

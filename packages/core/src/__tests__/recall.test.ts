import { describe, expect, test } from "bun:test";
import { applyRecallScoreThreshold, partitionRecallRows } from "../recall";

describe("applyRecallScoreThreshold", () => {
	test("filters rows by score and recomputes meta", () => {
		const filtered = applyRecallScoreThreshold(
			{
				query: "deploy checklist",
				method: "hybrid",
				results: [
					{ content: "low", score: 0.2 },
					{ content: "high", score: 0.9, supplementary: true },
				],
				meta: {
					totalReturned: 2,
					hasSupplementary: true,
					noHits: false,
				},
			},
			0.8,
		);

		expect(filtered).toEqual({
			query: "deploy checklist",
			method: "hybrid",
			results: [{ content: "high", score: 0.9, supplementary: true }],
			meta: {
				totalReturned: 1,
				hasSupplementary: true,
				noHits: false,
			},
		});
	});
});

describe("partitionRecallRows", () => {
	test("separates primary and supporting rows by supplementary flag", () => {
		const { primary, supporting } = partitionRecallRows([
			{ id: "1", supplementary: false },
			{ id: "2", supplementary: true },
			{ id: "3" },
		]);

		expect(primary).toEqual([{ id: "1", supplementary: false }, { id: "3" }]);
		expect(supporting).toEqual([{ id: "2", supplementary: true }]);
	});
});

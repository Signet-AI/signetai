import { describe, expect, it } from "bun:test";
import { RECIPROCAL_RANK_K, rankPositions, reciprocalRankScore, selectPrimaryCandidates } from "./recall-rank-fusion";

describe("rankPositions", () => {
	it("ranks ids from the highest score, starting at 1", () => {
		const ranks = rankPositions(
			new Map([
				["low", 0.4],
				["high", 0.9],
				["mid", 0.6],
			]),
			0,
		);

		expect([...ranks.entries()]).toEqual([
			["high", 1],
			["mid", 2],
			["low", 3],
		]);
	});

	it("leaves out scores below the minimum and zero scores", () => {
		const ranks = rankPositions(
			new Map([
				["kept", 0.5],
				["weak", 0.2],
				["absent", 0],
			]),
			0.3,
		);

		expect([...ranks.keys()]).toEqual(["kept"]);
	});
});

describe("reciprocalRankScore", () => {
	it("scores 1 when an id is first in every list", () => {
		expect(reciprocalRankScore([1, 1])).toBe(1);
	});

	it("scores the same for rank 1 in either list, whatever the raw scores were", () => {
		expect(reciprocalRankScore([1, undefined])).toBe(reciprocalRankScore([undefined, 1]));
		expect(reciprocalRankScore([1, undefined])).toBeCloseTo(0.5, 10);
	});

	it("ranks an id found in both lists above one found in a single list", () => {
		expect(reciprocalRankScore([5, 5])).toBeGreaterThan(reciprocalRankScore([1, undefined]));
	});

	it("drops as the position grows", () => {
		const first = reciprocalRankScore([1, undefined]);
		const tenth = reciprocalRankScore([10, undefined]);

		expect(tenth).toBeLessThan(first);
		expect(tenth).toBeCloseTo((RECIPROCAL_RANK_K + 1) / (2 * (RECIPROCAL_RANK_K + 10)), 10);
	});

	it("scores 0 when the id is in no list", () => {
		expect(reciprocalRankScore([undefined, undefined])).toBe(0);
		expect(reciprocalRankScore([])).toBe(0);
	});
});

describe("selectPrimaryCandidates", () => {
	const rows = (...ids: string[]) => ids.map((id) => ({ id }));
	const ids = (selected: ReadonlyArray<{ id: string }>) => selected.map((row) => row.id);

	it("keeps the highest rows up to the budget", () => {
		const fused = rows("a", "b", "c", "d");

		expect(ids(selectPrimaryCandidates(fused, 2, new Set(["a", "b", "c", "d"]), 0, new Set()))).toEqual(["a", "b"]);
	});

	it("keeps room for the minimum number of flat rows", () => {
		const fused = rows("t1", "t2", "t3", "f1", "f2");
		const flat = new Set(["f1", "f2"]);

		expect(ids(selectPrimaryCandidates(fused, 3, flat, 2, new Set()))).toEqual(["t1", "f1", "f2"]);
	});

	it("keeps reserved rows even when they rank below the budget", () => {
		const fused = rows("t1", "t2", "t3", "t4", "v1");
		const flat = new Set(["v1"]);

		expect(ids(selectPrimaryCandidates(fused, 3, flat, 0, new Set(["v1"])))).toEqual(["v1", "t1", "t2"]);
	});

	it("counts reserved flat rows toward the flat minimum", () => {
		const fused = rows("t1", "t2", "t3", "v1", "f1");
		const flat = new Set(["v1", "f1"]);

		expect(ids(selectPrimaryCandidates(fused, 3, flat, 1, new Set(["v1"])))).toEqual(["v1", "t1", "t2"]);
	});

	it("never returns more rows than the budget", () => {
		const fused = rows("v1", "v2", "v3");

		expect(selectPrimaryCandidates(fused, 2, new Set(), 0, new Set(["v1", "v2", "v3"]))).toHaveLength(2);
	});
});

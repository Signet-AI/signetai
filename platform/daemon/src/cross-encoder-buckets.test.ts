import { describe, expect, it } from "bun:test";
import { RerankDeadlineError, pairLengths, planLengthBuckets, scoreInGroups } from "./cross-encoder-buckets";

describe("cross-encoder length buckets", () => {
	it("keeps a batch of similar lengths in one run", () => {
		expect(planLengthBuckets([40, 42, 38, 45])).toEqual([[2, 0, 1, 3]]);
	});

	it("splits short memories from long excerpts instead of padding them all", () => {
		const groups = planLengthBuckets([...new Array<number>(20).fill(90), 260, 270, 250, 280]);
		expect(groups).toHaveLength(2);
		expect(groups[0]).toHaveLength(20);
		expect([...(groups[1] ?? [])].sort((a, b) => a - b)).toEqual([20, 21, 22, 23]);
	});

	it("covers every document exactly once", () => {
		const lengths = [512, 17, 300, 64, 64, 128, 511, 9, 250, 33];
		const flat = planLengthBuckets(lengths).flat();
		expect([...flat].sort((a, b) => a - b)).toEqual(lengths.map((_, index) => index));
	});

	it("reads pair lengths from the attention mask", () => {
		expect(pairLengths({ attentionMask: [1, 1, 1, 0, 1, 1, 1, 1], batchSize: 2, sequenceLength: 4 })).toEqual([3, 4]);
	});

	it("scores every group and places scores back in document order", async () => {
		const scores = await scoreInGroups([[2], [0, 1]], 3, async (group) => group.map((index) => index * 10));
		expect(scores).toEqual([0, 10, 20]);
	});

	it("stops between groups once the caller's deadline has passed, so an abandoned rerank frees the worker", async () => {
		let clock = 0;
		const scored: number[] = [];
		const run = scoreInGroups(
			[[0], [1], [2], [3]],
			4,
			async (group) => {
				scored.push(...group);
				clock += 400;
				return group.map(() => 1);
			},
			1000,
			() => clock,
		);
		await expect(run).rejects.toBeInstanceOf(RerankDeadlineError);
		expect(scored).toEqual([0, 1, 2]);
	});

	it("does not start when the deadline has already passed", async () => {
		let calls = 0;
		await expect(
			scoreInGroups(
				[[0]],
				1,
				async () => {
					calls++;
					return [1];
				},
				5,
				() => 10,
			),
		).rejects.toBeInstanceOf(RerankDeadlineError);
		expect(calls).toBe(0);
	});
});

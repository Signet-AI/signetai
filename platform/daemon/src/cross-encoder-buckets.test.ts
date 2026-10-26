import { describe, expect, it } from "bun:test";
import { pairLengths, planLengthBuckets } from "./cross-encoder-buckets";

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
});

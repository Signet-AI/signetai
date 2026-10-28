import { describe, expect, it } from "bun:test";
import { createCrossEncoderScoreMemo } from "./cross-encoder-memo";

function scorer(device: { current: string | null }) {
	const calls: string[][] = [];
	return {
		calls,
		deps: {
			score: async (_query: string, documents: readonly string[]) => {
				calls.push([...documents]);
				return documents.map((document) => document.length);
			},
			activeDevice: () => device.current,
		},
	};
}

describe("cross-encoder score memo", () => {
	it("scores each document once per recall and piggybacks extra documents on CUDA", async () => {
		const device = { current: "cuda" as string | null };
		const { calls, deps } = scorer(device);
		const score = createCrossEncoderScoreMemo({ ...deps, requestedDevice: "cuda" });
		expect(await score("q", ["aa", "bbb"], ["excerpt"])).toEqual([2, 3]);
		expect(await score("q", ["bbb", "excerpt"])).toEqual([3, 7]);
		expect(calls).toEqual([["aa", "bbb", "excerpt"]]);
	});

	it("does not piggyback on CPU but still reuses scores it already has", async () => {
		const device = { current: "cpu" as string | null };
		const { calls, deps } = scorer(device);
		const score = createCrossEncoderScoreMemo({ ...deps, requestedDevice: "cpu" });
		await score("q", ["aa", "bbb"], ["excerpt"]);
		expect(await score("q", ["bbb", "excerpt"])).toEqual([3, 7]);
		expect(calls).toEqual([["aa", "bbb"], ["excerpt"]]);
	});

	it("keeps memoizing on the runtime it fell back to instead of scoring every batch twice", async () => {
		const device = { current: "default" as string | null };
		const { calls, deps } = scorer(device);
		const score = createCrossEncoderScoreMemo({ ...deps, requestedDevice: "cuda" });
		await score("q", ["aa", "bbb"], ["excerpt"]);
		await score("q", ["bbb", "excerpt"]);
		expect(calls).toEqual([["aa", "bbb"], ["excerpt"]]);
	});

	it("rescores when the device changes between calls, so scores from two runtimes never mix", async () => {
		const device = { current: "cuda" as string | null };
		const { calls, deps } = scorer(device);
		const score = createCrossEncoderScoreMemo({ ...deps, requestedDevice: "cuda" });
		await score("q", ["aa"]);
		device.current = "default";
		expect(await score("q", ["aa", "bbb"])).toEqual([2, 3]);
		expect(calls).toEqual([["aa"], ["bbb"], ["aa", "bbb"]]);
	});

	it("does not reuse scores across queries", async () => {
		const device = { current: "cuda" as string | null };
		const { calls, deps } = scorer(device);
		const score = createCrossEncoderScoreMemo({ ...deps, requestedDevice: "cuda" });
		await score("q", ["aa"]);
		await score("other", ["aa"]);
		expect(calls).toEqual([["aa"], ["aa"]]);
	});
});

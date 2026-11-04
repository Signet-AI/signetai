import { describe, expect, it } from "bun:test";
import { createCrossEncoderScoreMemo } from "./cross-encoder-memo";
import { type RerankOutcome, createCrossEncoderReranker } from "./pipeline/reranker-cross-encoder";

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
	for (const [name, invalid] of [
		["missing", []],
		["NaN", [Number.NaN]],
		["infinite", [Number.POSITIVE_INFINITY]],
		["negative infinite", [Number.NEGATIVE_INFINITY]],
		["sparse", Array<number>(1)],
		["non-numeric", ["1"] as unknown as number[]],
		["extra", [1, 2]],
	] as const) {
		for (const path of ["memoized", "changed query", "changed device"] as const) {
			it(`rejects ${name} scores on the ${path} path without caching them`, async () => {
				let device = "cuda";
				let calls = 0;
				const score = createCrossEncoderScoreMemo({
					requestedDevice: "cuda",
					activeDevice: () => device,
					score: async (_query, documents) => {
						calls++;
						return calls === (path === "memoized" ? 1 : path === "changed query" ? 2 : 3)
							? invalid.slice()
							: documents.map(() => 1);
					},
				});
				if (path !== "memoized") await score("q", ["first"]);
				if (path === "changed device") device = "default";
				const query = path === "changed query" ? "other" : "q";
				await expect(score(query, ["second"])).rejects.toThrow(/non-finite or missing scores/);
				expect(await score(query, ["second"])).toEqual([1]);
			});
		}
	}

	it("reports invalid memo scores as an embedding fallback rather than silently demoting the document", async () => {
		const score = createCrossEncoderScoreMemo({
			requestedDevice: "cpu",
			activeDevice: () => "cpu",
			score: async () => [Number.NaN],
		});
		const outcome: RerankOutcome = { kind: "none" };
		const blended = [{ id: "memory", content: "document", score: 0.5 }];
		const rerank = createCrossEncoderReranker({
			model: "test-model",
			score: (query, documents, deadlineAt) => score(query, documents, [], deadlineAt),
			fallback: async () => blended,
			outcome,
		});
		expect(await rerank("q", blended, { topN: 20, timeoutMs: 1000, model: "" })).toBe(blended);
		expect(outcome).toEqual({ kind: "embedding", fallback: "Cross-encoder returned non-finite or missing scores" });
	});

	it("does not cache a valid prefix of a rejected batch", async () => {
		const calls: string[][] = [];
		const score = createCrossEncoderScoreMemo({
			requestedDevice: "cpu",
			activeDevice: () => "cpu",
			score: async (_query, documents) => {
				calls.push([...documents]);
				return calls.length === 1 ? [1, Number.NaN] : documents.map(() => 2);
			},
		});
		await expect(score("q", ["first", "second"])).rejects.toThrow(/non-finite or missing scores/);
		expect(await score("q", ["first", "second"])).toEqual([2, 2]);
		expect(calls).toEqual([
			["first", "second"],
			["first", "second"],
		]);
	});

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

import { describe, expect, it } from "bun:test";
import type { RerankCandidate } from "./reranker";
import { type RerankOutcome, createCrossEncoderReranker, fuseCrossEncoderScores } from "./reranker-cross-encoder";

const candidates = (): RerankCandidate[] =>
	["netflix lately", "netflix months", "gin lately", "indie rock", "spotify listening"].map((content, index) => ({
		id: `m${index}`,
		content,
		score: 0.5 - index * 0.05,
	}));

describe("cross-encoder reranker", () => {
	it("fuses cross-encoder order with retrieval order and keeps the retrieval score ladder", () => {
		const fused = fuseCrossEncoderScores(candidates(), [0.1, 0.2, 0.05, 0.6, 0.9]);
		expect(fused.map((candidate) => candidate.content)).toEqual([
			"netflix lately",
			"netflix months",
			"spotify listening",
			"indie rock",
			"gin lately",
		]);
		expect(fused.map((candidate) => candidate.score)).toEqual([0.5, 0.45, 0.4, 0.35, 0.3]);
	});

	it("leaves the order alone when the cross-encoder agrees with retrieval", () => {
		const fused = fuseCrossEncoderScores(candidates(), [5, 4, 3, 2, 1]);
		expect(fused.map((candidate) => candidate.id)).toEqual(["m0", "m1", "m2", "m3", "m4"]);
	});

	it("rejects a score list that does not match the candidates", () => {
		expect(() => fuseCrossEncoderScores(candidates(), [1, 2])).toThrow("2 scores for 5 candidates");
	});

	it("reports the cross-encoder when it answers in time", async () => {
		const outcome: RerankOutcome = { kind: "embedding" };
		const rerank = createCrossEncoderReranker({
			model: "test-model",
			score: async (_query, documents) => documents.map((document) => (document.includes("spotify") ? 9 : 0)),
			fallback: async () => {
				throw new Error("fallback should not run");
			},
			outcome,
		});
		const result = await rerank("music streaming service", candidates(), { topN: 20, timeoutMs: 1000, model: "" });
		expect(result.findIndex((candidate) => candidate.content === "spotify listening")).toBeLessThan(4);
		expect(outcome).toEqual({ kind: "cross-encoder", model: "test-model" });
	});

	it("falls back to the cosine blend and says why when the cross-encoder fails or is too slow", async () => {
		const blended: RerankCandidate[] = candidates().reverse();
		for (const score of [
			async () => {
				throw new Error("cross-encoder busy with another recall");
			},
			() => new Promise<number[]>(() => {}),
		]) {
			const outcome: RerankOutcome = { kind: "embedding" };
			const rerank = createCrossEncoderReranker({ model: "test-model", score, fallback: async () => blended, outcome });
			expect(await rerank("q", candidates(), { topN: 20, timeoutMs: 40, model: "" })).toBe(blended);
			expect(outcome.kind).toBe("embedding");
			expect(outcome.fallback).toMatch(/busy with another recall|exceeded 30ms/);
		}
	});
});

import { describe, expect, it } from "bun:test";
import type { LlmProvider } from "@signet/core";
import { createLlmReranker, summarizeRecallWithLlm } from "./reranker-llm";

describe("createLlmReranker", () => {
	it("reorders candidates when provider returns scored ids", async () => {
		const provider: LlmProvider = {
			name: "test",
			available: async () => true,
			generate: async () =>
				JSON.stringify({
					scores: [
						{ id: "a", score: 0.1 },
						{ id: "b", score: 0.9 },
					],
				}),
		};
		const rerank = createLlmReranker(provider);
		const result = await rerank(
			"deploy checklist",
			[
				{ id: "a", content: "alpha", score: 0.8 },
				{ id: "b", content: "beta", score: 0.7 },
			],
			{ model: "", topN: 20, timeoutMs: 2000 },
		);

		expect(result[0]?.id).toBe("b");
		expect(result[1]?.id).toBe("a");
	});

	it("parses scores when provider output contains qwen-style <think> block and json fence", async () => {
		const provider: LlmProvider = {
			name: "test",
			available: async () => true,
			generate: async () =>
				"<think>reasoning here</think>\n```json\n" +
				JSON.stringify({
					scores: [
						{ id: "a", score: 0.2 },
						{ id: "b", score: 0.8 },
					],
				}) +
				"\n```",
		};
		const rerank = createLlmReranker(provider);
		const result = await rerank(
			"deploy checklist",
			[
				{ id: "a", content: "alpha", score: 0.8 },
				{ id: "b", content: "beta", score: 0.7 },
			],
			{ model: "", topN: 20, timeoutMs: 2000 },
		);
		expect(result[0]?.id).toBe("b");
		expect(result[1]?.id).toBe("a");
	});

	it("falls back to original ordering when provider output is not parseable", async () => {
		const provider: LlmProvider = {
			name: "test",
			available: async () => true,
			generate: async () => "not json",
		};
		const rerank = createLlmReranker(provider);
		const input = [
			{ id: "a", content: "alpha", score: 0.8 },
			{ id: "b", content: "beta", score: 0.7 },
		];
		const result = await rerank("deploy checklist", input, {
			model: "",
			topN: 20,
			timeoutMs: 2000,
		});

		expect(result).toEqual(input);
	});
});

describe("summarizeRecallWithLlm", () => {
	it("returns a cleaned summary", async () => {
		const provider: LlmProvider = {
			name: "test",
			available: async () => true,
			generate: async () => "  deploy uses blue/green with rollback checklist  ",
		};
		const result = await summarizeRecallWithLlm(
			provider,
			"how do we deploy?",
			[
				{ id: "a", content: "blue green deploy", score: 0.8 },
				{ id: "b", content: "rollback checklist", score: 0.7 },
			],
			2000,
		);
		expect(result).toBe("deploy uses blue/green with rollback checklist");
	});
});

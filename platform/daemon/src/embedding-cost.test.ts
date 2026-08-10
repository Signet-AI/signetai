import { describe, expect, it } from "bun:test";
import {
	DEFAULT_EMBEDDING_COST_RATES,
	calculateEmbeddingCost,
	resolveEmbeddingAccounting,
	resolveEmbeddingCostProvider,
} from "./embedding-cost";

describe("embedding cost attribution", () => {
	it("uses configured rates and identifies OpenRouter by endpoint", () => {
		expect(resolveEmbeddingCostProvider("openai", "https://openrouter.ai/api/v1")).toBe("openrouter");
		expect(
			calculateEmbeddingCost("openai", 2_000_000, {
				baseUrl: "https://openrouter.ai/api/v1",
				rates: { openrouter: 0.01 },
			}),
		).toBe(0.02);
	});

	it("keeps local providers free and uses the OpenAI default rate", () => {
		expect(calculateEmbeddingCost("ollama", 100_000)).toBe(0);
		expect(calculateEmbeddingCost("openai", 1_000_000)).toBe(DEFAULT_EMBEDDING_COST_RATES.openai);
		expect(calculateEmbeddingCost("unknown", 1_000_000)).toBeNull();
	});

	it("labels the accounting source separately from the numeric cost", () => {
		expect(resolveEmbeddingAccounting("ollama", 100_000)).toEqual({
			cost: 0,
			accountingProvenance: "local_zero_cost",
		});
		expect(resolveEmbeddingAccounting("openai", 1_000_000).accountingProvenance).toBe("configured_rate");
		expect(resolveEmbeddingAccounting("unknown", 1_000_000)).toEqual({
			cost: null,
			accountingProvenance: "unavailable",
		});
		expect(resolveEmbeddingAccounting("openai", 1_000_000, { baseUrl: "http://127.0.0.1:1234/v1" })).toEqual({
			cost: 0,
			accountingProvenance: "local_zero_cost",
		});
		expect(resolveEmbeddingAccounting("ollama", 1_000_000, { rates: { ollama: 5 } })).toEqual({
			cost: 5,
			accountingProvenance: "configured_rate",
		});
	});
});

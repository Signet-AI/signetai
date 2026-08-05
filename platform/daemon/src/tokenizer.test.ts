import { describe, expect, it } from "bun:test";
import { countTokens, estimateTokens, resetTokenizerStats, tokenizerStats } from "./pipeline/tokenizer";

describe("tokenizer", () => {
	it("estimates tokens from characters without encoding", () => {
		expect(estimateTokens("")).toBe(0);
		expect(estimateTokens("hello world")).toBe(Math.ceil("hello world".length / 4));
	});

	it("estimates never exceed the exact BPE count for plain prose", () => {
		// chars/4 is the standard heuristic; for ASCII prose the exact BPE count
		// is typically at or below the estimate, so budgeting on the estimate is
		// safe (never under-reserves for the common case).
		const text = "the quick brown fox jumps over the lazy dog and keeps running";
		expect(countTokens(text)).toBeLessThanOrEqual(estimateTokens(text));
	});

	it("tracks encode calls so hot paths can be audited", () => {
		resetTokenizerStats();
		countTokens("some text");
		expect(tokenizerStats.encodeCalls).toBe(1);
		expect(tokenizerStats.encodeChars).toBe("some text".length);
	});
});

import { describe, expect, it } from "bun:test";
import {
	applyTokenBudget,
	selectWithBudget,
	selectWithBudgetSkippingOversized,
	selectWithEstimatedTokenBudget,
	selectWithTokenBudget,
} from "./context-budget";
import { countTokens, estimateTokens } from "./pipeline/tokenizer";

describe("context budget helpers", () => {
	it("preserves row types while selecting by character budget", () => {
		const rows = [
			{ id: "a", content: "abcd" },
			{ id: "b", content: "efgh" },
			{ id: "c", content: "ijkl" },
		];

		expect(selectWithBudget(rows, 8)).toEqual(rows.slice(0, 2));
	});

	it("can skip oversized rows when filling a character budget", () => {
		const rows = [
			{ id: "too-big", content: "0123456789" },
			{ id: "fits", content: "ok" },
		];

		expect(selectWithBudgetSkippingOversized(rows, 3)).toEqual([rows[1]]);
	});

	it("selects whole rows by token budget", () => {
		const rows = [
			{ id: "a", content: "hello world" },
			{ id: "b", content: "another short row" },
		];
		const budget = countTokens(rows[0].content);

		expect(selectWithTokenBudget(rows, budget)).toEqual([rows[0]]);
	});

	it("selects whole rows by estimated token budget without encoding", () => {
		const rows = [
			{ id: "a", content: "hello world" },
			{ id: "b", content: "another short row" },
		];
		const budget = estimateTokens(rows[0].content);

		expect(selectWithEstimatedTokenBudget(rows, budget)).toEqual([rows[0]]);
	});

	it("applyTokenBudget returns a fitting inject unchanged without truncation", () => {
		const inject = "alpha beta gamma delta epsilon zeta eta theta";
		const result = applyTokenBudget(inject, inject.length + 1000);

		expect(result).toBe(inject);
	});

	it("applyTokenBudget short-circuits on a clearly fitting inject without encoding", () => {
		const inject = "short inject";
		const result = applyTokenBudget(inject, inject.length);

		expect(result).toBe(inject);
	});

	it("truncates injected context without exceeding the token budget", () => {
		const result = applyTokenBudget("alpha beta gamma delta epsilon zeta eta theta", 5);

		expect(countTokens(result)).toBeLessThanOrEqual(5);
	});
});

import { describe, expect, it } from "bun:test";
import { applyTokenBudget, selectWithBudget, selectWithBudgetSkippingOversized, selectWithTokenBudget } from "./context-budget";
import { countTokens } from "./pipeline/tokenizer";

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

	it("truncates injected context without exceeding the token budget", () => {
		const result = applyTokenBudget("alpha beta gamma delta epsilon zeta eta theta", 5);

		expect(countTokens(result)).toBeLessThanOrEqual(5);
	});
});

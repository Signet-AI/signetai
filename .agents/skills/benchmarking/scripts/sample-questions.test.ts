import { describe, expect, it } from "bun:test";
import { allocate, sampleQuestions } from "./sample-questions";

const questions = [
	...Array.from({ length: 6 }, (_, index) => ({ id: `a${index}`, type: "alpha" })),
	...Array.from({ length: 3 }, (_, index) => ({ id: `b${index}`, type: "beta" })),
	...Array.from({ length: 1 }, (_, index) => ({ id: `c${index}`, type: "gamma" })),
];

describe("sample-questions", () => {
	it("allocates by share with largest-remainder rounding", () => {
		const allocation = allocate(
			new Map([
				["alpha", 6],
				["beta", 3],
				["gamma", 1],
			]),
			5,
		);
		expect(Object.fromEntries(allocation)).toEqual({ alpha: 3, beta: 2, gamma: 0 });
		expect([...allocation.values()].reduce((sum, count) => sum + count, 0)).toBe(5);
	});

	it("returns the same sample for the same seed and a different one for another seed", () => {
		const first = sampleQuestions(questions, 5, 1).map((question) => question.id);
		expect(sampleQuestions([...questions].reverse(), 5, 1).map((question) => question.id)).toEqual(first);
		const others = [2, 3, 4, 5].map((seed) => sampleQuestions(questions, 5, seed).map((question) => question.id));
		expect(others.some((ids) => ids.join() !== first.join())).toBe(true);
	});

	it("keeps each type at its allocated count", () => {
		const sample = sampleQuestions(questions, 5, 7);
		expect(sample.filter((question) => question.type === "alpha")).toHaveLength(3);
		expect(sample.filter((question) => question.type === "beta")).toHaveLength(2);
	});

	it("refuses a sample larger than the set", () => {
		expect(() => sampleQuestions(questions, 11, 1)).toThrow("Cannot sample 11 of 10 questions");
	});
});

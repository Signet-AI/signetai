import { describe, expect, test } from "bun:test";
import { extractGitHubRefs } from "./github-source-graph";

describe("extractGitHubRefs", () => {
	test("extracts #123 references", () => {
		const refs = extractGitHubRefs("Fixes #42 and closes #100", "owner/repo");
		expect(refs.length).toBeGreaterThanOrEqual(2);
		const numbers = refs.map((r) => r.number);
		expect(numbers).toContain(42);
		expect(numbers).toContain(100);
	});

	test("extracts GitHub URLs", () => {
		const refs = extractGitHubRefs(
			"See https://github.com/owner/repo/pull/55 and https://github.com/owner/repo/issues/77",
			"owner/repo",
		);
		expect(refs.length).toBeGreaterThanOrEqual(2);
		const types = refs.map((r) => r.type);
		expect(types).toContain("pull");
		expect(types).toContain("issue");
	});

	test("deduplicates references", () => {
		const refs = extractGitHubRefs("Fixes #42. See also #42.", "owner/repo");
		const numbers = refs.map((r) => r.number);
		const unique = new Set(numbers);
		expect(unique.size).toBe(numbers.length);
	});

	test("handles empty body", () => {
		const refs = extractGitHubRefs("", "owner/repo");
		expect(refs.length).toBe(0);
	});
});

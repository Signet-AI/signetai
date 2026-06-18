import { describe, expect, it } from "bun:test";

import { shouldPreserveCatalogOnEmptyRefresh } from "./skills-load-policy";

describe("skills catalog load policy", () => {
	it("preserves an existing catalog when a refresh returns an empty fallback", () => {
		expect(shouldPreserveCatalogOnEmptyRefresh(0, 9)).toBe(true);
	});

	it("allows an empty catalog when no previous catalog exists", () => {
		expect(shouldPreserveCatalogOnEmptyRefresh(0, 0)).toBe(false);
	});

	it("accepts non-empty refresh results", () => {
		expect(shouldPreserveCatalogOnEmptyRefresh(3, 9)).toBe(false);
	});
});

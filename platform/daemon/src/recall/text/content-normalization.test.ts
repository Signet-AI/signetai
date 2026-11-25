import { describe, expect, it } from "bun:test";
import { normalizeAndHashContent, normalizeContentForStorage } from "./content-normalization";

describe("content normalization", () => {
	it("preserves multiline markdown tables in storage content", () => {
		const input = ["  ## Session Logs", "", "| id | kind |", "|----|------|", "| a | summary |", ""].join("\n");

		const result = normalizeContentForStorage(input);

		expect(result).toBe(["## Session Logs", "", "| id | kind |", "|----|------|", "| a | summary |"].join("\n"));
		expect(result.includes("\n| id | kind |")).toBe(true);
	});

	it("keeps semantic hashes stable across formatting-only whitespace differences", () => {
		const multi = ["## Session Logs", "", "| id | kind |", "|----|------|", "| a | summary |"].join("\n");
		const flat = "## Session Logs | id | kind | |----|------| | a | summary |";

		const left = normalizeAndHashContent(multi);
		const right = normalizeAndHashContent(flat);

		expect(left.storageContent).toContain("\n");
		expect(right.storageContent).not.toContain("\n");
		expect(left.normalizedContent).toBe(right.normalizedContent);
		expect(left.contentHash).toBe(right.contentHash);
	});
});

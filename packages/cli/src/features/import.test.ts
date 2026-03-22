import { describe, expect, test } from "bun:test";
import { normalizeGitUrl } from "./import.js";

describe("normalizeGitUrl", () => {
	test("adds github https prefix for owner repo shorthand", () => {
		expect(normalizeGitUrl("Signet-AI/signetai")).toBe(
			"https://github.com/Signet-AI/signetai.git",
		);
	});

	test("does not duplicate .git for shorthand that already includes it", () => {
		expect(normalizeGitUrl("Signet-AI/signetai.git")).toBe(
			"https://github.com/Signet-AI/signetai.git",
		);
	});

	test("strips trailing slash before appending .git to github urls", () => {
		expect(normalizeGitUrl("https://github.com/Signet-AI/signetai/")).toBe(
			"https://github.com/Signet-AI/signetai.git",
		);
	});

	test("keeps git ssh urls intact", () => {
		expect(normalizeGitUrl("git@github.com:Signet-AI/signetai.git")).toBe(
			"git@github.com:Signet-AI/signetai.git",
		);
	});
});

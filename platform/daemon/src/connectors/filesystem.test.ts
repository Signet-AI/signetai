import { describe, expect, test } from "bun:test";
import { matchGlob } from "./filesystem";

describe("globToRegex", () => {
	test("**/*.md matches root-level files", () => {
		expect(matchGlob("**/*.md", "AGENTS.md")).toBe(true);
		expect(matchGlob("**/*.md", "README.md")).toBe(true);
		expect(matchGlob("**/*.md", "notes.md")).toBe(true);
	});

	test("**/*.md matches nested files", () => {
		expect(matchGlob("**/*.md", "sub/file.md")).toBe(true);
		expect(matchGlob("**/*.md", "a/b/c/deep.md")).toBe(true);
	});

	test("**/*.txt matches by extension", () => {
		expect(matchGlob("**/*.txt", "file.txt")).toBe(true);
		expect(matchGlob("**/*.txt", "docs/notes.txt")).toBe(true);
		expect(matchGlob("**/*.txt", "file.md")).toBe(false);
	});

	test("*.md matches at any depth (Bun.Glob compat)", () => {
		expect(matchGlob("*.md", "AGENTS.md")).toBe(true);
		expect(matchGlob("*.md", "sub/file.md")).toBe(true);
		expect(matchGlob("*.md", "a/b/c.md")).toBe(true);
	});

	test("dotfiles match when explicitly in pattern", () => {
		expect(matchGlob("**/*.md", ".agents/SOUL.md")).toBe(true);
		expect(matchGlob("**/*.md", ".github/CONTRIBUTING.md")).toBe(true);
	});

	test("*.md does not match .env", () => {
		expect(matchGlob("**/*.md", ".env")).toBe(false);
	});

	test("exact path pattern", () => {
		expect(matchGlob("AGENTS.md", "AGENTS.md")).toBe(true);
		expect(matchGlob("AGENTS.md", "sub/AGENTS.md")).toBe(true);
	});
});

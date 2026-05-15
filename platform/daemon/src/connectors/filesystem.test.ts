import { describe, expect, test } from "bun:test";
import { matchConnectorPattern, matchGlob } from "./filesystem";

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

	test("connector matching only includes dot paths for explicit dot patterns", () => {
		expect(matchConnectorPattern("**/*.md", ".agents/SOUL.md")).toBe(false);
		expect(matchConnectorPattern("**/*.md", ".github/CONTRIBUTING.md")).toBe(false);
		expect(matchConnectorPattern(".github/*.md", ".github/CONTRIBUTING.md")).toBe(true);
		expect(matchConnectorPattern("docs/.private/*.md", "docs/.private/notes.md")).toBe(true);
	});

	test("*.md does not match .env", () => {
		expect(matchGlob("**/*.md", ".env")).toBe(false);
	});

	test("exact path pattern only matches root", () => {
		expect(matchGlob("AGENTS.md", "AGENTS.md")).toBe(true);
		expect(matchGlob("AGENTS.md", "sub/AGENTS.md")).toBe(false);
	});
});

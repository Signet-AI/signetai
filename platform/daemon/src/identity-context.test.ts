import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadIdentity, parseIdentityMarkdown, readContextIdentitySections, readIdentityFile } from "./identity-context";
import { countTokens } from "./pipeline/tokenizer";

let tempDir: string | null = null;

function makeTempDir(): string {
	tempDir = mkdtempSync(join(tmpdir(), "signet-identity-context-"));
	return tempDir;
}

afterEach(() => {
	if (tempDir) {
		rmSync(tempDir, { recursive: true, force: true });
		tempDir = null;
	}
});

describe("identity context", () => {
	test("parses identity markdown name and role", () => {
		expect(parseIdentityMarkdown("name: Ada\nrole: coding assistant")).toEqual({
			name: "Ada",
			description: "coding assistant",
		});
	});

	test("loads agent.yaml identity before root IDENTITY.md", () => {
		const dir = makeTempDir();
		writeFileSync(join(dir, "agent.yaml"), "agent:\n  name: YAML Agent\n  description: from yaml\n");
		writeFileSync(join(dir, "IDENTITY.md"), "name: Markdown Agent\n");

		expect(loadIdentity(dir)).toEqual({ name: "YAML Agent", description: "from yaml" });
	});

	test("renders profile-managed identity sections in configured order with token budgets", () => {
		const dir = makeTempDir();
		// Content is ~10 tokens; budget (6) is larger than the truncation marker (~5)
		// but smaller than the content, so the file is truncated with the marker.
		writeFileSync(join(dir, "AGENTS.md"), "alpha beta gamma delta epsilon zeta eta theta iota");
		writeFileSync(join(dir, "USER.md"), "user preference detail");

		const sections = readContextIdentitySections(dir, {
			files: [
				{ path: "USER.md", maxTokens: 20 },
				{ path: "AGENTS.md", maxTokens: 6 },
			],
		});

		expect(sections?.map((section) => section.header)).toEqual(["About Your User", "Agent Instructions"]);
		expect(sections?.[0]?.content).toBe("user preference detail");
		expect(sections?.[1]?.content).toContain("[truncated]");
	});

	test("truncated profile identity sections never exceed the declared budget", () => {
		const dir = makeTempDir();
		writeFileSync(join(dir, "AGENTS.md"), `${"word ".repeat(400)}`);
		writeFileSync(join(dir, "USER.md"), `${"x".repeat(4000)}`);

		const tokenBudget = 40;
		const charBudget = 100;
		const sections = readContextIdentitySections(dir, {
			files: [
				{ path: "AGENTS.md", maxTokens: tokenBudget },
				{ path: "USER.md", maxChars: charBudget },
			],
		});

		expect(sections?.[0]?.content).toContain("[truncated]");
		// Token budget is the hard contract for the maxTokens variant.
		expect(countTokens(sections?.[0]?.content ?? "")).toBeLessThanOrEqual(tokenBudget);
		expect(sections?.[1]?.content).toContain("[truncated]");
		// Character budget is the hard contract for the maxChars variant.
		expect(sections?.[1]?.content.length).toBeLessThanOrEqual(charBudget);
	});

	test("tiny per-file budgets never overflow even when smaller than the truncation marker", () => {
		const dir = makeTempDir();
		writeFileSync(join(dir, "AGENTS.md"), "alpha beta gamma delta epsilon zeta eta theta");
		writeFileSync(join(dir, "USER.md"), "user preference detail goes here");

		const sections = readContextIdentitySections(dir, {
			files: [
				{ path: "AGENTS.md", maxTokens: 1 },
				{ path: "USER.md", maxChars: 1 },
			],
		});

		// Even a 1-unit budget must hold (no marker overflow).
		expect(countTokens(sections?.[0]?.content ?? "")).toBeLessThanOrEqual(1);
		expect(sections?.[1]?.content.length).toBeLessThanOrEqual(1);
	});

	test("profile identity sections reject symlinks into denied workspace directories", () => {
		const dir = makeTempDir();
		mkdirSync(join(dir, ".secrets"), { recursive: true });
		writeFileSync(join(dir, ".secrets", "secret.md"), "do not leak");
		symlinkSync(join(dir, ".secrets", "secret.md"), join(dir, "context.md"));

		expect(readContextIdentitySections(dir, { files: [{ path: "context.md", maxTokens: 20 }] })).toEqual([]);
	});

	test("profile identity sections reject markdown symlinks to non-markdown targets", () => {
		const dir = makeTempDir();
		writeFileSync(join(dir, "agent.yaml"), "agent:\n  name: Do Not Inject\n");
		symlinkSync(join(dir, "agent.yaml"), join(dir, "context.md"));

		expect(readContextIdentitySections(dir, { files: [{ path: "context.md", maxTokens: 20 }] })).toEqual([]);
	});

	test("profile identity include false suppresses all identity sections", () => {
		const dir = makeTempDir();
		writeFileSync(join(dir, "AGENTS.md"), "agent instructions");

		expect(readContextIdentitySections(dir, { include: false })).toEqual([]);
	});

	test("reads and truncates identity files through agent override map", () => {
		const dir = makeTempDir();
		const overridePath = join(dir, "override.md");
		writeFileSync(overridePath, "abcdef");

		expect(readIdentityFile(dir, "USER.md", 4, { "USER.md": overridePath })).toBe("abcd\n[truncated]");
	});
});

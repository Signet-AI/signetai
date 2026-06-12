import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadIdentity, parseIdentityMarkdown, readIdentityFile } from "./identity-context";

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

	test("reads and truncates identity files through agent override map", () => {
		const dir = makeTempDir();
		const overridePath = join(dir, "override.md");
		writeFileSync(overridePath, "abcdef");

		expect(readIdentityFile(dir, "USER.md", 4, { "USER.md": overridePath })).toBe("abcd\n[truncated]");
	});
});

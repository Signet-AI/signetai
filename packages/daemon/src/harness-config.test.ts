import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readEnabledHarnessesFromConfigFiles, readHarnessesFromConfigContent } from "./harness-config";

const tmpDirs: string[] = [];

afterEach(() => {
	while (tmpDirs.length > 0) {
		const dir = tmpDirs.pop();
		if (!dir) continue;
		rmSync(dir, { recursive: true, force: true });
	}
});

function makeTempAgentsDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "signet-harness-config-"));
	tmpDirs.push(dir);
	return dir;
}

describe("readHarnessesFromConfigContent", () => {
	it("parses root-level block sequence lists", () => {
		const content = "harnesses:\n- claude-code\n- opencode\n";
		expect(readHarnessesFromConfigContent(content)).toEqual(["claude-code", "opencode"]);
	});

	it("parses inline lists with trailing comments", () => {
		const content = "harnesses: [claude-code, opencode] # preferred harnesses\n";
		expect(readHarnessesFromConfigContent(content)).toEqual(["claude-code", "opencode"]);
	});

	it("parses multi-line flow lists with base-indent closing bracket", () => {
		const content = "harnesses: [\n  claude-code,\n  opencode\n]\n";
		expect(readHarnessesFromConfigContent(content)).toEqual(["claude-code", "opencode"]);
	});

	it("handles embedded closing bracket characters in quoted values", () => {
		const content = "harnesses: ['foo[bar]', opencode]\n";
		expect(readHarnessesFromConfigContent(content)).toEqual(["foo[bar]", "opencode"]);
	});

	it("ignores empty list items while keeping valid harnesses", () => {
		const content = "harnesses:\n  - claude-code\n  -\n  - opencode\n";
		expect(readHarnessesFromConfigContent(content)).toEqual(["claude-code", "opencode"]);
	});

	it("returns null when harnesses key is missing", () => {
		const content = "name: boogy\n";
		expect(readHarnessesFromConfigContent(content)).toBeNull();
	});
});

describe("readEnabledHarnessesFromConfigFiles", () => {
	it("returns null when no harness config file exists", () => {
		const agentsDir = makeTempAgentsDir();
		expect(readEnabledHarnessesFromConfigFiles(agentsDir)).toBeNull();
	});

	it("reads harnesses from agent.yaml", () => {
		const agentsDir = makeTempAgentsDir();
		writeFileSync(
			join(agentsDir, "agent.yaml"),
			"harnesses:\n  - claude-code\n  - opencode\n",
		);

		const enabled = readEnabledHarnessesFromConfigFiles(agentsDir);
		expect(enabled).not.toBeNull();
		expect(enabled?.has("claude-code")).toBe(true);
		expect(enabled?.has("opencode")).toBe(true);
		expect(enabled?.has("openclaw")).toBe(false);
	});

	it("falls back to AGENT.yaml when agent.yaml is missing", () => {
		const agentsDir = makeTempAgentsDir();
		writeFileSync(join(agentsDir, "AGENT.yaml"), "harnesses: [openclaw]\n");

		const enabled = readEnabledHarnessesFromConfigFiles(agentsDir);
		expect(enabled).not.toBeNull();
		expect(enabled?.has("openclaw")).toBe(true);
	});

	it("returns empty set when config explicitly disables all harnesses", () => {
		const agentsDir = makeTempAgentsDir();
		writeFileSync(join(agentsDir, "agent.yaml"), "harnesses: []\n");

		const enabled = readEnabledHarnessesFromConfigFiles(agentsDir);
		expect(enabled).not.toBeNull();
		expect(enabled?.size).toBe(0);
	});
});

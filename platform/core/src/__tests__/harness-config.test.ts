import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfiguredHarnesses, parseHarnessList } from "../harness-config";

describe("parseHarnessList", () => {
	test("normalizes array and comma-separated harness config", () => {
		expect(parseHarnessList(["pi", " codex ", "", 42])).toEqual(["pi", "codex"]);
		expect(parseHarnessList("pi, codex,,opencode")).toEqual(["pi", "codex", "opencode"]);
	});
});

describe("loadConfiguredHarnesses", () => {
	test("loads active harnesses from agent.yaml", () => {
		const root = mkdtempSync(join(tmpdir(), "signet-harness-config-"));

		try {
			mkdirSync(root, { recursive: true });
			writeFileSync(join(root, "agent.yaml"), "harnesses:\n  - pi\n  - opencode\n");

			expect(loadConfiguredHarnesses(root)).toEqual(["pi", "opencode"]);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("returns empty list when no config declares harnesses", () => {
		const root = mkdtempSync(join(tmpdir(), "signet-harness-config-empty-"));

		try {
			writeFileSync(join(root, "agent.yaml"), "agent:\n  name: test\n");

			expect(loadConfiguredHarnesses(root)).toEqual([]);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});

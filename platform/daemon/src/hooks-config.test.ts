import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	DEFAULT_SESSION_START_MAX_INJECT_TOKENS,
	loadHooksConfig,
	resolveUserPromptMinScore,
} from "./hooks-config";

let tempDir: string | null = null;

function makeTempDir(): string {
	tempDir = mkdtempSync(join(tmpdir(), "signet-hooks-config-"));
	return tempDir;
}

afterEach(() => {
	if (tempDir) {
		rmSync(tempDir, { recursive: true, force: true });
		tempDir = null;
	}
});

describe("hooks config", () => {
	test("returns defaults when agent.yaml is absent", () => {
		const config = loadHooksConfig(makeTempDir());

		expect(config.sessionStart?.recallLimit).toBe(50);
		expect(config.sessionStart?.maxInjectTokens).toBe(DEFAULT_SESSION_START_MAX_INJECT_TOKENS);
		expect(config.userPromptSubmit?.enabled).toBe(true);
		expect(config.preCompaction?.includeRecentMemories).toBe(true);
	});

	test("loads configured hook sections from agent.yaml", () => {
		const dir = makeTempDir();
		writeFileSync(
			join(dir, "agent.yaml"),
			"hooks:\n  sessionStart:\n    recallLimit: 7\n  userPromptSubmit:\n    enabled: false\n    minScore: 0.42\n  preCompaction:\n    memoryLimit: 3\n",
		);

		const config = loadHooksConfig(dir);

		expect(config.sessionStart?.recallLimit).toBe(7);
		expect(config.userPromptSubmit?.enabled).toBe(false);
		expect(config.userPromptSubmit?.minScore).toBe(0.42);
		expect(config.preCompaction?.memoryLimit).toBe(3);
	});

	test("clamps user prompt minimum score", () => {
		expect(resolveUserPromptMinScore(undefined)).toBe(0.8);
		expect(resolveUserPromptMinScore(-1)).toBe(0);
		expect(resolveUserPromptMinScore(2)).toBe(1);
		expect(resolveUserPromptMinScore(0.33)).toBe(0.33);
	});
});

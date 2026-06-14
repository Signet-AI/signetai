import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	DEFAULT_SESSION_START_MAX_INJECT_TOKENS,
	loadHooksConfig,
	resolveHooksConfigForHarness,
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

	test("resolves harness context profiles over global hook defaults", () => {
		const dir = makeTempDir();
		writeFileSync(
			join(dir, "agent.yaml"),
			`hooks:
  sessionStart:
    recallLimit: 50
    maxInjectTokens: 12000
  userPromptSubmit:
    maxInjectChars: 500
  contextProfiles:
    coding:
      sessionStart:
        recallLimit: 5
        maxInjectTokens: 5000
      userPromptSubmit:
        maxInjectChars: 200
      identity:
        files:
          - path: AGENTS.md
            maxTokens: 1000
          - path: USER.md
            maxTokens: 500
  harnessProfiles:
    pi: coding
`,
		);

		const resolved = resolveHooksConfigForHarness(loadHooksConfig(dir), "PI");

		expect(resolved.profileName).toBe("coding");
		expect(resolved.sessionStart?.recallLimit).toBe(5);
		expect(resolved.sessionStart?.maxInjectTokens).toBe(5000);
		expect(resolved.userPromptSubmit?.maxInjectChars).toBe(200);
		expect(resolved.identity?.files?.map((entry) => entry.path)).toEqual(["AGENTS.md", "USER.md"]);
	});

	test("profile overrides inherit unrelated global hook settings instead of clobbering them", () => {
		const dir = makeTempDir();
		writeFileSync(
			join(dir, "agent.yaml"),
			`hooks:
  sessionStart:
    recallLimit: 50
    recencyBias: 0.3
    includeIdentity: false
    maxInjectTokens: 12000
  contextProfiles:
    coding:
      sessionStart:
        recallLimit: 5
  harnessProfiles:
    pi: coding
`,
		);

		const resolved = resolveHooksConfigForHarness(loadHooksConfig(dir), "pi");

		expect(resolved.sessionStart?.recallLimit).toBe(5);
		// Keys the profile did not mention must fall back to the global values.
		expect(resolved.sessionStart?.recencyBias).toBe(0.3);
		expect(resolved.sessionStart?.includeIdentity).toBe(false);
		expect(resolved.sessionStart?.maxInjectTokens).toBe(12000);
	});

	test("rejects unsafe profile identity paths and non-positive file budgets", () => {
		const dir = makeTempDir();
		writeFileSync(
			join(dir, "agent.yaml"),
			`hooks:
  contextProfiles:
    unsafe:
      identity:
        files:
          - path: .secrets/API_KEY.md
            maxTokens: 100
          - path: memory/transcript.md
            maxTokens: 100
          - path: AGENTS.md
            maxTokens: 0
          - path: USER.md
            maxTokens: 10
  harnessProfiles:
    pi: unsafe
`,
		);

		const resolved = resolveHooksConfigForHarness(loadHooksConfig(dir), "pi");

		expect(resolved.identity?.files?.map((entry) => entry.path)).toEqual(["USER.md"]);
	});

	test("supports a default context profile for unmapped harnesses", () => {
		const dir = makeTempDir();
		writeFileSync(
			join(dir, "agent.yaml"),
			`hooks:
  contextProfiles:
    lean:
      sessionStart:
        recallLimit: 3
  defaultContextProfile: lean
`,
		);

		const resolved = resolveHooksConfigForHarness(loadHooksConfig(dir), "unknown-harness");

		expect(resolved.profileName).toBe("lean");
		expect(resolved.sessionStart?.recallLimit).toBe(3);
	});

	test("clamps user prompt minimum score", () => {
		expect(resolveUserPromptMinScore(undefined)).toBe(0.8);
		expect(resolveUserPromptMinScore(-1)).toBe(0);
		expect(resolveUserPromptMinScore(2)).toBe(1);
		expect(resolveUserPromptMinScore(0.33)).toBe(0.33);
	});
});

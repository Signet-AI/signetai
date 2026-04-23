import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import {
	appendProviderTransitions,
	applyProviderRollback,
	detectProviderTransitions,
	executeProviderRollback,
	readProviderTransitions,
	validateProviderSafety,
} from "./provider-safety";

const tmpDirs: string[] = [];

afterEach(() => {
	while (tmpDirs.length > 0) {
		const dir = tmpDirs.pop();
		if (!dir) continue;
		rmSync(dir, { recursive: true, force: true });
	}
});

function makeTempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "signet-provider-safety-"));
	tmpDirs.push(dir);
	return dir;
}

describe("provider safety", () => {
	it("flags local-to-remote provider transitions for audit", () => {
		const before = "memory:\n  pipelineV2:\n    extractionProvider: ollama\n";
		const after = "memory:\n  pipelineV2:\n    extractionProvider: anthropic\n";
		const entries = detectProviderTransitions(before, after, "test", undefined, new Date("2026-04-12T00:00:00Z"));

		expect(entries).toEqual([
			{
				role: "extraction",
				from: "ollama",
				to: "anthropic",
				timestamp: "2026-04-12T00:00:00.000Z",
				source: "test",
				actor: undefined,
				risky: true,
			},
		]);
	});

	it("blocks remote providers when allowRemoteProviders is false", () => {
		const result = validateProviderSafety(`memory:
  pipelineV2:
    allowRemoteProviders: false
    extractionProvider: openrouter
`);

		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error).toContain("allowRemoteProviders is false");
			expect(result.error).toContain("openrouter");
		}
	});

	it("blocks command extraction when allowRemoteProviders is false", () => {
		const result = validateProviderSafety(`memory:
  pipelineV2:
    allowRemoteProviders: false
    extraction:
      provider: command
`);

		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error).toContain("allowRemoteProviders is false");
			expect(result.error).toContain("command");
		}
	});

	it("allows local providers when allowRemoteProviders is false", () => {
		const result = validateProviderSafety(`memory:
  pipelineV2:
    allowRemoteProviders: false
    extractionProvider: ollama
`);

		expect(result).toEqual({ ok: true });
	});

	it("rejects malformed YAML during safety validation", () => {
		const result = validateProviderSafety("memory:\n  pipelineV2: [");

		expect(result).toEqual({ ok: false, error: "Invalid YAML config" });
	});

	it("allows valid YAML without pipelineV2 section", () => {
		const result = validateProviderSafety("name: test\nversion: 1\n");

		expect(result).toEqual({ ok: true });
	});

	it("records transitions and rolls back the latest provider", async () => {
		const agentsDir = makeTempDir();
		const entries = detectProviderTransitions(
			"memory:\n  pipelineV2:\n    extractionProvider: none\n",
			"memory:\n  pipelineV2:\n    extractionProvider: codex\n",
			"test",
		);
		await appendProviderTransitions(agentsDir, entries);

		const stored = readProviderTransitions(agentsDir);
		expect(stored).toHaveLength(1);
		const next = applyProviderRollback("memory:\n  pipelineV2:\n    extractionProvider: codex\n", stored[0]);
		writeFileSync(join(agentsDir, "agent.yaml"), next, "utf-8");

		expect(readFileSync(join(agentsDir, "agent.yaml"), "utf-8")).toContain("extractionProvider: none");
	});

	it("clears model and endpoint fields on extraction rollback", async () => {
		const agentsDir = makeTempDir();
		const entries = detectProviderTransitions(
			"memory:\n  pipelineV2:\n    extractionProvider: ollama\n    extraction:\n      provider: ollama\n      model: qwen3:4b\n",
			"memory:\n  pipelineV2:\n    extractionProvider: anthropic\n    extraction:\n      provider: anthropic\n      model: claude-3-haiku\n      endpoint: https://api.anthropic.com\n",
			"test",
		);
		await appendProviderTransitions(agentsDir, entries);
		const stored = readProviderTransitions(agentsDir);
		expect(stored).toHaveLength(1);

		const next = applyProviderRollback(
			"memory:\n  pipelineV2:\n    extractionProvider: anthropic\n    extraction:\n      provider: anthropic\n      model: claude-3-haiku\n      endpoint: https://api.anthropic.com\n",
			stored[0],
		);
		expect(next).not.toContain("claude-3-haiku");
		expect(next).not.toContain("anthropic.com");
		expect(next).toContain("extractionProvider: ollama");
		expect(next).not.toContain("provider: anthropic");
	});

	it("clears flat pipelineV2 extraction keys on rollback", async () => {
		const agentsDir = makeTempDir();
		const entries = detectProviderTransitions(
			"memory:\n  pipelineV2:\n    extractionProvider: ollama\n",
			"memory:\n  pipelineV2:\n    extractionProvider: anthropic\n    extractionModel: claude-3-haiku\n    extractionEndpoint: https://api.anthropic.com\n",
			"test",
		);
		await appendProviderTransitions(agentsDir, entries);
		const stored = readProviderTransitions(agentsDir);
		expect(stored).toHaveLength(1);

		const next = applyProviderRollback(
			"memory:\n  pipelineV2:\n    extractionProvider: anthropic\n    extractionModel: claude-3-haiku\n    extractionEndpoint: https://api.anthropic.com\n",
			stored[0],
		);
		expect(next).not.toContain("claude-3-haiku");
		expect(next).not.toContain("anthropic.com");
		expect(next).toContain("extractionProvider: ollama");
	});

	it("prevents rollback ping-pong by marking consumed entries", async () => {
		const agentsDir = makeTempDir();
		const configDir = makeTempDir();

		writeFileSync(
			join(configDir, "agent.yaml"),
			"memory:\n  pipelineV2:\n    extractionProvider: anthropic\n",
			"utf-8",
		);

		const entries = detectProviderTransitions(
			"memory:\n  pipelineV2:\n    extractionProvider: ollama\n",
			"memory:\n  pipelineV2:\n    extractionProvider: anthropic\n",
			"test",
		);
		await appendProviderTransitions(agentsDir, entries);

		const result1 = await executeProviderRollback(agentsDir, join(configDir, "agent.yaml"));
		expect(result1.success).toBe(true);
		expect(result1.rolledBack.to).toBe("anthropic");

		const afterFirst = readFileSync(join(configDir, "agent.yaml"), "utf-8");
		expect(afterFirst).toContain("extractionProvider: ollama");

		const stored = readProviderTransitions(agentsDir);
		expect(stored[0].rolledBack).toBe(true);
	});

	it("serializes concurrent audit appends without losing transitions", async () => {
		const agentsDir = makeTempDir();
		const first = detectProviderTransitions(
			"memory:\n  pipelineV2:\n    extractionProvider: ollama\n",
			"memory:\n  pipelineV2:\n    extractionProvider: anthropic\n",
			"first",
		);
		const second = detectProviderTransitions(
			"memory:\n  pipelineV2:\n    synthesis:\n      provider: ollama\n",
			"memory:\n  pipelineV2:\n    synthesis:\n      provider: claude-code\n",
			"second",
		);

		await Promise.all([appendProviderTransitions(agentsDir, first), appendProviderTransitions(agentsDir, second)]);

		const stored = readProviderTransitions(agentsDir);
		expect(stored).toHaveLength(2);
		expect(stored.map((entry) => entry.source).sort()).toEqual(["first", "second"]);
	});

	it("serializes rollback audit consumption with concurrent appends", async () => {
		const agentsDir = makeTempDir();
		const configDir = makeTempDir();
		writeFileSync(
			join(configDir, "agent.yaml"),
			"memory:\n  pipelineV2:\n    extractionProvider: anthropic\n",
			"utf-8",
		);
		const initial = detectProviderTransitions(
			"memory:\n  pipelineV2:\n    extractionProvider: ollama\n",
			"memory:\n  pipelineV2:\n    extractionProvider: anthropic\n",
			"agent.yaml",
		);
		await appendProviderTransitions(agentsDir, initial);
		const priorTransitions = readProviderTransitions(agentsDir);
		const concurrent = detectProviderTransitions(
			"memory:\n  pipelineV2:\n    synthesis:\n      provider: ollama\n",
			"memory:\n  pipelineV2:\n    synthesis:\n      provider: claude-code\n",
			"concurrent-save",
		);

		await Promise.all([
			appendProviderTransitions(agentsDir, concurrent),
			executeProviderRollback(agentsDir, join(configDir, "agent.yaml"), undefined, undefined, priorTransitions),
		]);

		const stored = readProviderTransitions(agentsDir);
		expect(stored.find((entry) => entry.source === "agent.yaml")?.rolledBack).toBe(true);
		expect(stored.some((entry) => entry.source === "concurrent-save")).toBe(true);
		expect(stored.some((entry) => entry.source === "api/config/provider-safety/rollback")).toBe(true);
	});

	it("skips corrupted entries in audit file", () => {
		const agentsDir = makeTempDir();
		const auditPath = join(agentsDir, ".daemon");
		mkdirSync(auditPath, { recursive: true });
		writeFileSync(
			join(auditPath, "provider-transitions.json"),
			JSON.stringify([
				{
					role: "extraction",
					from: "ollama",
					to: "anthropic",
					timestamp: "2026-04-12T00:00:00Z",
					source: "test",
					risky: true,
				},
				{ garbage: true },
				42,
				{ role: "synthesis" },
				null,
				"string",
				{
					role: "extraction",
					from: "ollama",
					to: "codex",
					timestamp: "2026-04-12T00:01:00Z",
					source: "test",
					risky: true,
				},
			]),
			"utf-8",
		);

		const stored = readProviderTransitions(agentsDir);
		expect(stored).toHaveLength(2);
		expect(stored[0].to).toBe("anthropic");
		expect(stored[1].to).toBe("codex");
	});

	it("returns empty array for non-array audit file content", () => {
		const agentsDir = makeTempDir();
		const auditPath = join(agentsDir, ".daemon");
		mkdirSync(auditPath, { recursive: true });
		writeFileSync(join(auditPath, "provider-transitions.json"), JSON.stringify({ not: "an array" }), "utf-8");

		expect(readProviderTransitions(agentsDir)).toEqual([]);
	});

	it("returns empty array for missing audit file", () => {
		const agentsDir = makeTempDir();
		expect(readProviderTransitions(agentsDir)).toEqual([]);
	});

	it("executeProviderRollback rejects when no eligible transition exists", async () => {
		const agentsDir = makeTempDir();
		const configDir = makeTempDir();
		writeFileSync(join(configDir, "agent.yaml"), "memory:\n  pipelineV2:\n    extractionProvider: ollama\n", "utf-8");

		await expect(executeProviderRollback(agentsDir, join(configDir, "agent.yaml"))).rejects.toThrow(
			"No provider transition with rollback target found",
		);
	});

	it("rolls back synthesis provider transition end-to-end", async () => {
		const agentsDir = makeTempDir();
		const configDir = makeTempDir();

		writeFileSync(
			join(configDir, "agent.yaml"),
			[
				"memory:",
				"  pipelineV2:",
				"    synthesis:",
				"      provider: claude-code",
				"      model: claude-sonnet-4-20250514",
				"      endpoint: https://api.anthropic.com",
				"",
			].join("\n"),
			"utf-8",
		);

		const entries = detectProviderTransitions(
			["memory:", "  pipelineV2:", "    synthesis:", "      provider: ollama", ""].join("\n"),
			[
				"memory:",
				"  pipelineV2:",
				"    synthesis:",
				"      provider: claude-code",
				"      model: claude-sonnet-4-20250514",
				"      endpoint: https://api.anthropic.com",
				"",
			].join("\n"),
			"agent.yaml",
		);
		expect(entries).toHaveLength(1);
		expect(entries[0].role).toBe("synthesis");
		expect(entries[0].from).toBe("ollama");
		expect(entries[0].to).toBe("claude-code");
		await appendProviderTransitions(agentsDir, entries);

		const result = await executeProviderRollback(agentsDir, join(configDir, "agent.yaml"));
		expect(result.success).toBe(true);
		expect(result.rolledBack.role).toBe("synthesis");
		expect(result.rolledBack.from).toBe("ollama");
		expect(result.rolledBack.to).toBe("claude-code");

		const after = readFileSync(join(configDir, "agent.yaml"), "utf-8");
		expect(after).toContain("provider: ollama");
		expect(after).not.toContain("claude-sonnet-4-20250514");
		expect(after).not.toContain("anthropic.com");
	});

	it("does not create empty extraction sub-block when only flat keys are used", async () => {
		const agentsDir = makeTempDir();
		const entries = detectProviderTransitions(
			"memory:\n  pipelineV2:\n    extractionProvider: ollama\n",
			"memory:\n  pipelineV2:\n    extractionProvider: anthropic\n",
			"test",
		);
		await appendProviderTransitions(agentsDir, entries);
		const stored = readProviderTransitions(agentsDir);

		const configWithOnlyFlatKeys = "memory:\n  pipelineV2:\n    extractionProvider: anthropic\n";
		const result = applyProviderRollback(configWithOnlyFlatKeys, stored[0]);
		expect(result).toContain("extractionProvider: ollama");
		expect(result).not.toContain("extraction:");
	});

	it("does not create synthesis sub-block when one does not exist in current config", async () => {
		const agentsDir = makeTempDir();
		const entries = detectProviderTransitions(
			"memory:\n  pipelineV2:\n    synthesis:\n      provider: ollama\n",
			"memory:\n  pipelineV2:\n    synthesis:\n      provider: claude-code\n      model: claude-sonnet-4-20250514\n",
			"test",
		);
		expect(entries).toHaveLength(1);
		expect(entries[0].role).toBe("synthesis");
		await appendProviderTransitions(agentsDir, entries);
		const stored = readProviderTransitions(agentsDir);

		const configNoSynthesis = "memory:\n  pipelineV2:\n    extractionProvider: ollama\n";
		const result = applyProviderRollback(configNoSynthesis, stored[0]);
		expect(result).not.toContain("synthesis:");
		expect(result).toContain("extractionProvider: ollama");
	});

	it("marks audit consumed and returns isRetry when config already has correct provider", async () => {
		const agentsDir = makeTempDir();
		const configDir = makeTempDir();

		writeFileSync(
			join(configDir, "agent.yaml"),
			"memory:\n  pipelineV2:\n    synthesis:\n      provider: ollama\n",
			"utf-8",
		);

		const entries = detectProviderTransitions(
			"memory:\n  pipelineV2:\n    synthesis:\n      provider: ollama\n",
			"memory:\n  pipelineV2:\n    synthesis:\n      provider: claude-code\n",
			"test",
		);
		expect(entries).toHaveLength(1);
		await appendProviderTransitions(agentsDir, entries);

		const result = await executeProviderRollback(agentsDir, join(configDir, "agent.yaml"));
		expect(result.isRetry).toBe(true);
		expect(result.providerTransitions).toHaveLength(0);

		const stored = readProviderTransitions(agentsDir);
		expect(stored[0].rolledBack).toBe(true);
	});

	it("throws 400 on synthesis rollback when synthesis block absent", async () => {
		const agentsDir = makeTempDir();
		const configDir = makeTempDir();

		writeFileSync(join(configDir, "agent.yaml"), "memory:\n  pipelineV2:\n    extractionProvider: ollama\n", "utf-8");

		const entries = detectProviderTransitions(
			"memory:\n  pipelineV2:\n    synthesis:\n      provider: ollama\n",
			"memory:\n  pipelineV2:\n    synthesis:\n      provider: claude-code\n",
			"test",
		);
		expect(entries).toHaveLength(1);
		await appendProviderTransitions(agentsDir, entries);

		await expect(executeProviderRollback(agentsDir, join(configDir, "agent.yaml"))).rejects.toThrow(
			/No synthesis configuration found/,
		);

		const stored = readProviderTransitions(agentsDir);
		expect(stored[0].rolledBack).toBeFalsy();
	});

	it("rolls back nested-only extraction config by adding flat key", async () => {
		const agentsDir = makeTempDir();
		const configDir = makeTempDir();

		writeFileSync(
			join(configDir, "agent.yaml"),
			["memory:", "  pipelineV2:", "    extraction:", "      provider: ollama", ""].join("\n"),
			"utf-8",
		);

		const entries = detectProviderTransitions(
			["memory:", "  pipelineV2:", "    extraction:", "      provider: ollama", ""].join("\n"),
			["memory:", "  pipelineV2:", "    extraction:", "      provider: claude-code", ""].join("\n"),
			"test",
		);
		expect(entries).toHaveLength(1);
		await appendProviderTransitions(agentsDir, entries);

		const result = await executeProviderRollback(agentsDir, join(configDir, "agent.yaml"));
		expect(result.success).toBe(true);
		expect(result.rolledBack.rolledBack).toBe(true);

		const stored = readProviderTransitions(agentsDir);
		expect(stored[0].rolledBack).toBe(true);

		const updatedContent = readFileSync(join(configDir, "agent.yaml"), "utf-8");
		const updatedRoot = parse(updatedContent) as Record<string, unknown>;
		const updatedPipeline = (updatedRoot.memory as Record<string, unknown>).pipelineV2 as Record<string, unknown>;
		expect(updatedPipeline.extractionProvider).toBe("ollama");
	});

	it("skips rollback-sourced entries when selecting rollback target", async () => {
		const agentsDir = makeTempDir();
		const configDir = makeTempDir();

		writeFileSync(
			join(configDir, "agent.yaml"),
			"memory:\n  pipelineV2:\n    extraction:\n      provider: ollama\n",
			"utf-8",
		);

		const firstTransition = detectProviderTransitions(
			"memory:\n  pipelineV2:\n    extraction:\n      provider: ollama\n",
			"memory:\n  pipelineV2:\n    extraction:\n      provider: claude-code\n",
			"test",
		);
		expect(firstTransition).toHaveLength(1);
		await appendProviderTransitions(agentsDir, firstTransition);

		const result = await executeProviderRollback(agentsDir, join(configDir, "agent.yaml"));
		expect(result.success).toBe(true);

		await expect(executeProviderRollback(agentsDir, join(configDir, "agent.yaml"))).rejects.toThrow(
			/No provider transition with rollback target found/,
		);
	});
});

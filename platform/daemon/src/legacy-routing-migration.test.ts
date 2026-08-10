import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	migrateLegacyRoutingToRegistry,
	migrateRetiredExtractionWriterConfig,
	migrateRetiredMemoryPipelineRouting,
	migrateSessionSynthesisRoute,
} from "./config-migration";
import { loadMemoryConfig } from "./memory-config";

function setupDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "signet-legacy-routing-migration-"));
	mkdirSync(join(dir, "memory"), { recursive: true });
	return dir;
}

describe("migrateLegacyRoutingToRegistry (#947 v4, #1004 v5 cleanup)", () => {
	it("compiles legacy extraction and removes the obsolete synthesis block", () => {
		const dir = setupDir();
		try {
			writeFileSync(
				join(dir, "agent.yaml"),
				`memory:
  pipelineV2:
    enabled: true
    extraction:
      provider: openrouter
      model: anthropic/claude-haiku
      endpoint: https://openrouter.ai/api/v1
      fallbackProvider: ollama
      timeout: 90000            # tuning — must be preserved
    synthesis:
      enabled: true
      provider: anthropic
      model: claude-haiku
      maxTokens: 1024           # tuning — must be preserved
`,
			);
			migrateLegacyRoutingToRegistry(dir);
			const after = readFileSync(join(dir, "agent.yaml"), "utf-8");

			// Registry created with the right shape.
			expect(after).toContain("inference:");
			expect(after).toMatch(/accounts:\s*\n\s+legacy-openrouter:/);
			expect(after).toMatch(/providerFamily: openrouter/);
			expect(after).toMatch(/credentialRef: OPENROUTER_API_KEY/);

			// Targets carry executor + model + account.
			expect(after).toMatch(/legacy-extraction:/);
			expect(after).toMatch(/executor: openrouter/);
			expect(after).toMatch(/account: legacy-openrouter/);
			expect(after).toMatch(/model: anthropic\/claude-haiku/);

			// Only extraction has a configurable workload; session processing follows it.
			expect(after).toMatch(/memoryExtraction:\s*\n\s+target: legacy-extraction\/default/);
			expect(after).not.toContain("sessionSynthesis");
			expect(after).not.toContain("legacy-synthesis");

			// Legacy extraction routing is gone; extraction tuning remains.
			expect(after).not.toMatch(/provider: openrouter/);
			expect(after).not.toMatch(/fallbackProvider:/);
			expect(after).not.toMatch(/memory.pipelineV2.synthesis/);
			expect(after).toContain("timeout: 90000");
			expect(after).not.toContain("maxTokens: 1024");

			// Version stamped.
			expect(after).toMatch(/^configVersion: 5/m);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("removes retired routing from an already-versioned config before strict loading", () => {
		const dir = setupDir();
		try {
			writeFileSync(
				join(dir, "agent.yaml"),
				`configVersion: 7
memory:
  synthesis:
    harness: openclaw
    model: sonnet
  pipelineV2:
    enabled: true
    allowRemoteProviders: false
    extraction:
      provider: openrouter
      model: anthropic/claude-haiku
      endpoint: https://openrouter.ai/api/v1
      strength: high
    synthesis:
      enabled: true
      timeout: 90000
      maxTokens: 1024
`,
			);
			migrateRetiredMemoryPipelineRouting(dir);
			const after = readFileSync(join(dir, "agent.yaml"), "utf-8");
			expect(after).toMatch(/^configVersion: 8/m);
			expect(after).not.toContain("allowRemoteProviders");
			expect(after).not.toContain("provider: openrouter");
			expect(after).not.toMatch(/^\s+synthesis:/m);
			expect(after).toContain("strength: high");
			expect(() => loadMemoryConfig(dir)).not.toThrow();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("preserves unsupported routing so strict loading reports the required reconfiguration", () => {
		const dir = setupDir();
		try {
			writeFileSync(
				join(dir, "agent.yaml"),
				`configVersion: 7
memory:
  pipelineV2:
    enabled: true
    extraction:
      provider: groq
      model: llama-3
      endpoint: https://api.groq.com/openai/v1
`,
			);

			migrateRetiredMemoryPipelineRouting(dir);
			const after = readFileSync(join(dir, "agent.yaml"), "utf-8");
			expect(after).toMatch(/^configVersion: 8/m);
			expect(after).toContain("provider: groq");
			expect(after).toContain("model: llama-3");
			expect(() => loadMemoryConfig(dir)).toThrow("is retired");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
	it("compiles legacy flat extraction routing instead of deleting it", () => {
		const dir = setupDir();
		try {
			writeFileSync(
				join(dir, "agent.yaml"),
				`memory:
  pipelineV2:
    extractionProvider: openrouter
    extractionModel: anthropic/claude-haiku
    extractionEndpoint: https://openrouter.ai/api/v1
    extractionStrength: high
`,
			);
			migrateLegacyRoutingToRegistry(dir);
			const after = readFileSync(join(dir, "agent.yaml"), "utf-8");

			expect(after).toMatch(/legacy-extraction:/);
			expect(after).toMatch(/executor: openrouter/);
			expect(after).toMatch(/model: anthropic\/claude-haiku/);
			expect(after).toMatch(/target: legacy-extraction\/default/);
			expect(after).toMatch(/strength: high/);
			expect(after).not.toContain("extractionProvider:");
			expect(after).not.toContain("extractionModel:");
			expect(after).not.toContain("extractionEndpoint:");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("falls back to a valid nested route when flat routing is unsupported", () => {
		const dir = setupDir();
		try {
			writeFileSync(
				join(dir, "agent.yaml"),
				`configVersion: 3
memory:
  pipelineV2:
    extractionProvider: groq
    extractionModel: groq/legacy
    extraction:
      provider: openrouter
      model: anthropic/claude-haiku
      endpoint: https://openrouter.ai/api/v1
`,
			);
			migrateLegacyRoutingToRegistry(dir);
			const after = readFileSync(join(dir, "agent.yaml"), "utf-8");

			expect(after).toContain("extractionProvider: groq");
			expect(after).toMatch(/executor: openrouter/);
			expect(after).toMatch(/target: legacy-extraction\/default/);
			expect(after).not.toMatch(/provider: openrouter/);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("preserves a nested base_url when compiling the legacy route", () => {
		const dir = setupDir();
		try {
			writeFileSync(
				join(dir, "agent.yaml"),
				`memory:
  pipelineV2:
    extraction:
      provider: openai-compatible
      model: local-model
      base_url: http://127.0.0.1:9999/v1
`,
			);
			migrateLegacyRoutingToRegistry(dir);
			const after = readFileSync(join(dir, "agent.yaml"), "utf-8");

			expect(after).toMatch(/executor: openai-compatible/);
			expect(after).toMatch(/endpoint: http:\/\/127\.0\.0\.1:9999\/v1/);
			expect(after).not.toContain("base_url:");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("creates no account for local providers (ollama/llama-cpp/local-openai-compat)", () => {
		const dir = setupDir();
		try {
			writeFileSync(
				join(dir, "agent.yaml"),
				`memory:
  pipelineV2:
    extraction:
      provider: ollama
      model: gemma4
      endpoint: http://127.0.0.1:11434
`,
			);
			migrateLegacyRoutingToRegistry(dir);
			const after = readFileSync(join(dir, "agent.yaml"), "utf-8");
			expect(after).toMatch(/executor: ollama/);
			expect(after).not.toMatch(/legacy-ollama:/);
			expect(after).not.toMatch(/account:/);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("leaves the command provider intact for manual reconfiguration", () => {
		const dir = setupDir();
		try {
			writeFileSync(
				join(dir, "agent.yaml"),
				`memory:
  pipelineV2:
    extraction:
      provider: command
      command:
        bin: ./my-script
`,
			);
			migrateLegacyRoutingToRegistry(dir);
			const after = readFileSync(join(dir, "agent.yaml"), "utf-8");
			// command stays intact (manual reconfiguration required); no target created.
			expect(after).toContain("provider: command");
			expect(after).toContain("bin: ./my-script");
			expect(after).not.toMatch(/legacy-extraction:/);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("is idempotent — a second run is a no-op", () => {
		const dir = setupDir();
		try {
			writeFileSync(
				join(dir, "agent.yaml"),
				`memory:
  pipelineV2:
    extraction:
      provider: openrouter
      model: x
`,
			);
			migrateLegacyRoutingToRegistry(dir);
			const after1 = readFileSync(join(dir, "agent.yaml"), "utf-8");
			migrateLegacyRoutingToRegistry(dir);
			const after2 = readFileSync(join(dir, "agent.yaml"), "utf-8");
			expect(after2).toBe(after1);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("stamps v5 even when there is no legacy routing to migrate", () => {
		const dir = setupDir();
		try {
			writeFileSync(
				join(dir, "agent.yaml"),
				`memory:
  pipelineV2:
    enabled: true
inference:
  targets:
    background:
      executor: openai-compatible
`,
			);
			migrateLegacyRoutingToRegistry(dir);
			const after = readFileSync(join(dir, "agent.yaml"), "utf-8");
			expect(after).toMatch(/^configVersion: 5/m);
			// Existing inference block untouched.
			expect(after).toContain("background:");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("cleans flat routing keys from already-migrated v4 configs while preserving tuning", () => {
		const dir = setupDir();
		try {
			writeFileSync(
				join(dir, "agent.yaml"),
				`configVersion: 4
memory:
  pipelineV2:
    enabled: true
    extractionProvider: openrouter
    extractionModel: gpt-5.3-codex-spark
    extractionStrength: medium
    extractionTimeout: 45000
    extraction:
      harness: codex
      timeout: 90000
      strength: low
inference:
  targets:
    background-acpx:
      executor: acpx
      models:
        default:
          model: gpt-5.3-codex-spark
  workloads:
    memoryExtraction:
      target: background-acpx/default
`,
			);

			migrateLegacyRoutingToRegistry(dir);
			const after = readFileSync(join(dir, "agent.yaml"), "utf-8");

			expect(after).toMatch(/^configVersion: 5/m);
			expect(after).not.toContain("extractionProvider:");
			expect(after).not.toContain("extractionModel:");
			expect(after).not.toContain("extractionStrength:");
			expect(after).toMatch(/extraction:\s*\n\s+harness: codex\s*\n\s+timeout: 90000\s*\n\s+strength: medium/);
			expect(after).toContain("extractionTimeout: 45000");
			expect(after).toContain("enabled: true");
			expect(after).toContain("target: background-acpx/default");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("keeps canonical strength when the legacy flat value is null", () => {
		const dir = setupDir();
		try {
			writeFileSync(
				join(dir, "agent.yaml"),
				`configVersion: 4
memory:
  pipelineV2:
    extractionStrength: null
    extraction:
      strength: high
`,
			);

			migrateLegacyRoutingToRegistry(dir);
			const after = readFileSync(join(dir, "agent.yaml"), "utf-8");

			expect(after).not.toContain("extractionStrength:");
			expect(after).toContain("strength: high");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("skips an unparseable file without throwing", () => {
		const dir = setupDir();
		try {
			writeFileSync(join(dir, "agent.yaml"), "memory:\n  [unterminated");
			expect(() => migrateLegacyRoutingToRegistry(dir)).not.toThrow();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("removes stale session synthesis routing in v6 and is idempotent", () => {
		const dir = setupDir();
		try {
			writeFileSync(
				join(dir, "agent.yaml"),
				`configVersion: 5
inference:
  targets:
    legacy-synthesis:
      executor: llama-cpp
      models:
        default:
          model: qwen3:4b
    aggregation:
      executor: openrouter
      models:
        default:
          model: deepseek/deepseek-v4-flash
  workloads:
    memoryExtraction:
      target: background/default
    sessionSynthesis:
      target: legacy-synthesis/default
    aggregateRecall:
      target: aggregation/default
  taskClasses:
    session_synthesis:
      reasoning: medium
`,
			);
			migrateSessionSynthesisRoute(dir);
			const after = readFileSync(join(dir, "agent.yaml"), "utf-8");
			expect(after).toMatch(/^configVersion: 6/m);
			expect(after).not.toContain("sessionSynthesis");
			expect(after).not.toContain("legacy-synthesis");
			expect(after).not.toContain("session_synthesis");
			expect(after).toContain("target: aggregation/default");
			migrateSessionSynthesisRoute(dir);
			expect(readFileSync(join(dir, "agent.yaml"), "utf-8")).toBe(after);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("does not create a synthesis target when synthesis.enabled is false", () => {
		// Regression: the old code used String(scalarNode) which returns "false"
		// (a truthy string), so the guard never fired and a disabled synthesis was
		// silently re-enabled — destructive for a migration that nulls routing keys.
		const dir = setupDir();
		try {
			writeFileSync(
				join(dir, "agent.yaml"),
				`memory:
  pipelineV2:
    synthesis:
      enabled: false
      provider: openrouter
      model: anthropic/claude-sonnet
    extraction:
      provider: openrouter
      model: anthropic/claude-haiku
`,
			);
			migrateLegacyRoutingToRegistry(dir);
			const after = readFileSync(join(dir, "agent.yaml"), "utf-8");
			// Extraction target created; synthesis target must NOT be.
			expect(after).toContain("legacy-extraction");
			expect(after).not.toContain("sessionSynthesis");
			expect(after).not.toContain("legacy-synthesis");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("removes retired extraction writer config in v7 and is idempotent", () => {
		const dir = setupDir();
		try {
			writeFileSync(
				join(dir, "agent.yaml"),
				`configVersion: 6
memory:
  pipelineV2:
    enabled: true
    writeGate:
      threshold: 0.45
    durability:
      enabled: true
    writeGateEnabled: true
    writeGateThreshold: 0.5
    writeGateContinuityDiscount: 0.2
    extraction:
      timeout: 30000
`,
			);

			migrateRetiredExtractionWriterConfig(dir);
			const after = readFileSync(join(dir, "agent.yaml"), "utf-8");
			expect(after).toMatch(/^configVersion: 7/m);
			for (const key of [
				"writeGate:",
				"durability:",
				"writeGateEnabled:",
				"writeGateThreshold:",
				"writeGateContinuityDiscount:",
			]) {
				expect(after).not.toContain(key);
			}
			expect(after).toContain("timeout: 30000");
			expect(() => loadMemoryConfig(dir)).not.toThrow();

			migrateRetiredExtractionWriterConfig(dir);
			expect(readFileSync(join(dir, "agent.yaml"), "utf-8")).toBe(after);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

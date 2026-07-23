import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrateLegacyRoutingToRegistry } from "./config-migration";

function setupDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "signet-legacy-routing-migration-"));
	mkdirSync(join(dir, "memory"), { recursive: true });
	return dir;
}

describe("migrateLegacyRoutingToRegistry (#947 v4, #1004 v5 cleanup)", () => {
	it("compiles legacy extraction + synthesis into inference registry and nulls routing keys", () => {
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
			expect(after).toMatch(/legacy-anthropic:/);

			// Targets carry executor + model + account.
			expect(after).toMatch(/legacy-extraction:/);
			expect(after).toMatch(/executor: openrouter/);
			expect(after).toMatch(/account: legacy-openrouter/);
			expect(after).toMatch(/model: anthropic\/claude-haiku/);

			// Workloads bound to the targets.
			expect(after).toMatch(/memoryExtraction:\s*\n\s+target: legacy-extraction\/default/);
			expect(after).toMatch(/sessionSynthesis:\s*\n\s+target: legacy-synthesis\/default/);

			// Legacy ROUTING keys gone, tuning preserved.
			expect(after).not.toMatch(/provider: openrouter/);
			expect(after).not.toMatch(/fallbackProvider:/);
			expect(after).toContain("timeout: 90000");
			expect(after).toContain("maxTokens: 1024");

			// Version stamped.
			expect(after).toMatch(/^configVersion: 5/m);
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
    extractionProvider: acpx
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
});

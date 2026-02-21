import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	DEFAULT_PIPELINE_V2,
	loadMemoryConfig,
	loadPipelineConfig,
} from "./memory-config";

const tmpDirs: string[] = [];

afterEach(() => {
	while (tmpDirs.length > 0) {
		const dir = tmpDirs.pop();
		if (!dir) continue;
		rmSync(dir, { recursive: true, force: true });
	}
});

function makeTempAgentsDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "signet-daemon-config-"));
	tmpDirs.push(dir);
	return dir;
}

describe("loadMemoryConfig", () => {
	it("prefers agent.yaml embedding settings over legacy files", () => {
		const agentsDir = makeTempAgentsDir();
		writeFileSync(
			join(agentsDir, "agent.yaml"),
			`embedding:
  provider: ollama
  model: all-minilm
  dimensions: 384
`,
		);
		writeFileSync(
			join(agentsDir, "AGENT.yaml"),
			`memory:
  embeddings:
    provider: openai
    model: text-embedding-3-large
    dimensions: 3072
`,
		);

		const cfg = loadMemoryConfig(agentsDir);
		expect(cfg.embedding.provider).toBe("ollama");
		expect(cfg.embedding.model).toBe("all-minilm");
		expect(cfg.embedding.dimensions).toBe(384);
	});

	it("falls back to AGENT.yaml memory.embeddings when agent.yaml is missing", () => {
		const agentsDir = makeTempAgentsDir();
		writeFileSync(
			join(agentsDir, "AGENT.yaml"),
			`memory:
  embeddings:
    provider: openai
    model: text-embedding-3-small
    dimensions: 1536
`,
		);

		const cfg = loadMemoryConfig(agentsDir);
		expect(cfg.embedding.provider).toBe("openai");
		expect(cfg.embedding.model).toBe("text-embedding-3-small");
		expect(cfg.embedding.dimensions).toBe(1536);
	});

	it("falls back to config.yaml embeddings for older installs", () => {
		const agentsDir = makeTempAgentsDir();
		writeFileSync(
			join(agentsDir, "config.yaml"),
			`embeddings:
  provider: openai
  model: text-embedding-3-large
  dimensions: 3072
`,
		);

		const cfg = loadMemoryConfig(agentsDir);
		expect(cfg.embedding.provider).toBe("openai");
		expect(cfg.embedding.model).toBe("text-embedding-3-large");
		expect(cfg.embedding.dimensions).toBe(3072);
	});

	it("includes pipelineV2 defaults when no config exists", () => {
		const agentsDir = makeTempAgentsDir();
		const cfg = loadMemoryConfig(agentsDir);
		expect(cfg.pipelineV2).toEqual(DEFAULT_PIPELINE_V2);
	});

	it("loads pipelineV2 flags from agent.yaml", () => {
		const agentsDir = makeTempAgentsDir();
		writeFileSync(
			join(agentsDir, "agent.yaml"),
			`memory:
  pipelineV2:
    enabled: true
    shadowMode: true
    graphEnabled: true
    minFactConfidenceForWrite: 0.82
`,
		);

		const cfg = loadMemoryConfig(agentsDir);
		expect(cfg.pipelineV2.enabled).toBe(true);
		expect(cfg.pipelineV2.shadowMode).toBe(true);
		expect(cfg.pipelineV2.graphEnabled).toBe(true);
		// unset flags remain false
		expect(cfg.pipelineV2.allowUpdateDelete).toBe(false);
		expect(cfg.pipelineV2.autonomousEnabled).toBe(false);
		expect(cfg.pipelineV2.mutationsFrozen).toBe(false);
		expect(cfg.pipelineV2.autonomousFrozen).toBe(false);
		expect(cfg.pipelineV2.minFactConfidenceForWrite).toBe(0.82);
	});
});

describe("loadPipelineConfig", () => {
	it("returns all-false defaults when memory.pipelineV2 is absent", () => {
		const result = loadPipelineConfig({});
		expect(result).toEqual(DEFAULT_PIPELINE_V2);
	});

	it("returns all-false defaults when memory key exists but pipelineV2 is absent", () => {
		const result = loadPipelineConfig({ memory: { database: "test.db" } });
		expect(result).toEqual(DEFAULT_PIPELINE_V2);
	});

	it("loads all flags correctly when all set to true", () => {
		const result = loadPipelineConfig({
			memory: {
				pipelineV2: {
					enabled: true,
					shadowMode: true,
					allowUpdateDelete: true,
					graphEnabled: true,
					autonomousEnabled: true,
					mutationsFrozen: true,
					autonomousFrozen: true,
				},
			},
		});

		expect(result.enabled).toBe(true);
		expect(result.shadowMode).toBe(true);
		expect(result.allowUpdateDelete).toBe(true);
		expect(result.graphEnabled).toBe(true);
		expect(result.autonomousEnabled).toBe(true);
		expect(result.mutationsFrozen).toBe(true);
		expect(result.autonomousFrozen).toBe(true);
	});

	it("merges partial config with false defaults", () => {
		const result = loadPipelineConfig({
			memory: {
				pipelineV2: {
					enabled: true,
					mutationsFrozen: true,
				},
			},
		});

		expect(result.enabled).toBe(true);
		expect(result.mutationsFrozen).toBe(true);
		// everything else false
		expect(result.shadowMode).toBe(false);
		expect(result.allowUpdateDelete).toBe(false);
		expect(result.graphEnabled).toBe(false);
		expect(result.autonomousEnabled).toBe(false);
		expect(result.autonomousFrozen).toBe(false);
	});

	it("treats non-boolean truthy values as false", () => {
		const result = loadPipelineConfig({
			memory: {
				pipelineV2: {
					enabled: "yes",
					shadowMode: 1,
					graphEnabled: "true",
				},
			},
		});

		// strict === true check means these are all false
		expect(result.enabled).toBe(false);
		expect(result.shadowMode).toBe(false);
		expect(result.graphEnabled).toBe(false);
	});

	it("clamps numeric fields to valid ranges", () => {
		const result = loadPipelineConfig({
			memory: {
				pipelineV2: {
					workerPollMs: 0,
					workerMaxRetries: -5,
					extractionTimeout: 999999,
					leaseTimeoutMs: 1,
					minFactConfidenceForWrite: 3,
				},
			},
		});

		// workerPollMs: min 100
		expect(result.workerPollMs).toBe(100);
		// workerMaxRetries: min 1
		expect(result.workerMaxRetries).toBe(1);
		// extractionTimeout: max 300000
		expect(result.extractionTimeout).toBe(300000);
		// leaseTimeoutMs: min 10000
		expect(result.leaseTimeoutMs).toBe(10000);
		// minFactConfidenceForWrite: max 1
		expect(result.minFactConfidenceForWrite).toBe(1);
	});

	it("uses defaults for non-number numeric fields", () => {
		const result = loadPipelineConfig({
			memory: {
				pipelineV2: {
					workerPollMs: "fast",
					workerMaxRetries: null,
					extractionTimeout: undefined,
					leaseTimeoutMs: true,
					minFactConfidenceForWrite: "high",
				},
			},
		});

		expect(result.workerPollMs).toBe(DEFAULT_PIPELINE_V2.workerPollMs);
		expect(result.workerMaxRetries).toBe(DEFAULT_PIPELINE_V2.workerMaxRetries);
		expect(result.extractionTimeout).toBe(
			DEFAULT_PIPELINE_V2.extractionTimeout,
		);
		expect(result.leaseTimeoutMs).toBe(DEFAULT_PIPELINE_V2.leaseTimeoutMs);
		expect(result.minFactConfidenceForWrite).toBe(
			DEFAULT_PIPELINE_V2.minFactConfidenceForWrite,
		);
	});

	it("accepts valid numeric values within range", () => {
		const result = loadPipelineConfig({
			memory: {
				pipelineV2: {
					workerPollMs: 5000,
					workerMaxRetries: 5,
					extractionTimeout: 60000,
					leaseTimeoutMs: 120000,
					minFactConfidenceForWrite: 0.55,
				},
			},
		});

		expect(result.workerPollMs).toBe(5000);
		expect(result.workerMaxRetries).toBe(5);
		expect(result.extractionTimeout).toBe(60000);
		expect(result.leaseTimeoutMs).toBe(120000);
		expect(result.minFactConfidenceForWrite).toBe(0.55);
	});

	it("loads graph boost and reranker fields", () => {
		const result = loadPipelineConfig({
			memory: {
				pipelineV2: {
					graphBoostWeight: 0.25,
					graphBoostTimeoutMs: 300,
					rerankerEnabled: true,
					rerankerModel: "cross-encoder/ms-marco",
					rerankerTopN: 15,
					rerankerTimeoutMs: 1500,
				},
			},
		});

		expect(result.graphBoostWeight).toBe(0.25);
		expect(result.graphBoostTimeoutMs).toBe(300);
		expect(result.rerankerEnabled).toBe(true);
		expect(result.rerankerModel).toBe("cross-encoder/ms-marco");
		expect(result.rerankerTopN).toBe(15);
		expect(result.rerankerTimeoutMs).toBe(1500);
	});

	it("uses defaults for graph boost and reranker when absent", () => {
		const result = loadPipelineConfig({
			memory: { pipelineV2: { enabled: true } },
		});

		expect(result.graphBoostWeight).toBe(0.15);
		expect(result.graphBoostTimeoutMs).toBe(500);
		expect(result.rerankerEnabled).toBe(false);
		expect(result.rerankerModel).toBe("");
		expect(result.rerankerTopN).toBe(20);
		expect(result.rerankerTimeoutMs).toBe(2000);
	});
});

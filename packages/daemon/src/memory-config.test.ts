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
	it("prefers agent.yaml embedding settings over config.yaml fallback", () => {
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
			join(agentsDir, "config.yaml"),
			`embeddings:
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

	it("defaults to native provider when no config exists", () => {
		const agentsDir = makeTempAgentsDir();
		const cfg = loadMemoryConfig(agentsDir);
		expect(cfg.embedding.provider).toBe("native");
		expect(cfg.embedding.model).toBe("nomic-embed-text-v1.5");
		expect(cfg.embedding.dimensions).toBe(768);
	});

	it("respects ollama+nomic-embed-text config without overriding", () => {
		const agentsDir = makeTempAgentsDir();
		writeFileSync(
			join(agentsDir, "agent.yaml"),
			"embedding:\n  provider: ollama\n  model: nomic-embed-text\n  dimensions: 768\n",
		);
		const cfg = loadMemoryConfig(agentsDir);
		expect(cfg.embedding.provider).toBe("ollama");
		expect(cfg.embedding.model).toBe("nomic-embed-text");
	});

	it("defaults ollama base_url to localhost:11434 when not specified", () => {
		const agentsDir = makeTempAgentsDir();
		writeFileSync(
			join(agentsDir, "agent.yaml"),
			"embedding:\n  provider: ollama\n  model: nomic-embed-text\n",
		);
		const cfg = loadMemoryConfig(agentsDir);
		expect(cfg.embedding.provider).toBe("ollama");
		expect(cfg.embedding.base_url).toBe("http://localhost:11434");
	});

	it("respects explicit ollama base_url when provided", () => {
		const agentsDir = makeTempAgentsDir();
		writeFileSync(
			join(agentsDir, "agent.yaml"),
			"embedding:\n  provider: ollama\n  model: nomic-embed-text\n  base_url: http://192.168.1.100:11434\n",
		);
		const cfg = loadMemoryConfig(agentsDir);
		expect(cfg.embedding.provider).toBe("ollama");
		expect(cfg.embedding.base_url).toBe("http://192.168.1.100:11434");
	});

	it("defaults ollama base_url when explicitly empty", () => {
		const agentsDir = makeTempAgentsDir();
		writeFileSync(
			join(agentsDir, "agent.yaml"),
			"embedding:\n  provider: ollama\n  model: nomic-embed-text\n  base_url: \"\"\n",
		);
		const cfg = loadMemoryConfig(agentsDir);
		expect(cfg.embedding.provider).toBe("ollama");
		expect(cfg.embedding.base_url).toBe("http://localhost:11434");
	});

	it("defaults openai base_url to the official API endpoint when not specified", () => {
		const agentsDir = makeTempAgentsDir();
		writeFileSync(
			join(agentsDir, "agent.yaml"),
			"embedding:\n  provider: openai\n  model: text-embedding-3-small\n",
		);
		const cfg = loadMemoryConfig(agentsDir);
		expect(cfg.embedding.provider).toBe("openai");
		expect(cfg.embedding.base_url).toBe("https://api.openai.com/v1");
	});

	it("respects explicit openai base_url when provided", () => {
		const agentsDir = makeTempAgentsDir();
		writeFileSync(
			join(agentsDir, "agent.yaml"),
			"embedding:\n  provider: openai\n  model: text-embedding-3-small\n  base_url: https://example.com/v1\n",
		);
		const cfg = loadMemoryConfig(agentsDir);
		expect(cfg.embedding.provider).toBe("openai");
		expect(cfg.embedding.base_url).toBe("https://example.com/v1");
	});

	it("respects ollama+nomic-embed-text:latest config without overriding", () => {
		const agentsDir = makeTempAgentsDir();
		writeFileSync(
			join(agentsDir, "agent.yaml"),
			"embedding:\n  provider: ollama\n  model: nomic-embed-text:latest\n  dimensions: 768\n",
		);
		const cfg = loadMemoryConfig(agentsDir);
		expect(cfg.embedding.provider).toBe("ollama");
	});

	it("does NOT migrate ollama+bge-large (non-nomic model)", () => {
		const agentsDir = makeTempAgentsDir();
		writeFileSync(
			join(agentsDir, "agent.yaml"),
			"embedding:\n  provider: ollama\n  model: bge-large\n  dimensions: 1024\n",
		);
		const cfg = loadMemoryConfig(agentsDir);
		expect(cfg.embedding.provider).toBe("ollama");
		expect(cfg.embedding.model).toBe("bge-large");
	});

	it("does NOT migrate openai provider", () => {
		const agentsDir = makeTempAgentsDir();
		writeFileSync(
			join(agentsDir, "agent.yaml"),
			"embedding:\n  provider: openai\n  model: text-embedding-3-small\n  dimensions: 1536\n",
		);
		const cfg = loadMemoryConfig(agentsDir);
		expect(cfg.embedding.provider).toBe("openai");
	});

	it("includes pipelineV2 defaults when no config exists", () => {
		const agentsDir = makeTempAgentsDir();
		const cfg = loadMemoryConfig(agentsDir);
		expect(cfg.pipelineV2).toEqual(DEFAULT_PIPELINE_V2);
	});

	it("loads pipelineV2 flags from agent.yaml (flat keys, backward compat)", () => {
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
		expect(cfg.pipelineV2.graph.enabled).toBe(true);
		// unset flags fall through to DEFAULT_PIPELINE_V2 values
		expect(cfg.pipelineV2.autonomous.allowUpdateDelete).toBe(DEFAULT_PIPELINE_V2.autonomous.allowUpdateDelete);
		expect(cfg.pipelineV2.autonomous.enabled).toBe(DEFAULT_PIPELINE_V2.autonomous.enabled);
		expect(cfg.pipelineV2.mutationsFrozen).toBe(DEFAULT_PIPELINE_V2.mutationsFrozen);
		expect(cfg.pipelineV2.autonomous.frozen).toBe(DEFAULT_PIPELINE_V2.autonomous.frozen);
		expect(cfg.pipelineV2.extraction.minConfidence).toBe(0.82);
	});

	it("loads codex extraction settings from agent.yaml", () => {
		const agentsDir = makeTempAgentsDir();
		writeFileSync(
			join(agentsDir, "agent.yaml"),
			`memory:
  pipelineV2:
    extractionProvider: codex
    extractionModel: gpt-5.3-codex
`,
		);

		const cfg = loadMemoryConfig(agentsDir);
		expect(cfg.pipelineV2.extraction.provider).toBe("codex");
		expect(cfg.pipelineV2.extraction.model).toBe("gpt-5.3-codex");
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

	it("resolves codex from nested extraction.provider", () => {
		const result = loadPipelineConfig({
			memory: {
				pipelineV2: {
					extractionProvider: "ollama",
					extraction: {
						provider: "codex",
						model: "gpt-5.3-codex",
					},
				},
			},
		});

		expect(result.extraction.provider).toBe("codex");
		expect(result.extraction.model).toBe("gpt-5.3-codex");
	});

	it("loads all flags correctly when all set to true (flat keys)", () => {
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
		expect(result.autonomous.allowUpdateDelete).toBe(true);
		expect(result.graph.enabled).toBe(true);
		expect(result.autonomous.enabled).toBe(true);
		expect(result.mutationsFrozen).toBe(true);
		expect(result.autonomous.frozen).toBe(true);
	});

	it("merges partial config with defaults", () => {
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
		// absent keys fall through to DEFAULT_PIPELINE_V2
		expect(result.shadowMode).toBe(DEFAULT_PIPELINE_V2.shadowMode);
		expect(result.autonomous.allowUpdateDelete).toBe(DEFAULT_PIPELINE_V2.autonomous.allowUpdateDelete);
		expect(result.graph.enabled).toBe(DEFAULT_PIPELINE_V2.graph.enabled);
		expect(result.autonomous.enabled).toBe(DEFAULT_PIPELINE_V2.autonomous.enabled);
		expect(result.autonomous.frozen).toBe(DEFAULT_PIPELINE_V2.autonomous.frozen);
	});

	it("loads feedback config and clamps weights", () => {
		const result = loadPipelineConfig({
			memory: {
				pipelineV2: {
					feedback: {
						enabled: true,
						ftsWeightDelta: 0.04,
						maxAspectWeight: 2,
						minAspectWeight: -1,
						decayEnabled: false,
						decayRate: 0.02,
						staleDays: 30,
						decayIntervalSessions: 25,
					},
				},
			},
		});

		expect(result.feedback.enabled).toBe(true);
		expect(result.feedback.ftsWeightDelta).toBe(0.04);
		expect(result.feedback.maxAspectWeight).toBe(1);
		expect(result.feedback.minAspectWeight).toBe(0);
		expect(result.feedback.decayEnabled).toBe(false);
		expect(result.feedback.decayRate).toBe(0.02);
		expect(result.feedback.staleDays).toBe(30);
		expect(result.feedback.decayIntervalSessions).toBe(25);
	});

	it("treats non-boolean truthy values as defaults (not coerced)", () => {
		const result = loadPipelineConfig({
			memory: {
				pipelineV2: {
					enabled: "yes",
					shadowMode: 1,
					graphEnabled: "true",
				},
			},
		});

		// non-boolean values are not typeof "boolean", so they fall through to defaults
		expect(result.enabled).toBe(DEFAULT_PIPELINE_V2.enabled);
		expect(result.shadowMode).toBe(DEFAULT_PIPELINE_V2.shadowMode);
		expect(result.graph.enabled).toBe(DEFAULT_PIPELINE_V2.graph.enabled);
	});

	it("clamps numeric fields to valid ranges (flat keys)", () => {
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
		expect(result.worker.pollMs).toBe(100);
		// workerMaxRetries: min 1
		expect(result.worker.maxRetries).toBe(1);
		// extractionTimeout: max 300000
		expect(result.extraction.timeout).toBe(300000);
		// leaseTimeoutMs: min 10000
		expect(result.worker.leaseTimeoutMs).toBe(10000);
		// minFactConfidenceForWrite: max 1
		expect(result.extraction.minConfidence).toBe(1);
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

		expect(result.worker.pollMs).toBe(DEFAULT_PIPELINE_V2.worker.pollMs);
		expect(result.worker.maxRetries).toBe(DEFAULT_PIPELINE_V2.worker.maxRetries);
		expect(result.extraction.timeout).toBe(
			DEFAULT_PIPELINE_V2.extraction.timeout,
		);
		expect(result.worker.leaseTimeoutMs).toBe(DEFAULT_PIPELINE_V2.worker.leaseTimeoutMs);
		expect(result.extraction.minConfidence).toBe(
			DEFAULT_PIPELINE_V2.extraction.minConfidence,
		);
	});

	it("accepts valid numeric values within range (flat keys)", () => {
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

		expect(result.worker.pollMs).toBe(5000);
		expect(result.worker.maxRetries).toBe(5);
		expect(result.extraction.timeout).toBe(60000);
		expect(result.worker.leaseTimeoutMs).toBe(120000);
		expect(result.extraction.minConfidence).toBe(0.55);
	});

	it("loads graph boost and reranker fields (flat keys)", () => {
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

		expect(result.graph.boostWeight).toBe(0.25);
		expect(result.graph.boostTimeoutMs).toBe(300);
		expect(result.reranker.enabled).toBe(true);
		expect(result.reranker.model).toBe("cross-encoder/ms-marco");
		expect(result.reranker.topN).toBe(15);
		expect(result.reranker.timeoutMs).toBe(1500);
	});

	it("uses defaults for graph boost and reranker when absent", () => {
		const result = loadPipelineConfig({
			memory: { pipelineV2: { enabled: true } },
		});

		expect(result.graph.boostWeight).toBe(DEFAULT_PIPELINE_V2.graph.boostWeight);
		expect(result.graph.boostTimeoutMs).toBe(DEFAULT_PIPELINE_V2.graph.boostTimeoutMs);
		expect(result.reranker.enabled).toBe(DEFAULT_PIPELINE_V2.reranker.enabled);
		expect(result.reranker.model).toBe(DEFAULT_PIPELINE_V2.reranker.model);
		expect(result.reranker.topN).toBe(DEFAULT_PIPELINE_V2.reranker.topN);
		expect(result.reranker.timeoutMs).toBe(DEFAULT_PIPELINE_V2.reranker.timeoutMs);
	});

	it("loads maintenance and repair config fields (flat keys)", () => {
		const result = loadPipelineConfig({
			memory: {
				pipelineV2: {
					maintenanceIntervalMs: 120000,
					maintenanceMode: "execute",
					repairReembedCooldownMs: 60000,
					repairReembedHourlyBudget: 5,
					repairRequeueCooldownMs: 30000,
					repairRequeueHourlyBudget: 100,
				},
			},
		});

		expect(result.autonomous.maintenanceIntervalMs).toBe(120000);
		expect(result.autonomous.maintenanceMode).toBe("execute");
		expect(result.repair.reembedCooldownMs).toBe(60000);
		expect(result.repair.reembedHourlyBudget).toBe(5);
		expect(result.repair.requeueCooldownMs).toBe(30000);
		expect(result.repair.requeueHourlyBudget).toBe(100);
	});

	it("uses defaults for maintenance config when absent", () => {
		const result = loadPipelineConfig({
			memory: { pipelineV2: { enabled: true } },
		});

		expect(result.autonomous.maintenanceIntervalMs).toBe(DEFAULT_PIPELINE_V2.autonomous.maintenanceIntervalMs);
		expect(result.autonomous.maintenanceMode).toBe(DEFAULT_PIPELINE_V2.autonomous.maintenanceMode);
		expect(result.repair.reembedCooldownMs).toBe(DEFAULT_PIPELINE_V2.repair.reembedCooldownMs);
		expect(result.repair.reembedHourlyBudget).toBe(DEFAULT_PIPELINE_V2.repair.reembedHourlyBudget);
		expect(result.repair.requeueCooldownMs).toBe(DEFAULT_PIPELINE_V2.repair.requeueCooldownMs);
		expect(result.repair.requeueHourlyBudget).toBe(DEFAULT_PIPELINE_V2.repair.requeueHourlyBudget);
	});

	it("rejects invalid maintenanceMode values", () => {
		const result = loadPipelineConfig({
			memory: {
				pipelineV2: {
					maintenanceMode: "turbo",
				},
			},
		});

		expect(result.autonomous.maintenanceMode).toBe(DEFAULT_PIPELINE_V2.autonomous.maintenanceMode);
	});

	it("preserves explicit false values over defaults", () => {
		const result = loadPipelineConfig({
			memory: {
				pipelineV2: {
					enabled: false,
					graph: { enabled: false },
					reranker: { enabled: false },
					autonomous: {
						enabled: false,
						allowUpdateDelete: false,
						maintenanceMode: "observe",
					},
				},
			},
		});

		expect(result.enabled).toBe(false);
		expect(result.graph.enabled).toBe(false);
		expect(result.reranker.enabled).toBe(false);
		expect(result.autonomous.enabled).toBe(false);
		expect(result.autonomous.allowUpdateDelete).toBe(false);
		expect(result.autonomous.maintenanceMode).toBe("observe");
	});

	it("supports nested config format", () => {
		const result = loadPipelineConfig({
			memory: {
				pipelineV2: {
					enabled: true,
					extraction: {
						provider: "ollama",
						model: "qwen3:8b",
						timeout: 30000,
						minConfidence: 0.8,
					},
					graph: { enabled: true, boostWeight: 0.3 },
					reranker: { enabled: true, model: "my-reranker", topN: 10 },
					autonomous: {
						enabled: true,
						frozen: false,
						allowUpdateDelete: true,
						maintenanceIntervalMs: 60000,
						maintenanceMode: "execute",
					},
				},
			},
		});

		expect(result.enabled).toBe(true);
		expect(result.extraction.provider).toBe("ollama");
		expect(result.extraction.model).toBe("qwen3:8b");
		expect(result.extraction.timeout).toBe(30000);
		expect(result.extraction.minConfidence).toBe(0.8);
		expect(result.graph.enabled).toBe(true);
		expect(result.graph.boostWeight).toBe(0.3);
		expect(result.reranker.enabled).toBe(true);
		expect(result.reranker.model).toBe("my-reranker");
		expect(result.reranker.topN).toBe(10);
		expect(result.autonomous.enabled).toBe(true);
		expect(result.autonomous.allowUpdateDelete).toBe(true);
		expect(result.autonomous.maintenanceIntervalMs).toBe(60000);
		expect(result.autonomous.maintenanceMode).toBe("execute");
	});

	it("nested keys take precedence over flat keys", () => {
		const result = loadPipelineConfig({
			memory: {
				pipelineV2: {
					// Flat key
					rerankerEnabled: false,
					rerankerModel: "flat-model",
					// Nested key (wins)
					reranker: {
						enabled: true,
						model: "nested-model",
					},
				},
			},
		});

		expect(result.reranker.enabled).toBe(true);
		expect(result.reranker.model).toBe("nested-model");
	});
});

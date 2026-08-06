import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	DEFAULT_LLAMACPP_MAX_INPUT_TOKENS,
	DEFAULT_PIPELINE_V2,
	MAX_LLAMACPP_MAX_INPUT_TOKENS,
	MAX_PROMPT_SUBMIT_EMBEDDING_TIMEOUT_MS,
	MIN_LLAMACPP_MAX_INPUT_TOKENS,
	MIN_PROMPT_SUBMIT_EMBEDDING_TIMEOUT_MS,
	detectLocalTimeZone,
	loadDreamingConfig,
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

describe("loadDreamingConfig", () => {
	it("defaults and bounds the low-volume backlog maximum wait", () => {
		expect(loadDreamingConfig({}).maxInterval).toBe(6 * 60 * 60 * 1_000);
		expect(loadDreamingConfig({ memory: { dreaming: { maxInterval: 1 } } }).maxInterval).toBe(5 * 60 * 1_000);
		expect(loadDreamingConfig({ memory: { dreaming: { maxInterval: 9 * 24 * 60 * 60 * 1_000 } } }).maxInterval).toBe(
			7 * 24 * 60 * 60 * 1_000,
		);
	});
});

function makeTempAgentsDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "signet-daemon-config-"));
	tmpDirs.push(dir);
	return dir;
}

function restoreWarmNativeEnv(value: string | undefined): void {
	if (value === undefined) {
		Reflect.deleteProperty(process.env, "SIGNET_EMBEDDING_WARM_NATIVE");
		return;
	}
	process.env.SIGNET_EMBEDDING_WARM_NATIVE = value;
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

	it("parses embedding.warmNative: false as the native kill-switch (#1073)", () => {
		const agentsDir = makeTempAgentsDir();
		writeFileSync(
			join(agentsDir, "agent.yaml"),
			`embedding:
  provider: native
  warmNative: false
`,
		);

		const cfg = loadMemoryConfig(agentsDir);
		expect(cfg.embedding.warmNative).toBe(false);
	});

	it("parses warmNative without requiring an explicit provider (#1073)", () => {
		const agentsDir = makeTempAgentsDir();
		const previous = process.env.SIGNET_EMBEDDING_WARM_NATIVE;
		try {
			Reflect.deleteProperty(process.env, "SIGNET_EMBEDDING_WARM_NATIVE");
			writeFileSync(join(agentsDir, "agent.yaml"), "embedding:\n  warmNative: false\n");
			expect(loadMemoryConfig(agentsDir).embedding.warmNative).toBe(false);
		} finally {
			restoreWarmNativeEnv(previous);
		}
	});

	it("defaults warmNative to true when unset (#1073)", () => {
		const agentsDir = makeTempAgentsDir();
		writeFileSync(join(agentsDir, "agent.yaml"), "embedding:\n  provider: native\n");

		const cfg = loadMemoryConfig(agentsDir);
		expect(cfg.embedding.warmNative).toBe(true);
	});

	it("lets SIGNET_EMBEDDING_WARM_NATIVE override the yaml value (#1073)", () => {
		const agentsDir = makeTempAgentsDir();
		writeFileSync(join(agentsDir, "agent.yaml"), "embedding:\n  provider: native\n  warmNative: true\n");
		const previous = process.env.SIGNET_EMBEDDING_WARM_NATIVE;
		try {
			process.env.SIGNET_EMBEDDING_WARM_NATIVE = "0";
			const cfg = loadMemoryConfig(agentsDir);
			expect(cfg.embedding.warmNative).toBe(false);
		} finally {
			restoreWarmNativeEnv(previous);
		}
	});

	it("applies SIGNET_EMBEDDING_WARM_NATIVE when no config file exists (#1073)", () => {
		const agentsDir = makeTempAgentsDir();
		const previous = process.env.SIGNET_EMBEDDING_WARM_NATIVE;
		try {
			process.env.SIGNET_EMBEDDING_WARM_NATIVE = "0";
			expect(loadMemoryConfig(agentsDir).embedding.warmNative).toBe(false);
		} finally {
			restoreWarmNativeEnv(previous);
		}
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
		expect(cfg.embedding.promptSubmitTimeoutMs).toBe(MIN_PROMPT_SUBMIT_EMBEDDING_TIMEOUT_MS);
		expect(cfg.embedding.llamaCppMaxInputTokens).toBe(DEFAULT_LLAMACPP_MAX_INPUT_TOKENS);
	});

	it("deliberately enables the bounded freshness prior by default and allows opt-out", () => {
		const defaultDir = makeTempAgentsDir();
		const defaults = loadMemoryConfig(defaultDir);
		expect(defaults.search.temporal_prior_enabled).toBe(true);
		expect(defaults.search.temporal_prior_weight).toBe(0.15);
		expect(defaults.search.temporal_prior_half_life_days).toBe(14);

		const disabledDir = makeTempAgentsDir();
		writeFileSync(join(disabledDir, "agent.yaml"), "search:\n  temporal_prior_enabled: false\n");
		expect(loadMemoryConfig(disabledDir).search.temporal_prior_enabled).toBe(false);
	});

	it("loads embedding prompt-submit timeout from agent.yaml", () => {
		const agentsDir = makeTempAgentsDir();
		writeFileSync(
			join(agentsDir, "agent.yaml"),
			"embedding:\n  provider: ollama\n  model: mxbai-embed-large\n  promptSubmitTimeoutMs: 10000\n",
		);

		const cfg = loadMemoryConfig(agentsDir);
		expect(cfg.embedding.promptSubmitTimeoutMs).toBe(10000);
	});

	it("clamps embedding prompt-submit timeout bounds", () => {
		const lowDir = makeTempAgentsDir();
		writeFileSync(join(lowDir, "agent.yaml"), "embedding:\n  provider: ollama\n  promptSubmitTimeoutMs: 50\n");
		expect(loadMemoryConfig(lowDir).embedding.promptSubmitTimeoutMs).toBe(MIN_PROMPT_SUBMIT_EMBEDDING_TIMEOUT_MS);

		const highDir = makeTempAgentsDir();
		writeFileSync(join(highDir, "agent.yaml"), "embedding:\n  provider: ollama\n  promptSubmitTimeoutMs: 999999\n");
		expect(loadMemoryConfig(highDir).embedding.promptSubmitTimeoutMs).toBe(MAX_PROMPT_SUBMIT_EMBEDDING_TIMEOUT_MS);
	});

	it("loads and clamps the llama.cpp input token limit", () => {
		const configuredDir = makeTempAgentsDir();
		writeFileSync(
			join(configuredDir, "agent.yaml"),
			"embedding:\n  provider: llama-cpp\n  llamaCppMaxInputTokens: 1800\n",
		);
		expect(loadMemoryConfig(configuredDir).embedding.llamaCppMaxInputTokens).toBe(1800);

		const lowDir = makeTempAgentsDir();
		writeFileSync(join(lowDir, "agent.yaml"), "embedding:\n  llamaCppMaxInputTokens: 1\n");
		expect(loadMemoryConfig(lowDir).embedding.llamaCppMaxInputTokens).toBe(MIN_LLAMACPP_MAX_INPUT_TOKENS);

		const highDir = makeTempAgentsDir();
		writeFileSync(join(highDir, "agent.yaml"), "embedding:\n  llamaCppMaxInputTokens: 999999\n");
		expect(loadMemoryConfig(highDir).embedding.llamaCppMaxInputTokens).toBe(MAX_LLAMACPP_MAX_INPUT_TOKENS);
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
		writeFileSync(join(agentsDir, "agent.yaml"), "embedding:\n  provider: ollama\n  model: nomic-embed-text\n");
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

	it("accepts embedding.endpoint as an alias for embedding.base_url", () => {
		const agentsDir = makeTempAgentsDir();
		writeFileSync(
			join(agentsDir, "agent.yaml"),
			"embedding:\n  provider: ollama\n  model: nomic-embed-text\n  endpoint: http://172.17.0.1:11434\n",
		);
		const cfg = loadMemoryConfig(agentsDir);
		expect(cfg.embedding.provider).toBe("ollama");
		expect(cfg.embedding.base_url).toBe("http://172.17.0.1:11434");
	});

	it("defaults ollama base_url when explicitly empty", () => {
		const agentsDir = makeTempAgentsDir();
		writeFileSync(
			join(agentsDir, "agent.yaml"),
			'embedding:\n  provider: ollama\n  model: nomic-embed-text\n  base_url: ""\n',
		);
		const cfg = loadMemoryConfig(agentsDir);
		expect(cfg.embedding.provider).toBe("ollama");
		expect(cfg.embedding.base_url).toBe("http://localhost:11434");
	});

	it("defaults openai base_url to the official API endpoint when not specified", () => {
		const agentsDir = makeTempAgentsDir();
		writeFileSync(join(agentsDir, "agent.yaml"), "embedding:\n  provider: openai\n  model: text-embedding-3-small\n");
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

	it("loads extraction fallbackProvider from nested config", () => {
		const agentsDir = makeTempAgentsDir();
		writeFileSync(
			join(agentsDir, "agent.yaml"),
			`memory:
  pipelineV2:
    extraction:
      provider: claude-code
      fallbackProvider: none
`,
		);

		const cfg = loadMemoryConfig(agentsDir);
		expect(cfg.pipelineV2.extraction.provider).toBe("claude-code");
		expect(cfg.pipelineV2.extraction.fallbackProvider).toBe("none");
	});

	it("loads extractionFallbackProvider from flat config", () => {
		const cfg = loadPipelineConfig({
			memory: {
				pipelineV2: {
					extractionProvider: "claude-code",
					extractionFallbackProvider: "none",
				},
			},
		});

		expect(cfg.extraction.provider).toBe("claude-code");
		expect(cfg.extraction.fallbackProvider).toBe("none");
	});

	it("rejects invalid extraction fallbackProvider values", () => {
		expect(() =>
			loadPipelineConfig({
				memory: {
					pipelineV2: {
						extraction: {
							fallbackProvider: "codex",
						},
					},
				},
			}),
		).toThrow('Invalid extraction fallbackProvider "codex"');
	});

	it("propagates invalid extraction fallbackProvider from agent config files", () => {
		const agentsDir = makeTempAgentsDir();
		writeFileSync(
			join(agentsDir, "agent.yaml"),
			`memory:
  pipelineV2:
    extraction:
      provider: claude-code
      fallbackProvider: codex
`,
		);

		expect(() => loadMemoryConfig(agentsDir)).toThrow('Invalid extraction fallbackProvider "codex"');
	});

	it("loads openrouter extraction settings from agent.yaml", () => {
		const agentsDir = makeTempAgentsDir();
		writeFileSync(
			join(agentsDir, "agent.yaml"),
			`memory:
  pipelineV2:
    extractionProvider: openrouter
    extractionModel: openai/gpt-4o-mini
`,
		);

		const cfg = loadMemoryConfig(agentsDir);
		expect(cfg.pipelineV2.extraction.provider).toBe("openrouter");
		expect(cfg.pipelineV2.extraction.model).toBe("openai/gpt-4o-mini");
	});

	it("loads openai-compatible extraction settings from agent.yaml", () => {
		const agentsDir = makeTempAgentsDir();
		writeFileSync(
			join(agentsDir, "agent.yaml"),
			`memory:
  pipelineV2:
    extraction:
      provider: openai-compatible
      model: gpt-4o-mini
      endpoint: https://gateway.example.test/v1
`,
		);

		const cfg = loadMemoryConfig(agentsDir);
		expect(cfg.pipelineV2.extraction.provider).toBe("openai-compatible");
		expect(cfg.pipelineV2.extraction.model).toBe("gpt-4o-mini");
		expect(cfg.pipelineV2.extraction.endpoint).toBe("https://gateway.example.test/v1");
	});

	it("keeps local openai-compatible extraction when remote providers are locked", () => {
		const result = loadPipelineConfig({
			memory: {
				pipelineV2: {
					allowRemoteProviders: false,
					extraction: {
						provider: "openai-compatible",
						model: "local-model",
						endpoint: "http://127.0.0.1:1234/v1",
					},
				},
			},
		});
		expect(result.extraction.provider).toBe("openai-compatible");
		expect(result.extraction.model).toBe("local-model");
		expect(result.extraction.endpoint).toBe("http://127.0.0.1:1234/v1");
	});

	it("falls back from remote openai-compatible extraction when remote providers are locked", () => {
		const result = loadPipelineConfig({
			memory: {
				pipelineV2: {
					allowRemoteProviders: false,
					extraction: {
						provider: "openai-compatible",
						model: "gpt-4o-mini",
						endpoint: "https://gateway.example.test/v1",
					},
				},
			},
		});
		expect(result.extraction.provider).toBe("llama-cpp");
		expect(result.extraction.model).toBe("qwen3:4b");
		expect(result.extraction.endpoint).toBeUndefined();
	});

	it("loads disabled extraction settings from agent.yaml", () => {
		const agentsDir = makeTempAgentsDir();
		writeFileSync(
			join(agentsDir, "agent.yaml"),
			`memory:
  pipelineV2:
    enabled: false
    extractionProvider: none
    extractionModel: ""
`,
		);

		const cfg = loadMemoryConfig(agentsDir);
		expect(cfg.pipelineV2.enabled).toBe(false);
		expect(cfg.pipelineV2.extraction.provider).toBe("none");
		expect(cfg.pipelineV2.extraction.model).toBe("");
	});

	it("rejects retired command extraction rather than silently falling back", () => {
		expect(() =>
			loadPipelineConfig({
				memory: { pipelineV2: { extraction: { provider: "command" } } },
			}),
		).toThrow("command configuration is retired");
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

	it("flat provider keys (dashboard) take priority over nested", () => {
		const result = loadPipelineConfig({
			memory: {
				pipelineV2: {
					extractionProvider: "ollama",
					extractionModel: "qwen3:4b",
					extraction: {
						provider: "codex",
						model: "gpt-5.3-codex",
					},
				},
			},
		});

		// Flat keys win as a pair — dashboard writes flat, so they must take priority
		expect(result.extraction.provider).toBe("ollama");
		expect(result.extraction.model).toBe("qwen3:4b");
	});

	it("parses extraction endpoint aliases", () => {
		const result = loadPipelineConfig({
			memory: {
				pipelineV2: {
					extraction: {
						provider: "ollama",
						model: "qwen3:1.7b",
						endpoint: "http://172.17.0.1:11434",
					},
				},
			},
		});
		expect(result.extraction.endpoint).toBe("http://172.17.0.1:11434");
	});

	it("parses synthesis base_url as endpoint alias", () => {
		const result = loadPipelineConfig({
			memory: {
				pipelineV2: {
					synthesis: {
						provider: "ollama",
						model: "qwen3:4b",
						base_url: "http://172.17.0.1:11434",
					},
				},
			},
		});
		expect(result.synthesis.endpoint).toBe("http://172.17.0.1:11434");
	});

	it("defaults reflections to 6am in the detected local timezone with 3 briefs", () => {
		const result = loadPipelineConfig({});
		expect(result.reflections.schedule).toBe("0 6 * * *");
		expect(result.reflections.count).toBe(3);
		expect(result.reflections.timezone).toBe(detectLocalTimeZone());
	});

	it("honors the reflections count and timezone and bounds invalid values", () => {
		const clamped = loadPipelineConfig({
			memory: {
				pipelineV2: {
					reflections: {
						count: 9,
						timezone: "Not/AZone",
						schedule: "0 9 * * *",
					},
				},
			},
		});
		expect(clamped.reflections.count).toBe(6); // clamped to the route cap
		expect(clamped.reflections.timezone).toBe(detectLocalTimeZone()); // invalid IANA falls back
		expect(clamped.reflections.schedule).toBe("0 9 * * *");

		const valid = loadPipelineConfig({
			memory: { pipelineV2: { reflections: { timezone: "Europe/Berlin", count: 2 } } },
		});
		expect(valid.reflections.timezone).toBe("Europe/Berlin");
		expect(valid.reflections.count).toBe(2);
	});

	it("accepts openrouter synthesis provider", () => {
		const result = loadPipelineConfig({
			memory: {
				pipelineV2: {
					synthesis: {
						provider: "openrouter",
						model: "openai/gpt-4o-mini",
					},
				},
			},
		});
		expect(result.synthesis.provider).toBe("openrouter");
		expect(result.synthesis.model).toBe("openai/gpt-4o-mini");
	});

	it("accepts openai-compatible synthesis provider", () => {
		const result = loadPipelineConfig({
			memory: {
				pipelineV2: {
					synthesis: {
						provider: "openai-compatible",
						model: "gpt-4o-mini",
						endpoint: "https://gateway.example.test/v1",
					},
				},
			},
		});
		expect(result.synthesis.provider).toBe("openai-compatible");
		expect(result.synthesis.model).toBe("gpt-4o-mini");
		expect(result.synthesis.endpoint).toBe("https://gateway.example.test/v1");
	});

	it("accepts codex synthesis provider", () => {
		const result = loadPipelineConfig({
			memory: {
				pipelineV2: {
					synthesis: {
						provider: "codex",
						model: "gpt-5.4-mini",
					},
				},
			},
		});
		expect(result.synthesis.provider).toBe("codex");
		expect(result.synthesis.model).toBe("gpt-5.4-mini");
	});

	it("flat provider without flat model uses provider default", () => {
		const result = loadPipelineConfig({
			memory: {
				pipelineV2: {
					extractionProvider: "codex",
					extraction: {
						provider: "ollama",
						model: "qwen3:8b",
					},
				},
			},
		});

		// Flat provider wins — model must NOT bleed from nested config
		expect(result.extraction.provider).toBe("codex");
		expect(result.extraction.model).toBe("gpt-5.4-mini");
	});

	it("defaults missing synthesis to the resolved extraction provider and model", () => {
		const result = loadPipelineConfig({
			memory: {
				pipelineV2: {
					extractionProvider: "ollama",
					extractionModel: "qwen3:4b",
					extractionEndpoint: "http://127.0.0.1:11434",
				},
			},
		});

		expect(result.synthesis.provider).toBe("ollama");
		expect(result.synthesis.model).toBe("qwen3:4b");
		expect(result.synthesis.endpoint).toBe("http://127.0.0.1:11434");
		expect(result.synthesis.timeout).toBe(result.extraction.timeout);
	});

	it("disables inherited synthesis when extraction resolves to none", () => {
		const result = loadPipelineConfig({
			memory: {
				pipelineV2: {
					extractionProvider: "none",
				},
			},
		});

		expect(result.synthesis.provider).toBe("none");
		expect(result.synthesis.enabled).toBe(false);
	});

	it("disables explicit synthesis when provider is none", () => {
		const result = loadPipelineConfig({
			memory: {
				pipelineV2: {
					synthesis: {
						enabled: true,
						provider: "none",
					},
				},
			},
		});

		expect(result.synthesis.provider).toBe("none");
		expect(result.synthesis.enabled).toBe(false);
	});

	it("keeps inheriting extraction values when synthesis only sets enabled", () => {
		const result = loadPipelineConfig({
			memory: {
				pipelineV2: {
					extractionProvider: "ollama",
					extractionModel: "qwen3:4b",
					extractionEndpoint: "http://127.0.0.1:11434",
					extractionTimeout: 75000,
					synthesis: {
						enabled: true,
					},
				},
			},
		});

		expect(result.synthesis.provider).toBe("ollama");
		expect(result.synthesis.model).toBe("qwen3:4b");
		expect(result.synthesis.endpoint).toBe("http://127.0.0.1:11434");
		expect(result.synthesis.timeout).toBe(75000);
	});

	it("keeps inherited synthesis provider overrides field-specific", () => {
		const result = loadPipelineConfig({
			memory: {
				pipelineV2: {
					extractionProvider: "ollama",
					extractionModel: "qwen3:4b",
					extractionEndpoint: "http://127.0.0.1:11434",
					synthesis: {
						model: "qwen3:8b",
					},
				},
			},
		});

		expect(result.synthesis.provider).toBe("ollama");
		expect(result.synthesis.model).toBe("qwen3:8b");
		expect(result.synthesis.endpoint).toBe("http://127.0.0.1:11434");
		expect(result.synthesis.timeout).toBe(result.extraction.timeout);
	});

	it("keeps explicit synthesis separate from extraction", () => {
		const result = loadPipelineConfig({
			memory: {
				pipelineV2: {
					extractionProvider: "ollama",
					extractionModel: "qwen3:4b",
					synthesis: {
						provider: "claude-code",
						model: "haiku",
						timeout: 180000,
					},
				},
			},
		});

		expect(result.extraction.provider).toBe("ollama");
		expect(result.extraction.model).toBe("qwen3:4b");
		expect(result.synthesis.provider).toBe("claude-code");
		expect(result.synthesis.model).toBe("haiku");
		expect(result.synthesis.timeout).toBe(180000);
	});

	it("loads explicit Claude Code API key env inheritance and budget controls", () => {
		const result = loadPipelineConfig({
			memory: {
				pipelineV2: {
					claudeCode: {
						allowApiKeyEnv: true,
						maxBudgetUsd: 0.5,
						cooldownMs: 120000,
					},
				},
			},
		});

		expect(result.claudeCode.allowApiKeyEnv).toBe(true);
		expect(result.claudeCode.maxBudgetUsd).toBe(0.5);
		expect(result.claudeCode.cooldownMs).toBe(120000);
	});

	it("maps legacy Claude Code billingMode to API key env inheritance", () => {
		const result = loadPipelineConfig({
			memory: {
				pipelineV2: {
					claudeCode: {
						billingMode: "api-key",
					},
				},
			},
		});

		expect(result.claudeCode.allowApiKeyEnv).toBe(true);
	});

	it("defaults Claude Code background calls to strip ambient Anthropic env without a spend cap", () => {
		const result = loadPipelineConfig({});

		expect(result.claudeCode.allowApiKeyEnv).toBe(false);
		expect(result.claudeCode.maxBudgetUsd).toBeUndefined();
		expect(result.claudeCode.cooldownMs).toBeGreaterThan(0);
	});

	it("flat model without flat provider is honoured (not silently discarded)", () => {
		const result = loadPipelineConfig({
			memory: {
				pipelineV2: {
					extractionModel: "qwen3:8b",
				},
			},
		});

		// No provider set → defaults to "llama-cpp"; flat model must propagate
		expect(result.extraction.provider).toBe("llama-cpp");
		expect(result.extraction.model).toBe("qwen3:8b");
	});

	it("preserves the extraction model label for a provider family outside the legacy vocab (#1017)", () => {
		// The dashboard writes the routing target (inference.targets.background)
		// and mirrors only the model into the legacy label when the executor is a
		// provider family (e.g. minimax) the narrower pipeline vocab can't express.
		// The model — the only field logs/telemetry/DB read — must propagate.
		const result = loadPipelineConfig({
			memory: {
				pipelineV2: {
					extractionModel: "MiniMax-M2.7",
				},
			},
		});
		expect(result.extraction.model).toBe("MiniMax-M2.7");
	});

	it("nested provider used when no flat key is set", () => {
		const result = loadPipelineConfig({
			memory: {
				pipelineV2: {
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
					workerMaxRetries: -5,
					extractionTimeout: 999999,
					leaseTimeoutMs: 1,
					minFactConfidenceForWrite: 3,
				},
			},
		});

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
					workerMaxRetries: null,
					extractionTimeout: undefined,
					leaseTimeoutMs: true,
					minFactConfidenceForWrite: "high",
				},
			},
		});

		expect(result.worker.maxRetries).toBe(DEFAULT_PIPELINE_V2.worker.maxRetries);
		expect(result.extraction.timeout).toBe(DEFAULT_PIPELINE_V2.extraction.timeout);
		expect(result.worker.leaseTimeoutMs).toBe(DEFAULT_PIPELINE_V2.worker.leaseTimeoutMs);
		expect(result.extraction.minConfidence).toBe(DEFAULT_PIPELINE_V2.extraction.minConfidence);
	});

	it("accepts valid numeric values within range (flat keys)", () => {
		const result = loadPipelineConfig({
			memory: {
				pipelineV2: {
					workerMaxRetries: 5,
					extractionTimeout: 60000,
					leaseTimeoutMs: 120000,
					minFactConfidenceForWrite: 0.55,
				},
			},
		});

		expect(result.worker.maxRetries).toBe(5);
		expect(result.extraction.timeout).toBe(60000);
		expect(result.worker.leaseTimeoutMs).toBe(120000);
		expect(result.extraction.minConfidence).toBe(0.55);
	});

	it("treats empty rateLimit objects as unconfigured", () => {
		const result = loadPipelineConfig({
			memory: {
				pipelineV2: {
					extraction: { rateLimit: {} },
					synthesis: { rateLimit: {} },
				},
			},
		});

		expect(result.extraction.rateLimit).toBeUndefined();
		expect(result.synthesis.rateLimit).toBeUndefined();
	});

	it("preserves explicit maxCallsPerHour disable in rateLimit config", () => {
		const result = loadPipelineConfig({
			memory: {
				pipelineV2: {
					extraction: {
						rateLimit: {
							maxCallsPerHour: 0,
						},
					},
				},
			},
		});

		expect(result.extraction.rateLimit).toEqual({
			maxCallsPerHour: 0,
			burstSize: 20,
			waitTimeoutMs: 5000,
		});
	});

	it("clamps burstSize to 1 in parsed rateLimit config", () => {
		const result = loadPipelineConfig({
			memory: {
				pipelineV2: {
					extraction: {
						rateLimit: {
							maxCallsPerHour: 100,
							burstSize: 0,
						},
					},
				},
			},
		});

		expect(result.extraction.rateLimit).toEqual({
			maxCallsPerHour: 100,
			burstSize: 1,
			waitTimeoutMs: 5000,
		});
	});

	it("rejects retired write-gate and durability configuration", () => {
		for (const pipelineV2 of [
			{ writeGate: { threshold: 0.45 } },
			{ durability: { enabled: true } },
			{ writeGateEnabled: true },
		]) {
			expect(() => loadPipelineConfig({ memory: { pipelineV2 } })).toThrow(
				"writeGate and durability configuration is retired",
			);
		}
	});

	it("rejects retired procedural enrichment configuration", () => {
		for (const procedural of [{ enrichOnInstall: true }, { enrichMinDescription: 30 }]) {
			expect(() => loadPipelineConfig({ memory: { pipelineV2: { procedural } } })).toThrow(
				"procedural enrichment configuration is retired",
			);
		}
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
		expect(result.reranker.useExtractionModel).toBe(false);
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
		expect(result.reranker.useExtractionModel).toBe(DEFAULT_PIPELINE_V2.reranker.useExtractionModel);
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

	it("retired extraction-worker config fields are absent from the resolved config (#946)", () => {
		const result = loadPipelineConfig({
			memory: {
				pipelineV2: {
					worker: {
						pollMs: 5000,
						maxLoadPerCpu: 0.6,
						overloadBackoffMs: 45000,
						threadedExtraction: false,
					},
					extraction: {
						escalation: {
							maxNewEntitiesPerChunk: 7,
							maxNewAttributesPerEntity: 9,
							level2MaxEntities: 3,
						},
					},
				},
			},
		});

		// The standalone extraction worker was retired under the Dreaming cutover;
		// its poll/load/thread/escalation knobs must not survive into the resolved
		// config as inert compatibility settings.
		expect(result.worker).not.toHaveProperty("pollMs");
		expect(result.worker).not.toHaveProperty("maxLoadPerCpu");
		expect(result.worker).not.toHaveProperty("overloadBackoffMs");
		expect(result.worker).not.toHaveProperty("threadedExtraction");
		expect(result.extraction).not.toHaveProperty("escalation");
		// Retained worker knobs stay present.
		expect(result.worker.maxRetries).toBe(DEFAULT_PIPELINE_V2.worker.maxRetries);
		expect(result.worker.leaseTimeoutMs).toBe(DEFAULT_PIPELINE_V2.worker.leaseTimeoutMs);
		expect(result.worker.maxLlmConcurrency).toBe(DEFAULT_PIPELINE_V2.worker.maxLlmConcurrency);
	});

	it("loads canonical worker maxLlmConcurrency with bounded defaults and env override", () => {
		const previous = process.env.SIGNET_MAX_LLM_CONCURRENCY;
		try {
			process.env.SIGNET_MAX_LLM_CONCURRENCY = undefined;
			expect(loadPipelineConfig({ memory: { pipelineV2: { enabled: true } } }).worker.maxLlmConcurrency).toBe(2);
			expect(
				loadPipelineConfig({ memory: { pipelineV2: { enabled: true, worker: { maxLlmConcurrency: 0 } } } }).worker
					.maxLlmConcurrency,
			).toBe(1);
			expect(
				loadPipelineConfig({ memory: { pipelineV2: { enabled: true, worker: { maxLlmConcurrency: 99 } } } }).worker
					.maxLlmConcurrency,
			).toBe(16);
			process.env.SIGNET_MAX_LLM_CONCURRENCY = "7";
			expect(
				loadPipelineConfig({ memory: { pipelineV2: { enabled: true, worker: { maxLlmConcurrency: 3 } } } }).worker
					.maxLlmConcurrency,
			).toBe(7);
		} finally {
			if (previous === undefined) process.env.SIGNET_MAX_LLM_CONCURRENCY = undefined;
			else process.env.SIGNET_MAX_LLM_CONCURRENCY = previous;
		}
	});

	// #946: threadedExtraction was a standalone-extraction-worker knob and is
	// retired along with the worker. The parser must ignore legacy YAML values.
	it("ignores retired threadedExtraction config", () => {
		const result = loadPipelineConfig({
			memory: {
				pipelineV2: {
					enabled: true,
					worker: { threadedExtraction: false },
				},
			},
		});

		expect(result.worker).not.toHaveProperty("threadedExtraction");
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

	it("defaults paused to false when absent", () => {
		const result = loadPipelineConfig({
			memory: { pipelineV2: { enabled: true } },
		});

		expect(result.paused).toBe(false);
	});

	it("loads explicit paused state", () => {
		const result = loadPipelineConfig({
			memory: {
				pipelineV2: {
					enabled: true,
					paused: true,
				},
			},
		});

		expect(result.enabled).toBe(true);
		expect(result.paused).toBe(true);
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
					reranker: { enabled: true, model: "my-reranker", useExtractionModel: true, topN: 10 },
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
		expect(result.reranker.useExtractionModel).toBe(true);
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
					rerankerUseExtractionModel: false,
					// Nested key (wins)
					reranker: {
						enabled: true,
						model: "nested-model",
						useExtractionModel: true,
					},
				},
			},
		});

		expect(result.reranker.enabled).toBe(true);
		expect(result.reranker.model).toBe("nested-model");
		expect(result.reranker.useExtractionModel).toBe(true);
	});
});

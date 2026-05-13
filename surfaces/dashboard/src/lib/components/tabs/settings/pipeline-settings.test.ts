// @ts-nocheck
import { describe, expect, it } from "bun:test";
import { DEFAULT_PIPELINE_TIMEOUT_MS } from "@signet/core/pipeline-providers";
import {
	hasExplicitSynthesisConfig,
	hasExplicitSynthesisProvider,
	resolveSynthesisEnabled,
	resolveSynthesisEndpoint,
	resolveSynthesisModel,
	resolveSynthesisProvider,
	resolveSynthesisTimeout,
} from "./pipeline-settings";

describe("pipeline-settings synthesis resolution", () => {
	it("falls back to extraction values when synthesis is absent", () => {
		const agent = {
			memory: {
				pipelineV2: {
					extractionProvider: "ollama",
					extractionModel: "qwen3:4b",
					extractionEndpoint: "http://127.0.0.1:11434",
					extractionTimeout: 75000,
				},
			},
		};

		expect(hasExplicitSynthesisConfig(agent)).toBe(false);
		expect(resolveSynthesisProvider(agent)).toBe("ollama");
		expect(resolveSynthesisModel(agent)).toBe("qwen3:4b");
		expect(resolveSynthesisEndpoint(agent)).toBe("http://127.0.0.1:11434");
		expect(resolveSynthesisTimeout(agent)).toBe(75000);
		expect(resolveSynthesisEnabled(agent)).toBe(true);
	});

	it("keeps inheriting extraction values when synthesis only sets enabled", () => {
		const agent = {
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
		};

		expect(hasExplicitSynthesisConfig(agent)).toBe(true);
		expect(hasExplicitSynthesisProvider(agent)).toBe(false);
		expect(resolveSynthesisProvider(agent)).toBe("ollama");
		expect(resolveSynthesisModel(agent)).toBe("qwen3:4b");
		expect(resolveSynthesisEndpoint(agent)).toBe("http://127.0.0.1:11434");
		expect(resolveSynthesisTimeout(agent)).toBe(75000);
		expect(resolveSynthesisEnabled(agent)).toBe(true);
	});

	it("keeps explicit synthesis separate from extraction", () => {
		const agent = {
			memory: {
				pipelineV2: {
					extractionProvider: "ollama",
					extractionModel: "qwen3:4b",
					synthesis: {
						provider: "claude-code",
						model: "haiku",
						endpoint: "http://127.0.0.1:9999",
						timeout: 180000,
					},
				},
			},
		};

		expect(hasExplicitSynthesisConfig(agent)).toBe(true);
		expect(hasExplicitSynthesisProvider(agent)).toBe(true);
		expect(resolveSynthesisProvider(agent)).toBe("claude-code");
		expect(resolveSynthesisModel(agent)).toBe("haiku");
		expect(resolveSynthesisEndpoint(agent)).toBe("http://127.0.0.1:9999");
		expect(resolveSynthesisTimeout(agent)).toBe(180000);
		expect(resolveSynthesisEnabled(agent)).toBe(true);
	});

	it("uses provider defaults for explicit synthesis blocks without a model", () => {
		const agent = {
			memory: {
				pipelineV2: {
					synthesis: {
						provider: "codex",
					},
				},
			},
		};

		expect(hasExplicitSynthesisProvider(agent)).toBe(true);
		expect(resolveSynthesisProvider(agent)).toBe("codex");
		expect(resolveSynthesisModel(agent)).toBe("gpt-5.4-mini");
		expect(resolveSynthesisEnabled(agent)).toBe(true);
	});

	it("uses the shared pipeline timeout default when synthesis and extraction timeouts are both implicit", () => {
		const agent = {
			memory: {
				pipelineV2: {},
			},
		};

		expect(resolveSynthesisTimeout(agent)).toBe(DEFAULT_PIPELINE_TIMEOUT_MS);
	});

	it("shows inherited synthesis as disabled when extraction resolves to none", () => {
		const agent = {
			memory: {
				pipelineV2: {
					extractionProvider: "none",
				},
			},
		};

		expect(resolveSynthesisProvider(agent)).toBe("none");
		expect(resolveSynthesisEnabled(agent)).toBe(false);
	});
});

// @ts-nocheck
import { describe, expect, it } from "bun:test";
import { DEFAULT_PIPELINE_TIMEOUT_MS } from "@signet/core/pipeline-providers";
import {
	DEFAULT_OPENAI_COMPATIBLE_ENDPOINT,
	applyRecommendedPipelineSetup,
	defaultAcpxDashboardAgent,
	hasExplicitSynthesisConfig,
	hasExplicitSynthesisProvider,
	resolveExtractionEndpoint,
	resolveSynthesisEnabled,
	resolveSynthesisEndpoint,
	resolveSynthesisModel,
	resolveSynthesisProvider,
	resolveSynthesisTimeout,
} from "./pipeline-settings";

describe("pipeline-settings synthesis resolution", () => {
	it("resolves extraction endpoints for OpenAI-compatible dashboard setup", () => {
		expect(
			resolveExtractionEndpoint({
				memory: {
					pipelineV2: {
						extractionProvider: "openai-compatible",
					},
				},
			}),
		).toBe(DEFAULT_OPENAI_COMPATIBLE_ENDPOINT);
		expect(
			resolveExtractionEndpoint({
				memory: {
					pipelineV2: {
						extractionProvider: "openai-compatible",
						extractionEndpoint: "https://gateway.example.test/v1",
					},
				},
			}),
		).toBe("https://gateway.example.test/v1");
	});

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
						model: "gpt-5-codex-mini",
						endpoint: "http://127.0.0.1:9999",
						timeout: 180000,
					},
				},
			},
		};

		expect(hasExplicitSynthesisConfig(agent)).toBe(true);
		expect(hasExplicitSynthesisProvider(agent)).toBe(true);
		expect(resolveSynthesisProvider(agent)).toBe("claude-code");
		expect(resolveSynthesisModel(agent)).toBe("gpt-5-codex-mini");
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

describe("pipeline-settings ACPX dashboard setup", () => {
	it("detects the preferred ACPX agent from generated inference config before harnesses", () => {
		const agent = {
			harnesses: ["claude-code"],
			inference: {
				targets: {
					"background-acpx": {
						acpx: { agent: "opencode" },
					},
				},
			},
		};

		expect(defaultAcpxDashboardAgent(agent)).toBe("opencode");
	});

	it("maps ACPX's Claude command back to the Claude Code dashboard option", () => {
		const agent = {
			harnesses: ["codex"],
			inference: {
				targets: {
					"background-acpx": {
						acpx: { agent: "claude" },
					},
				},
			},
		};

		expect(defaultAcpxDashboardAgent(agent)).toBe("claude-code");
	});

	it("applies a one-click ACPX background setup for extraction, synthesis, and routing", () => {
		const agent: Record<string, unknown> = {
			inference: {
				defaultPolicy: "custom-local",
				targets: {
					"custom-local": { executor: "ollama" },
				},
			},
		};

		applyRecommendedPipelineSetup(agent, { provider: "acpx", model: "gpt-5-codex-mini" });

		expect(agent.memory).toMatchObject({
			pipelineV2: {
				enabled: true,
				extractionProvider: "acpx",
				extractionModel: "gpt-5-codex-mini",
				graphEnabled: true,
				rerankerEnabled: true,
				semanticContradictionEnabled: true,
				synthesis: {
					enabled: true,
					provider: "acpx",
					model: "gpt-5-codex-mini",
					timeout: 120000,
				},
			},
		});
		expect((agent.memory as { pipelineV2: Record<string, unknown> }).pipelineV2).not.toHaveProperty(
			"autonomousEnabled",
		);
		expect((agent.memory as { pipelineV2: Record<string, unknown> }).pipelineV2).not.toHaveProperty(
			"allowUpdateDelete",
		);
		expect((agent.memory as { pipelineV2: Record<string, unknown> }).pipelineV2).not.toHaveProperty("maintenanceMode");
		expect(agent.inference).toEqual({
			defaultPolicy: "custom-local",
			targets: {
				"custom-local": { executor: "ollama" },
				"background-acpx": {
					executor: "acpx",
					acpx: {
						agent: "codex",
						package: "acpx@0.7.0",
						version: "0.7.0",
						mode: "exec",
						terminal: "inherit",
						permissions: "deny-all",
						hooks: "disabled",
					},
					models: {
						default: {
							model: "gpt-5-codex-mini",
							reasoning: "medium",
							toolUse: true,
							costTier: "medium",
						},
					},
				},
			},
			policies: {
				"background-acpx": {
					mode: "automatic",
					defaultTargets: ["background-acpx/default"],
					fallbackTargets: ["background-acpx/default"],
				},
			},
			taskClasses: {
				memory_extraction: { reasoning: "medium", toolsRequired: true, privacy: "restricted_remote" },
				session_synthesis: { reasoning: "medium", toolsRequired: true, privacy: "restricted_remote" },
			},
			workloads: {
				memoryExtraction: { target: "background-acpx/default", taskClass: "memory_extraction" },
				sessionSynthesis: { target: "background-acpx/default", taskClass: "session_synthesis" },
			},
		});
	});

	it("applies onboarding endpoint without writing stale ACPX routing for non-ACPX providers", () => {
		const localAgent: Record<string, unknown> = {
			inference: {
				defaultPolicy: "background-acpx",
				targets: { "background-acpx": { executor: "acpx" }, "custom-local": { executor: "ollama" } },
				policies: { "background-acpx": { mode: "automatic" } },
				taskClasses: {
					memory_extraction: { reasoning: "medium", toolsRequired: true, privacy: "restricted_remote" },
					session_synthesis: { reasoning: "medium", toolsRequired: true, privacy: "restricted_remote" },
				},
				workloads: {
					memoryExtraction: { target: "background-acpx/default", taskClass: "memory_extraction" },
					sessionSynthesis: { target: "custom-local/default", taskClass: "session_synthesis" },
				},
			},
		};
		applyRecommendedPipelineSetup(localAgent, {
			provider: "llama-cpp",
			model: "qwen3.5:4b",
			endpoint: "http://127.0.0.1:8080/v1",
		});
		expect(localAgent.memory).toMatchObject({
			pipelineV2: {
				extractionProvider: "llama-cpp",
				extractionModel: "qwen3.5:4b",
				extractionEndpoint: "http://127.0.0.1:8080/v1",
				extractionBaseUrl: "http://127.0.0.1:8080/v1",
				extraction: {
					provider: "llama-cpp",
					model: "qwen3.5:4b",
					endpoint: "http://127.0.0.1:8080/v1",
				},
				synthesis: {
					provider: "llama-cpp",
					model: "qwen3.5:4b",
					endpoint: "http://127.0.0.1:8080/v1",
				},
			},
		});
		expect(localAgent.inference).toMatchObject({
			targets: { "custom-local": { executor: "ollama" } },
			workloads: { sessionSynthesis: { target: "custom-local/default", taskClass: "session_synthesis" } },
		});
		expect((localAgent.inference as { defaultPolicy?: string }).defaultPolicy).toBeUndefined();
		expect((localAgent.inference as { targets: Record<string, unknown> }).targets["background-acpx"]).toBeUndefined();
		expect((localAgent.inference as { policies?: Record<string, unknown> }).policies).toBeUndefined();
		expect((localAgent.inference as { taskClasses: Record<string, unknown> }).taskClasses).toEqual({
			session_synthesis: { reasoning: "medium", toolsRequired: true, privacy: "restricted_remote" },
		});
		expect((localAgent.inference as { workloads: Record<string, unknown> }).workloads.memoryExtraction).toBeUndefined();

		const generatedOnlyAgent: Record<string, unknown> = {
			inference: {
				defaultPolicy: "background-acpx",
				targets: { "background-acpx": { executor: "acpx" } },
				policies: { "background-acpx": { mode: "automatic" } },
				taskClasses: {
					memory_extraction: { reasoning: "medium", toolsRequired: true, privacy: "restricted_remote" },
					session_synthesis: { reasoning: "medium", toolsRequired: true, privacy: "restricted_remote" },
				},
				workloads: {
					memoryExtraction: { target: "background-acpx/default", taskClass: "memory_extraction" },
					sessionSynthesis: { target: "background-acpx/default", taskClass: "session_synthesis" },
				},
			},
		};
		applyRecommendedPipelineSetup(generatedOnlyAgent, { provider: "ollama", model: "qwen3:4b" });
		expect(generatedOnlyAgent.inference).toBeUndefined();

		const acpxAgent: Record<string, unknown> = {};
		applyRecommendedPipelineSetup(acpxAgent, {
			provider: "acpx",
			model: "gpt-5-codex-mini",
			acpxHarness: "codex",
		});
		expect(acpxAgent.memory).toMatchObject({
			pipelineV2: {
				extraction: {
					provider: "acpx",
					model: "gpt-5-codex-mini",
					harness: "codex",
				},
			},
		});
	});
});

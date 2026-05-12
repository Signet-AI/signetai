// @ts-nocheck
import { describe, expect, it } from "bun:test";
import { DEFAULT_PIPELINE_TIMEOUT_MS } from "@signet/core/pipeline-providers";
import {
	applyAcpxDashboardSetup,
	defaultAcpxDashboardAgent,
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
					extractionModel: "qwen3.5:4b",
					extractionEndpoint: "http://127.0.0.1:11434",
					extractionTimeout: 75000,
				},
			},
		};

		expect(hasExplicitSynthesisConfig(agent)).toBe(false);
		expect(resolveSynthesisProvider(agent)).toBe("ollama");
		expect(resolveSynthesisModel(agent)).toBe("qwen3.5:4b");
		expect(resolveSynthesisEndpoint(agent)).toBe("http://127.0.0.1:11434");
		expect(resolveSynthesisTimeout(agent)).toBe(75000);
		expect(resolveSynthesisEnabled(agent)).toBe(true);
	});

	it("keeps inheriting extraction values when synthesis only sets enabled", () => {
		const agent = {
			memory: {
				pipelineV2: {
					extractionProvider: "ollama",
					extractionModel: "qwen3.5:4b",
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
		expect(resolveSynthesisModel(agent)).toBe("qwen3.5:4b");
		expect(resolveSynthesisEndpoint(agent)).toBe("http://127.0.0.1:11434");
		expect(resolveSynthesisTimeout(agent)).toBe(75000);
		expect(resolveSynthesisEnabled(agent)).toBe(true);
	});

	it("keeps explicit synthesis separate from extraction", () => {
		const agent = {
			memory: {
				pipelineV2: {
					extractionProvider: "ollama",
					extractionModel: "qwen3.5:4b",
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
		expect(resolveSynthesisModel(agent)).toBe("gpt-5-codex-mini");
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
			harnesses: ["claude-code"],
			inference: {
				defaultPolicy: "custom-local",
				targets: {
					"custom-local": { executor: "ollama" },
				},
			},
		};

		applyAcpxDashboardSetup(agent, { agent: "claude-code" });

		expect(agent.memory).toMatchObject({
			pipelineV2: {
				enabled: true,
				extractionProvider: "acpx",
				extractionModel: "claude-haiku-4-5",
				synthesis: {
					enabled: true,
					provider: "acpx",
					model: "claude-haiku-4-5",
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
		expect(agent.inference).toMatchObject({
			defaultPolicy: "custom-local",
			targets: {
				"custom-local": { executor: "ollama" },
				"background-acpx": {
					executor: "acpx",
					acpx: {
						agent: "claude",
						package: "acpx@0.7.0",
						permissions: "deny-all",
						hooks: "disabled",
					},
					models: {
						default: {
							model: "claude-haiku-4-5",
						},
					},
				},
			},
			policies: {
				"background-acpx": {
					mode: "automatic",
					defaultTargets: ["background-acpx/default"],
				},
			},
			workloads: {
				memoryExtraction: { target: "background-acpx/default", taskClass: "memory_extraction" },
				sessionSynthesis: { target: "background-acpx/default", taskClass: "session_synthesis" },
			},
		});
	});
});

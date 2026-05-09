import { describe, expect, it } from "bun:test";
import {
	applySetupInferenceRoute,
	buildSetupInference,
	buildSetupPipeline,
	defaultExtractionModel,
} from "./setup-pipeline";

describe("defaultExtractionModel", () => {
	it("prefers the cheap codex mini model", () => {
		expect(defaultExtractionModel("codex")).toBe("gpt-5-codex-mini");
	});

	it("uses qwen3:4b as the ollama floor", () => {
		expect(defaultExtractionModel("ollama")).toBe("qwen3:4b");
	});
});

describe("buildSetupPipeline", () => {
	it("writes an explicit disabled pipeline when extraction is turned off", () => {
		expect(buildSetupPipeline("none")).toEqual({
			enabled: false,
			extraction: {
				provider: "none",
				model: "",
			},
			synthesis: {
				enabled: false,
				provider: "none",
				model: "",
				timeout: 120000,
			},
		});
	});

	it("fills in safe defaults for enabled providers", () => {
		expect(buildSetupPipeline("claude-code")).toEqual({
			enabled: true,
			extraction: {
				provider: "claude-code",
				model: "haiku",
			},
			synthesis: {
				enabled: true,
				provider: "claude-code",
				model: "haiku",
				timeout: 120000,
			},
			semanticContradictionEnabled: true,
			graph: { enabled: true },
			reranker: { enabled: true },
			autonomous: {
				enabled: true,
				allowUpdateDelete: true,
				maintenanceMode: "execute",
			},
		});
	});

	it("copies the selected extraction provider into explicit synthesis config", () => {
		expect(buildSetupPipeline("ollama", "qwen3.5:4b").synthesis).toEqual({
			enabled: true,
			provider: "ollama",
			model: "qwen3.5:4b",
			timeout: 120000,
		});
	});
});

describe("buildSetupInference", () => {
	it("writes ACPX as explicit inference routing with the selected harness agent", () => {
		const inference = buildSetupInference("acpx", "gpt-5-codex-mini", ["opencode", "codex"], [], "/usr/local/bin/bunx");
		expect(inference?.targets["background-acpx"]).toMatchObject({
			executor: "acpx",
			acpx: {
				agent: "opencode",
				package: "acpx@0.7.0",
				version: "0.7.0",
				hooks: "disabled",
				permissions: "deny-all",
				terminal: "inherit",
			},
		});
		expect(inference?.workloads.memoryExtraction).toEqual({
			target: "background-acpx/default",
			taskClass: "memory_extraction",
		});
	});

	it("maps Claude Code harness/provider selection to ACPX's claude connector", () => {
		const fromHarness = buildSetupInference("acpx", "haiku", ["claude-code"], ["acpx"], "/usr/local/bin/bunx");
		expect(fromHarness?.targets["background-acpx"]).toMatchObject({
			executor: "acpx",
			acpx: { agent: "claude" },
		});

		const fromDetectedProvider = buildSetupInference(
			"acpx",
			"haiku",
			[],
			["acpx", "claude-code"],
			"/usr/local/bin/bunx",
		);
		expect(fromDetectedProvider?.targets["background-acpx"]).toMatchObject({
			executor: "acpx",
			acpx: { agent: "claude" },
		});
	});
	it("does not emit ACPX routing without a resolved launcher", () => {
		expect(buildSetupInference("acpx", "haiku", ["codex"], ["acpx"])).toBeUndefined();
	});

	it("removes generated ACPX routing when setup switches to another provider", () => {
		const config: Record<string, unknown> = {
			inference: buildSetupInference("acpx", "haiku", ["codex"], ["acpx"], "/usr/local/bin/bunx"),
		};

		applySetupInferenceRoute(config, undefined);

		expect(config).not.toHaveProperty("inference");
	});

	it("preserves custom inference routing when removing generated ACPX setup routing", () => {
		const config: Record<string, unknown> = {
			inference: {
				defaultPolicy: "custom",
				targets: { custom: { executor: "local" } },
			},
		};

		applySetupInferenceRoute(config, undefined);

		expect(config.inference).toEqual({
			defaultPolicy: "custom",
			targets: { custom: { executor: "local" } },
		});
	});

	it("preserves custom inference task classes when removing generated ACPX setup routing", () => {
		const config: Record<string, unknown> = {
			inference: {
				...buildSetupInference("acpx", "haiku", ["codex"], ["acpx"], "/usr/local/bin/bunx"),
				taskClasses: {
					memory_extraction: { reasoning: "medium", toolsRequired: true, privacy: "restricted_remote" },
					session_synthesis: { reasoning: "medium", toolsRequired: true, privacy: "restricted_remote" },
					custom_review: { reasoning: "high", toolsRequired: true, privacy: "local" },
				},
			},
		};

		applySetupInferenceRoute(config, undefined);

		expect(config.inference).toEqual({
			taskClasses: {
				custom_review: { reasoning: "high", toolsRequired: true, privacy: "local" },
			},
		});
	});

	it("removes generated ACPX task classes from legacy target-only workloads", () => {
		const config: Record<string, unknown> = {
			inference: {
				...buildSetupInference("acpx", "haiku", ["codex"], ["acpx"], "/usr/local/bin/bunx"),
				workloads: {
					memoryExtraction: { target: "background-acpx/default" },
					sessionSynthesis: { target: "background-acpx/default" },
				},
				taskClasses: {
					memory_extraction: { reasoning: "medium", toolsRequired: true, privacy: "restricted_remote" },
					session_synthesis: { reasoning: "medium", toolsRequired: true, privacy: "restricted_remote" },
					custom_review: { reasoning: "high", toolsRequired: true, privacy: "local" },
				},
			},
		};

		applySetupInferenceRoute(config, undefined);

		expect(config.inference).toEqual({
			taskClasses: {
				custom_review: { reasoning: "high", toolsRequired: true, privacy: "local" },
			},
		});
	});
});

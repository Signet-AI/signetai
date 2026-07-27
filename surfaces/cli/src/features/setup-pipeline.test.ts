import { describe, expect, it } from "bun:test";
import {
	applyAggregateRecallRoute,
	applySetupInferenceRoute,
	buildSetupAggregateRecall,
	buildSetupInference,
	buildSetupPipeline,
	defaultAcpxModel,
	defaultExtractionModel,
} from "./setup-pipeline";

describe("defaultExtractionModel", () => {
	it("uses the checked Codex CLI model default", () => {
		expect(defaultExtractionModel("codex")).toBe("gpt-5.4-mini");
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
		expect(buildSetupPipeline("ollama", "qwen3:4b").synthesis).toEqual({
			enabled: true,
			provider: "ollama",
			model: "qwen3:4b",
			timeout: 120000,
		});
	});

	it("writes the selected endpoint into extraction and synthesis config", () => {
		expect(
			buildSetupPipeline("openai-compatible", "openai/gpt-oss-20b", "https://gateway.example.test/v1"),
		).toMatchObject({
			extraction: {
				provider: "openai-compatible",
				model: "openai/gpt-oss-20b",
				endpoint: "https://gateway.example.test/v1",
			},
			synthesis: {
				provider: "openai-compatible",
				model: "openai/gpt-oss-20b",
				endpoint: "https://gateway.example.test/v1",
			},
		});
	});

	it("does not invent a generic ACPX model when no harness agent is known", () => {
		expect(buildSetupPipeline("acpx").extraction.model).toBe("");
		expect(buildSetupPipeline("acpx").synthesis.model).toBe("");
	});
});

describe("buildSetupInference", () => {
	it("defaults ACPX models from the selected harness, not the ACPX provider bucket", () => {
		expect(defaultAcpxModel(["codex"], ["acpx"])).toBe("gpt-5.4-mini");
		expect(defaultAcpxModel(["opencode"], ["acpx"])).toBe("google/gemini-2.5-flash");
		expect(defaultAcpxModel(["claude-code"], ["acpx"])).toBe("haiku");

		expect(
			buildSetupInference("acpx", undefined, ["codex"], ["acpx"], "/usr/local/bin/bunx")?.targets["background-acpx"],
		).toMatchObject({
			acpx: { agent: "codex" },
			models: { default: { model: "gpt-5.4-mini" } },
		});
		expect(
			buildSetupInference("acpx", undefined, ["opencode"], ["acpx"], "/usr/local/bin/bunx")?.targets["background-acpx"],
		).toMatchObject({
			acpx: { agent: "opencode" },
			models: { default: { model: "google/gemini-2.5-flash" } },
		});
	});

	it("writes ACPX as explicit inference routing with the selected harness agent", () => {
		const inference = buildSetupInference(
			"acpx",
			"google/gemini-2.5-flash",
			["opencode", "codex"],
			[],
			"/usr/local/bin/bunx",
		);
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
				},
				taskClasses: {
					memory_extraction: { reasoning: "medium", toolsRequired: true, privacy: "restricted_remote" },
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

describe("buildSetupAggregateRecall", () => {
	it("binds a local ollama target to the aggregateRecall workload", () => {
		const ar = buildSetupAggregateRecall("ollama", "qwen3:4b");
		expect(ar.targets.aggregation).toMatchObject({
			executor: "ollama",
			models: { default: { model: "qwen3:4b", reasoning: "medium" } },
		});
		expect(ar.workloads.aggregateRecall).toEqual({
			target: "aggregation/default",
			taskClass: "aggregate_recall",
		});
	});

	it("defaults the model when none is given", () => {
		const ar = buildSetupAggregateRecall("openrouter");
		expect(
			(ar.targets.aggregation as { models: { default: { model: string } } }).models.default.model.length,
		).toBeGreaterThan(0);
	});

	it("requires an endpoint for openai-compatible and references an account for openrouter", () => {
		expect(buildSetupAggregateRecall("openai-compatible", "m", "http://gw:8000/v1").targets.aggregation).toMatchObject({
			executor: "openai-compatible",
			endpoint: "http://gw:8000/v1",
		});
		expect(buildSetupAggregateRecall("openrouter", "m").targets.aggregation).toMatchObject({
			executor: "openrouter",
			account: "openrouter",
		});
	});
});

describe("applyAggregateRecallRoute", () => {
	it("creates config.inference when absent", () => {
		const config: Record<string, unknown> = {};
		applyAggregateRecallRoute(config, buildSetupAggregateRecall("ollama", "qwen3:4b"));
		expect(
			(config.inference as { workloads: { aggregateRecall: { target: string } } }).workloads.aggregateRecall.target,
		).toBe("aggregation/default");
	});

	it("merges into an existing inference block without clobbering other targets", () => {
		const config: Record<string, unknown> = {
			inference: {
				targets: { "background-acpx": { executor: "acpx" } },
				workloads: { memoryExtraction: { target: "background-acpx/default" } },
			},
		};
		applyAggregateRecallRoute(config, buildSetupAggregateRecall("ollama", "qwen3:4b"));
		const inference = config.inference as {
			targets: Record<string, unknown>;
			workloads: Record<string, unknown>;
		};
		expect(inference.targets["background-acpx"]).toBeDefined();
		expect(inference.targets.aggregation).toBeDefined();
		expect(inference.workloads.memoryExtraction).toBeDefined();
		expect(inference.workloads.aggregateRecall).toBeDefined();
	});
});

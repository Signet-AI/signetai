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
	it("writes tuning-only config when extraction is turned off", () => {
		expect(buildSetupPipeline("none")).toEqual({
			enabled: false,
		});
	});

	it("does not emit provider/model routing fields", () => {
		const result = buildSetupPipeline("claude-code");
		expect(result.enabled).toBe(true);
		expect(result).not.toHaveProperty("extraction");
		expect(result).not.toHaveProperty("synthesis");
		expect(result).not.toHaveProperty("provider");
		expect(result).not.toHaveProperty("model");
	});

	it("writes local extraction providers to the canonical background workload", () => {
		const inference = buildSetupInference("ollama", "qwen3:4b");
		expect(inference).toMatchObject({
			defaultPolicy: "background",
			targets: { background: { executor: "ollama", models: { default: { model: "qwen3:4b" } } } },
			workloads: { memoryExtraction: { target: "background/default", taskClass: "memory_extraction" } },
		});
	});

	it("writes an OpenRouter account for remote extraction", () => {
		const inference = buildSetupInference("openrouter", "anthropic/claude-haiku");
		expect(inference?.targets.background).toMatchObject({ executor: "openrouter", account: "extraction" });
		expect(inference?.accounts?.extraction).toMatchObject({
			kind: "api",
			providerFamily: "openrouter",
			credentialRef: "OPENROUTER_API_KEY",
		});
	});

	it("preserves the configured endpoint for OpenAI-compatible extraction", () => {
		expect(
			buildSetupInference("openai-compatible", "local-model", [], [], undefined, "http://gw:8000/v1")?.targets
				.background,
		).toMatchObject({
			executor: "openai-compatible",
			endpoint: "http://gw:8000/v1",
		});
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

	it("removes generated direct routing when setup switches extraction off", () => {
		const config: Record<string, unknown> = {
			inference: buildSetupInference("ollama", "qwen3:4b"),
		};

		applySetupInferenceRoute(config, undefined);

		expect(config).not.toHaveProperty("inference");
	});

	it("preserves aggregate recall when removing generated direct routing", () => {
		const config: Record<string, unknown> = {
			inference: {
				...buildSetupInference("ollama", "qwen3:4b"),
				targets: {
					background: { executor: "ollama" },
					aggregation: { executor: "ollama" },
				},
				workloads: {
					memoryExtraction: { target: "background/default", taskClass: "memory_extraction" },
					aggregateRecall: { target: "aggregation/default" },
				},
			},
		};

		applySetupInferenceRoute(config, undefined);

		expect(config.inference).toMatchObject({
			targets: { aggregation: { executor: "ollama" } },
			workloads: { aggregateRecall: { target: "aggregation/default" } },
		});
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
		// No taskClass — the daemon validates taskClasses and 'aggregate_recall' is
		// not declared; mirror the dashboard writer (target only).
		expect(ar.workloads.aggregateRecall).toEqual({ target: "aggregation/default" });
		expect(ar.accounts).toBeUndefined();
	});

	it("requires an endpoint for openai-compatible and backs unconnected openrouter with a resolvable account", () => {
		expect(buildSetupAggregateRecall("openai-compatible", "m", "http://gw:8000/v1").targets.aggregation).toMatchObject({
			executor: "openai-compatible",
			endpoint: "http://gw:8000/v1",
		});
		const or = buildSetupAggregateRecall("openrouter", "m");
		expect(or.targets.aggregation).toMatchObject({ executor: "openrouter", account: "aggregation" });
		// The account must exist or the daemon hard-blocks the target as 'missing'.
		expect(or.accounts?.aggregation).toMatchObject({
			kind: "api",
			providerFamily: "openrouter",
			credentialRef: "OPENROUTER_API_KEY",
		});
	});

	it("reuses the interactive OpenRouter extraction account", () => {
		const or = buildSetupAggregateRecall("openrouter", "m", undefined, true);
		expect(or.targets.aggregation).toMatchObject({ executor: "openrouter", account: "openrouter" });
		expect(or.accounts).toBeUndefined();
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

	it("emits a default policy over all merged targets when none exist (#1072)", () => {
		// Regression for #1072: targets/accounts/workloads without a policy
		// dead-end every generation path in "No routing policy is configured.".
		const config: Record<string, unknown> = {};
		applyAggregateRecallRoute(config, buildSetupAggregateRecall("ollama", "qwen3:4b"));
		const inference = config.inference as {
			defaultPolicy: string;
			policies: Record<string, { mode: string; defaultTargets: string[]; fallbackTargets: string[] }>;
		};
		expect(inference.defaultPolicy).toBe("default");
		expect(inference.policies.default).toMatchObject({
			mode: "automatic",
			defaultTargets: ["aggregation/default"],
			fallbackTargets: ["aggregation/default"],
		});
	});

	it("does not clobber existing policies when merging the aggregate-recall route (#1072)", () => {
		const config: Record<string, unknown> = {
			inference: {
				defaultPolicy: "custom",
				policies: {
					custom: {
						mode: "automatic",
						defaultTargets: ["background-acpx/default"],
						fallbackTargets: ["background-acpx/default"],
					},
				},
				targets: { "background-acpx": { executor: "acpx" } },
			},
		};
		applyAggregateRecallRoute(config, buildSetupAggregateRecall("ollama", "qwen3:4b"));
		const inference = config.inference as { defaultPolicy: string; policies: Record<string, unknown> };
		expect(inference.defaultPolicy).toBe("custom");
		expect(Object.keys(inference.policies)).toEqual(["custom"]);
	});
});

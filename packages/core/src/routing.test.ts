import { describe, expect, it } from "bun:test";
import {
	compileLegacyRoutingConfig,
	makeRoutingTargetRef,
	parseRoutingConfig,
	resolveRoutingDecision,
} from "./routing";

const ready = {
	available: true,
	health: "healthy",
	circuitOpen: false,
	accountState: "ready",
} as const;

describe("inference config + decision engine", () => {
	it("prefers local targets for local_only task classes", () => {
		const parsed = parseRoutingConfig({
			inference: {
				defaultPolicy: "auto",
				targets: {
					remote: {
						executor: "openrouter",
						endpoint: "https://openrouter.ai/api/v1",
						models: {
							sonnet: {
								model: "anthropic/claude-sonnet-4-6",
								reasoning: "medium",
								toolUse: true,
								streaming: true,
								costTier: "high",
							},
						},
					},
					local: {
						executor: "ollama",
						endpoint: "http://127.0.0.1:11434",
						models: {
							gemma: {
								model: "gemma4",
								reasoning: "medium",
								streaming: true,
								costTier: "low",
							},
						},
					},
				},
				policies: {
					auto: {
						mode: "automatic",
						defaultTargets: [makeRoutingTargetRef("remote", "sonnet"), makeRoutingTargetRef("local", "gemma")],
					},
				},
				taskClasses: {
					hipaa_sensitive: {
						privacy: "local_only",
						preferredTargets: [makeRoutingTargetRef("local", "gemma")],
					},
				},
			},
		});
		expect(parsed.ok).toBe(true);
		if (!parsed.ok) return;

		const decision = resolveRoutingDecision(
			parsed.value,
			{
				operation: "interactive",
				taskClass: "hipaa_sensitive",
			},
			{
				targets: {
					[makeRoutingTargetRef("remote", "sonnet")]: ready,
					[makeRoutingTargetRef("local", "gemma")]: ready,
				},
			},
		);
		expect(decision.ok).toBe(true);
		if (!decision.ok) return;
		expect(decision.value.targetRef).toBe(makeRoutingTargetRef("local", "gemma"));
	});

	it("prefers higher-reasoning coding targets when tools are required", () => {
		const parsed = parseRoutingConfig({
			inference: {
				defaultPolicy: "auto",
				targets: {
					sonnet: {
						executor: "openrouter",
						endpoint: "https://openrouter.ai/api/v1",
						models: {
							default: {
								model: "anthropic/claude-sonnet-4-6",
								reasoning: "medium",
								toolUse: true,
								streaming: true,
								costTier: "medium",
							},
						},
					},
					gpt: {
						executor: "codex",
						models: {
							gpt54: {
								model: "gpt-5.4",
								reasoning: "high",
								toolUse: true,
								streaming: true,
								costTier: "high",
							},
						},
					},
				},
				policies: {
					auto: {
						mode: "automatic",
						defaultTargets: [makeRoutingTargetRef("sonnet", "default"), makeRoutingTargetRef("gpt", "gpt54")],
					},
				},
				taskClasses: {
					hard_coding: {
						reasoning: "high",
						toolsRequired: true,
						preferredTargets: [makeRoutingTargetRef("gpt", "gpt54")],
					},
				},
			},
		});
		expect(parsed.ok).toBe(true);
		if (!parsed.ok) return;

		const decision = resolveRoutingDecision(
			parsed.value,
			{
				operation: "code_reasoning",
				taskClass: "hard_coding",
				requireTools: true,
			},
			{
				targets: {
					[makeRoutingTargetRef("sonnet", "default")]: ready,
					[makeRoutingTargetRef("gpt", "gpt54")]: ready,
				},
			},
		);
		expect(decision.ok).toBe(true);
		if (!decision.ok) return;
		expect(decision.value.targetRef).toBe(makeRoutingTargetRef("gpt", "gpt54"));
	});

	it("keeps legacy routing implicit when agent.yaml has no inference block", () => {
		const legacy = compileLegacyRoutingConfig({
			extraction: {
				provider: "ollama",
				model: "qwen3:4b",
				endpoint: "http://127.0.0.1:11434",
			},
			synthesis: {
				enabled: true,
				provider: "ollama",
				model: "qwen3:4b",
				endpoint: "http://127.0.0.1:11434",
			},
		});
		const parsed = parseRoutingConfig(
			{
				name: "Dot",
				memory: {
					pipelineV2: {
						enabled: true,
					},
				},
			},
			legacy,
		);
		expect(parsed.ok).toBe(true);
		if (!parsed.ok) return;
		expect(parsed.value.source).toBe("legacy-implicit");
		expect(parsed.value.enabled).toBe(true);
		expect(parsed.value.defaultPolicy).toBe("legacy-default");
	});

	it("keeps legacy command extraction as side-effect compatibility instead of router LLM extraction", () => {
		const legacy = compileLegacyRoutingConfig({
			extraction: {
				provider: "command",
				model: "custom-command",
				endpoint: undefined,
				command: { bin: "node", args: ["extract.mjs"] },
			},
			synthesis: {
				enabled: true,
				provider: "ollama",
				model: "qwen3:4b",
				endpoint: "http://127.0.0.1:11434",
			},
		});

		expect(legacy.targets["legacy-extraction"]).toBeUndefined();
		expect(legacy.workloads?.memoryExtraction).toBeUndefined();
		expect(legacy.targets["legacy-synthesis"]?.executor).toBe("ollama");
	});

	it("does not allow explicit target overrides outside the agent roster", () => {
		const parsed = parseRoutingConfig({
			inference: {
				defaultPolicy: "auto",
				targets: {
					remote: {
						executor: "openrouter",
						endpoint: "https://openrouter.ai/api/v1",
						models: {
							sonnet: {
								model: "anthropic/claude-sonnet-4-6",
								reasoning: "medium",
								toolUse: true,
								streaming: true,
							},
						},
					},
					local: {
						executor: "ollama",
						endpoint: "http://127.0.0.1:11434",
						models: {
							gemma: {
								model: "gemma4",
								reasoning: "medium",
								streaming: true,
							},
						},
					},
				},
				policies: {
					auto: {
						mode: "automatic",
						defaultTargets: [makeRoutingTargetRef("remote", "sonnet"), makeRoutingTargetRef("local", "gemma")],
					},
				},
				agents: {
					rose: {
						defaultPolicy: "auto",
						roster: [makeRoutingTargetRef("local", "gemma")],
					},
				},
			},
		});
		expect(parsed.ok).toBe(true);
		if (!parsed.ok) return;

		const decision = resolveRoutingDecision(
			parsed.value,
			{
				agentId: "rose",
				operation: "interactive",
				explicitTargets: [makeRoutingTargetRef("remote", "sonnet")],
			},
			{
				targets: {
					[makeRoutingTargetRef("remote", "sonnet")]: ready,
					[makeRoutingTargetRef("local", "gemma")]: ready,
				},
			},
		);
		expect(decision.ok).toBe(false);
		if (!("error" in decision)) {
			throw new Error("expected explicit target override outside roster to be rejected");
		}
		expect(decision.error.code).toBe("no-candidates");
	});
});

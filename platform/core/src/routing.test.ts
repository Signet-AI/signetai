import { describe, expect, it } from "bun:test";
import {
	compileLegacyRoutingConfig,
	isLocalInferenceEndpoint,
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
	it("classifies loopback inference endpoints as local", () => {
		expect(isLocalInferenceEndpoint(undefined)).toBe(true);
		expect(isLocalInferenceEndpoint("http://127.0.0.1:1234/v1")).toBe(true);
		expect(isLocalInferenceEndpoint("http://localhost:1234/v1")).toBe(true);
		expect(isLocalInferenceEndpoint("http://[::1]:1234/v1")).toBe(true);
		expect(isLocalInferenceEndpoint("https://gateway.example.test/v1")).toBe(false);
	});

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

	it("parses ACPX as a first-class restricted harness-backed target", () => {
		const parsed = parseRoutingConfig({
			inference: {
				defaultPolicy: "background",
				targets: {
					background: {
						executor: "acpx",
						acpx: {
							agent: "codex",
							version: "0.7.0",
							permissions: "deny-all",
							hooks: "disabled",
							terminal: "inherit",
						},
						models: {
							default: {
								model: "gpt-5.4-mini",
								toolUse: true,
							},
						},
					},
				},
				policies: {
					background: {
						mode: "automatic",
						defaultTargets: [makeRoutingTargetRef("background", "default")],
					},
				},
				workloads: {
					memoryExtraction: { target: makeRoutingTargetRef("background", "default") },
				},
			},
		});
		expect(parsed.ok).toBe(true);
		if (!parsed.ok) return;
		const target = parsed.value.targets.background;
		expect(target?.executor).toBe("acpx");
		expect(target?.kind).toBe("subscription_session");
		expect(target?.privacy).toBe("restricted_remote");
		expect(target?.acpx?.agent).toBe("codex");
		expect(target?.acpx?.hooks).toBe("disabled");
		expect(target?.acpx?.terminal).toBe("inherit");
		expect(parsed.value.workloads?.memoryExtraction?.target).toBe(makeRoutingTargetRef("background", "default"));
	});

	it("preserves generated ACPX launcher package metadata when parsing setup routing", () => {
		const parsed = parseRoutingConfig({
			inference: {
				defaultPolicy: "background-acpx",
				targets: {
					"background-acpx": {
						executor: "acpx",
						acpx: {
							agent: "codex",
							bin: "/usr/local/bin/bunx",
							package: "acpx@0.7.0",
						},
						models: {
							default: {
								model: "gpt-5.4-mini",
								toolUse: true,
							},
						},
					},
				},
				policies: {
					"background-acpx": {
						mode: "automatic",
						defaultTargets: [makeRoutingTargetRef("background-acpx", "default")],
					},
				},
				taskClasses: {
					memory_extraction: {
						preferredTargets: [makeRoutingTargetRef("background-acpx", "default")],
					},
				},
				workloads: {
					memoryExtraction: { target: makeRoutingTargetRef("background-acpx", "default") },
				},
			},
		});

		expect(parsed.ok).toBe(true);
		if (!parsed.ok) return;
		expect(parsed.value.targets["background-acpx"]?.acpx).toMatchObject({
			agent: "codex",
			bin: "/usr/local/bin/bunx",
			package: "acpx@0.7.0",
		});
		expect(parsed.value.taskClasses.memory_extraction?.preferredTargets).toEqual([
			makeRoutingTargetRef("background-acpx", "default"),
		]);
	});

	it("parses documented ACPX terminal booleans into terminal modes", () => {
		const parsed = parseRoutingConfig({
			inference: {
				targets: {
					background: {
						executor: "acpx",
						acpx: { agent: "codex", terminal: false },
						models: { default: { model: "gpt-5.4-mini" } },
					},
				},
			},
		});
		expect(parsed.ok).toBe(true);
		if (!parsed.ok) return;
		expect(parsed.value.targets.background?.acpx?.terminal).toBe("disabled");
	});

	it("parses ACPX event capture configuration", () => {
		const parsed = parseRoutingConfig({
			inference: {
				targets: {
					background: {
						executor: "acpx",
						acpx: {
							agent: "codex",
							format: "json",
							captureEvents: true,
							maxCapturedEvents: 128,
						},
						models: { default: { model: "gpt-5.4-mini" } },
					},
				},
			},
		});
		expect(parsed.ok).toBe(true);
		if (!parsed.ok) return;
		expect(parsed.value.targets.background?.acpx).toMatchObject({
			format: "json",
			captureEvents: true,
			maxCapturedEvents: 128,
		});
	});

	it("keeps legacy command and ACPX extraction as side-effect compatibility instead of router LLM extraction", () => {
		const commandLegacy = compileLegacyRoutingConfig({
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

		expect(commandLegacy.targets["legacy-extraction"]).toBeUndefined();
		expect(commandLegacy.workloads?.memoryExtraction).toBeUndefined();
		expect(commandLegacy.targets["legacy-synthesis"]?.executor).toBe("ollama");

		const acpxLegacy = compileLegacyRoutingConfig({
			extraction: {
				provider: "acpx",
				model: "gpt-5.4-mini",
				endpoint: undefined,
				command: undefined,
			},
			synthesis: {
				enabled: true,
				provider: "acpx",
				model: "gpt-5.4-mini",
				endpoint: undefined,
			},
		});

		expect(acpxLegacy.targets["legacy-extraction"]).toBeUndefined();
		expect(acpxLegacy.targets["legacy-synthesis"]).toBeUndefined();
		expect(acpxLegacy.workloads?.memoryExtraction).toBeUndefined();
		expect(acpxLegacy.workloads?.sessionSynthesis).toBeUndefined();
		expect(acpxLegacy.enabled).toBe(false);
	});

	it("attaches legacy API credentials to routed API-backed workloads", () => {
		const legacy = compileLegacyRoutingConfig({
			extraction: {
				provider: "anthropic",
				model: "claude-3-5-haiku-latest",
				endpoint: undefined,
				command: undefined,
			},
			synthesis: {
				enabled: true,
				provider: "openrouter",
				model: "openai/gpt-4o-mini",
				endpoint: "https://openrouter.ai/api/v1",
			},
		});

		expect(legacy.accounts["legacy-anthropic"]).toMatchObject({
			kind: "api",
			providerFamily: "anthropic",
			credentialRef: "ANTHROPIC_API_KEY",
		});
		expect(legacy.accounts["legacy-openrouter"]).toMatchObject({
			kind: "api",
			providerFamily: "openrouter",
			credentialRef: "OPENROUTER_API_KEY",
		});
		expect(legacy.targets["legacy-extraction"]?.account).toBe("legacy-anthropic");
		expect(legacy.targets["legacy-synthesis"]?.account).toBe("legacy-openrouter");

		const compatible = compileLegacyRoutingConfig({
			extraction: {
				provider: "openai-compatible",
				model: "gpt-4o-mini",
				endpoint: "https://api.openai.com/v1",
				command: undefined,
			},
			synthesis: {
				enabled: false,
				provider: "none",
				model: "",
				endpoint: undefined,
			},
		});
		expect(compatible.accounts["legacy-openai-compatible"]).toMatchObject({
			kind: "api",
			providerFamily: "openai-compatible",
			credentialRef: "OPENAI_API_KEY",
		});
		expect(compatible.targets["legacy-extraction"]?.executor).toBe("openai-compatible");
		expect(compatible.targets["legacy-extraction"]?.account).toBe("legacy-openai-compatible");

		const localCompatible = compileLegacyRoutingConfig({
			extraction: {
				provider: "openai-compatible",
				model: "openai/gpt-oss-20b",
				endpoint: "http://127.0.0.1:1234/v1",
				command: undefined,
			},
			synthesis: {
				enabled: true,
				provider: "openai-compatible",
				model: "openai/gpt-oss-20b",
				endpoint: "http://127.0.0.1:1234/v1",
			},
		});
		expect(localCompatible.accounts["legacy-openai-compatible"]).toBeUndefined();
		expect(localCompatible.targets["legacy-extraction"]?.executor).toBe("openai-compatible");
		expect(localCompatible.targets["legacy-extraction"]?.kind).toBe("local");
		expect(localCompatible.targets["legacy-extraction"]?.privacy).toBe("local_only");
		expect(localCompatible.targets["legacy-extraction"]?.account).toBeUndefined();
		expect(localCompatible.targets["legacy-synthesis"]?.executor).toBe("openai-compatible");
		expect(localCompatible.targets["legacy-synthesis"]?.kind).toBe("local");
		expect(localCompatible.targets["legacy-synthesis"]?.privacy).toBe("local_only");
		expect(localCompatible.targets["legacy-synthesis"]?.account).toBeUndefined();
	});

	it("parses OpenRouter reasoning controls on explicit targets", () => {
		const parsed = parseRoutingConfig({
			inference: {
				targets: {
					mercury: {
						executor: "openrouter",
						account: "openrouter-api",
						openrouter: {
							reasoning: {
								enabled: false,
								max_tokens: 0,
							},
						},
						models: {
							default: {
								model: "inception/mercury-2",
							},
						},
					},
				},
			},
		});

		expect(parsed.ok).toBe(true);
		if (!parsed.ok) return;
		expect(parsed.value.targets.mercury?.openrouter?.reasoning).toEqual({
			enabled: false,
			maxTokens: 0,
		});
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

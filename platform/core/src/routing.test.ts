import { describe, expect, it } from "bun:test";
import {
	compileLegacyRoutingConfig,
	isLocalInferenceEndpoint,
	makeRoutingTargetRef,
	parseRoutingConfig,
	resolveRoutingDecision,
	validateRoutingReferences,
} from "./routing";

const ready = {
	available: true,
	health: "healthy",
	circuitOpen: false,
	accountState: "ready",
} as const;

const compatibleTargetRef = makeRoutingTargetRef("compatible", "default");

function parseRestrictedCompatibleRouting(endpoint: string) {
	return parseRoutingConfig({
		inference: {
			defaultPolicy: "auto",
			targets: {
				compatible: {
					executor: "openai-compatible",
					endpoint,
					models: {
						default: {
							model: "compatible-model",
						},
					},
				},
			},
			policies: {
				auto: {
					mode: "automatic",
					defaultTargets: [compatibleTargetRef],
				},
			},
			taskClasses: {
				memory_extraction: {
					privacy: "restricted_remote",
				},
			},
		},
	});
}

describe("inference config + decision engine", () => {
	it("classifies loopback inference endpoints as local", () => {
		expect(isLocalInferenceEndpoint(undefined)).toBe(true);
		expect(isLocalInferenceEndpoint("http://127.0.0.1:1234/v1")).toBe(true);
		expect(isLocalInferenceEndpoint("http://localhost:1234/v1")).toBe(true);
		expect(isLocalInferenceEndpoint("http://[::1]:1234/v1")).toBe(true);
		expect(isLocalInferenceEndpoint("https://gateway.example.test/v1")).toBe(false);
	});

	it("allows local openai-compatible targets for restricted_remote task classes", () => {
		const parsed = parseRestrictedCompatibleRouting("http://127.0.0.1:1234/v1");
		expect(parsed.ok).toBe(true);
		if (!parsed.ok) return;
		expect(parsed.value.targets.compatible?.privacy).toBe("local_only");

		const decision = resolveRoutingDecision(
			parsed.value,
			{ operation: "memory_extraction" },
			{ targets: { [compatibleTargetRef]: ready } },
		);
		expect(decision.ok).toBe(true);
		if (!decision.ok) return;
		expect(decision.value.targetRef).toBe(compatibleTargetRef);

		const parsedTarget = parsed.value.targets.compatible;
		expect(parsedTarget).toBeDefined();
		if (!parsedTarget) return;
		const targetWithoutParsedPrivacy = {
			...parsedTarget,
			privacy: undefined,
		};
		const directConfigDecision = resolveRoutingDecision(
			{
				...parsed.value,
				targets: {
					...parsed.value.targets,
					compatible: targetWithoutParsedPrivacy,
				},
			},
			{ operation: "memory_extraction" },
			{ targets: { [compatibleTargetRef]: ready } },
		);
		expect(directConfigDecision.ok).toBe(true);
	});

	it("keeps remote openai-compatible targets behind the restricted_remote privacy gate", () => {
		const parsed = parseRestrictedCompatibleRouting("https://gateway.example.test/v1");
		expect(parsed.ok).toBe(true);
		if (!parsed.ok) return;
		expect(parsed.value.targets.compatible?.privacy).toBe("remote_ok");

		const decision = resolveRoutingDecision(
			parsed.value,
			{ operation: "memory_extraction" },
			{ targets: { [compatibleTargetRef]: ready } },
		);
		expect(decision.ok).toBe(false);
		if (!("error" in decision)) return;
		expect(decision.error.code).toBe("no-candidates");
		const trace = decision.error.details?.trace as
			| { readonly candidates: readonly { readonly blockedBy: readonly string[] }[] }
			| undefined;
		expect(trace?.candidates[0]?.blockedBy).toContain("privacy gate (restricted_remote)");
	});

	it("honors an explicit privacy override on a loopback endpoint (no proxy-to-cloud leak)", () => {
		// Regression for the safety valve: endpoint-based privacy is a default,
		// not a forced classification. A user can explicitly mark a loopback
		// target as `remote_ok` (e.g. a local reverse-proxy forwarding to a real
		// cloud API). The privacy gate must honor that override and keep the
		// target gated for `restricted_remote` tasks — it must NOT auto-relax to
		// `local_only` just because the address is 127.0.0.1.
		const parsed = parseRestrictedCompatibleRouting("http://127.0.0.1:1234/v1");
		expect(parsed.ok).toBe(true);
		if (!parsed.ok) return;
		const baseTarget = parsed.value.targets.compatible;
		expect(baseTarget).toBeDefined();
		if (!baseTarget) return;

		const overridden = {
			...parsed.value,
			targets: {
				...parsed.value.targets,
				compatible: { ...baseTarget, privacy: "remote_ok" as const },
			},
		};
		const decision = resolveRoutingDecision(
			overridden,
			{ operation: "memory_extraction" },
			{ targets: { [compatibleTargetRef]: ready } },
		);
		expect(decision.ok).toBe(false);
		if (!("error" in decision)) return;
		expect(decision.error.code).toBe("no-candidates");
		const trace = decision.error.details?.trace as
			| { readonly candidates: readonly { readonly blockedBy: readonly string[] }[] }
			| undefined;
		expect(trace?.candidates[0]?.blockedBy).toContain("privacy gate (restricted_remote)");
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

	it("compiles legacy extraction fallbackProvider into routed fallback targets", () => {
		const legacy = compileLegacyRoutingConfig({
			extraction: {
				provider: "anthropic",
				model: "claude-3-5-haiku-latest",
				endpoint: undefined,
				command: undefined,
				fallbackProvider: "llama-cpp",
			},
			synthesis: {
				enabled: false,
				provider: "none",
				model: "",
				endpoint: undefined,
			},
		});
		const fallbackRef = makeRoutingTargetRef("legacy-extraction-fallback", "default");

		expect(legacy.targets["legacy-extraction"]?.executor).toBe("anthropic");
		expect(legacy.targets["legacy-extraction-fallback"]?.executor).toBe("llama-cpp");
		expect(legacy.targets["legacy-extraction-fallback"]?.privacy).toBe("local_only");
		expect(legacy.policies["legacy-default"]?.fallbackTargets).toEqual([fallbackRef]);

		const primaryDecision = resolveRoutingDecision(
			legacy,
			{ operation: "memory_extraction" },
			{
				targets: {
					[makeRoutingTargetRef("legacy-extraction", "default")]: ready,
					[fallbackRef]: ready,
				},
			},
		);
		expect(primaryDecision.ok).toBe(true);
		if (!primaryDecision.ok) return;
		expect(primaryDecision.value.targetRef).toBe(makeRoutingTargetRef("legacy-extraction", "default"));

		const decision = resolveRoutingDecision(
			legacy,
			{ operation: "memory_extraction" },
			{
				targets: {
					[makeRoutingTargetRef("legacy-extraction", "default")]: {
						available: false,
						health: "blocked",
						circuitOpen: false,
						accountState: "expired",
						unavailableReason: "auth failed",
					},
					[fallbackRef]: ready,
				},
			},
		);
		expect(decision.ok).toBe(true);
		if (!decision.ok) return;
		expect(decision.value.targetRef).toBe(fallbackRef);
	});

	it("omits legacy extraction fallback targets when fallbackProvider is none", () => {
		const legacy = compileLegacyRoutingConfig({
			extraction: {
				provider: "anthropic",
				model: "claude-3-5-haiku-latest",
				endpoint: undefined,
				command: undefined,
				fallbackProvider: "none",
			},
			synthesis: {
				enabled: false,
				provider: "none",
				model: "",
				endpoint: undefined,
			},
		});

		expect(legacy.targets["legacy-extraction-fallback"]).toBeUndefined();
		expect(legacy.policies["legacy-default"]?.fallbackTargets).toEqual([]);
	});

	it("fails closed for legacy extraction when fallbackProvider is none and synthesis is available", () => {
		const extractionRef = makeRoutingTargetRef("legacy-extraction", "default");
		const synthesisRef = makeRoutingTargetRef("legacy-synthesis", "default");
		const legacy = compileLegacyRoutingConfig({
			extraction: {
				provider: "openai-compatible",
				model: "remote-extractor",
				endpoint: "https://gateway.example.test/v1",
				command: undefined,
				fallbackProvider: "none",
			},
			synthesis: {
				enabled: true,
				provider: "llama-cpp",
				model: "qwen3:4b",
				endpoint: "http://127.0.0.1:8080",
			},
		});

		const decision = resolveRoutingDecision(
			legacy,
			{ operation: "memory_extraction" },
			{
				targets: {
					[extractionRef]: {
						available: false,
						health: "blocked",
						circuitOpen: false,
						accountState: "missing",
						unavailableReason: "missing credential",
					},
					[synthesisRef]: ready,
				},
			},
		);

		expect(decision.ok).toBe(false);
		if ("error" in decision) {
			expect(decision.error.code).toBe("no-candidates");
			const trace = decision.error.details?.trace as
				| { readonly candidates: readonly { readonly targetRef: string }[] }
				| undefined;
			expect(trace?.candidates.map((candidate) => candidate.targetRef)).toEqual([extractionRef]);
		}
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

	it("rejects ACPX targets for aggregate_recall (latency-sensitive, pi-ai-only)", () => {
		// aggregate_recall must never route through a subprocess — spawn latency
		// would dominate the synthesis call. Even when an acpx target is the only
		// candidate bound to the workload, resolveRoutingDecision must filter it out.
		const parsed = parseRoutingConfig({
			inference: {
				defaultPolicy: "acpx-only",
				targets: {
					harness: {
						executor: "acpx",
						acpx: { agent: "codex" },
						models: { default: { model: "gpt-5.4-mini" } },
					},
				},
				policies: {
					"acpx-only": {
						mode: "automatic",
						defaultTargets: [makeRoutingTargetRef("harness", "default")],
					},
				},
				workloads: {
					aggregateRecall: { target: makeRoutingTargetRef("harness", "default") },
				},
			},
		});
		expect(parsed.ok).toBe(true);
		if (!parsed.ok) return;
		const decision = resolveRoutingDecision(
			parsed.value,
			{ operation: "aggregate_recall" },
			{
				targets: {
					[makeRoutingTargetRef("harness", "default")]: ready,
				},
			},
		);
		// The only candidate is acpx — it must be filtered out, leaving no candidates.
		expect(decision.ok).toBe(false);
		if (!("error" in decision)) return;
		expect(decision.error.code).toBe("no-candidates");
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

	it("defaults OpenCode to agent-managed models and preserves explicit ACP model selection", () => {
		const parsed = parseRoutingConfig({
			inference: {
				targets: {
					opencode: {
						executor: "acpx",
						acpx: { agent: "OpenCode" },
						models: { default: { model: "minimax-coding-plan/MiniMax-M3" } },
					},
					codex: {
						executor: "acpx",
						acpx: { agent: "codex" },
						models: { default: { model: "gpt-5.4-mini" } },
					},
					opencodeExplicit: {
						executor: "acpx",
						acpx: { agent: "opencode", model_selection: "acp" },
						models: { default: { model: "minimax-coding-plan/MiniMax-M3" } },
					},
				},
			},
		});
		expect(parsed.ok).toBe(true);
		if (!parsed.ok) return;
		expect(parsed.value.targets.opencode?.acpx?.modelSelection).toBe("agent");
		expect(parsed.value.targets.codex?.acpx?.modelSelection).toBe("acp");
		expect(parsed.value.targets.opencodeExplicit?.acpx?.modelSelection).toBe("acp");
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
							emptyResponseRetries: 9,
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
			emptyResponseRetries: 3,
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
		expect(commandLegacy.targets["legacy-synthesis"]).toBeUndefined();

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
		expect(legacy.targets["legacy-extraction"]?.account).toBe("legacy-anthropic");
		expect(legacy.targets["legacy-synthesis"]).toBeUndefined();

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
		expect(localCompatible.targets["legacy-synthesis"]).toBeUndefined();
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

	it("accepts pi-ai provider ids without duplicating its dynamic catalog", () => {
		const parsed = parseRoutingConfig({
			inference: {
				accounts: {
					codex: { kind: "subscription_session", providerFamily: "openai-codex" },
				},
				targets: {
					codex: {
						executor: "openai-codex",
						account: "codex",
						models: { default: { model: "gpt-5.4" } },
					},
				},
			},
		});

		expect(parsed.ok).toBe(true);
		if (!parsed.ok) return;
		expect(parsed.value.targets.codex?.executor).toBe("openai-codex");
		expect(parsed.value.targets.codex?.kind).toBe("api");
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

it("ignores obsolete sessionSynthesis bindings and routes internal session work through memoryExtraction", () => {
	const parsed = parseRoutingConfig({
		inference: {
			targets: {
				memory: { executor: "ollama", models: { default: { model: "qwen3:4b" } } },
				legacy: { executor: "llama-cpp", models: { default: { model: "qwen3:4b" } } },
			},
			policies: { auto: { mode: "automatic", defaultTargets: ["memory/default"] } },
			workloads: {
				memoryExtraction: { target: "memory/default" },
				sessionSynthesis: { target: "legacy/default" },
			},
			defaultPolicy: "auto",
		},
	});
	expect(parsed.ok).toBe(true);
	if (!parsed.ok) return;
	expect("sessionSynthesis" in (parsed.value.workloads ?? {})).toBe(false);
	const decision = resolveRoutingDecision(parsed.value, { operation: "session_synthesis" }, {
		targets: { "memory/default": ready, "legacy/default": ready },
	});
	expect(decision.ok).toBe(true);
	if (decision.ok) expect(decision.value.targetRef).toBe("memory/default");
});

describe("routing reference validation (#1005)", () => {
	// A complete, valid baseline: every reference resolves. Individual tests
	// mutate one field to introduce exactly one broken reference.
	function validConfig() {
		const localRef = makeRoutingTargetRef("local", "default");
		const remoteRef = makeRoutingTargetRef("remote", "sonnet");
		return parseRoutingConfig({
			inference: {
				accounts: {
					anthropic: { kind: "api", providerFamily: "anthropic", credentialRef: "ANTHROPIC_API_KEY" },
				},
				targets: {
					local: {
						executor: "ollama",
						models: { default: { model: "gemma" } },
					},
					remote: {
						executor: "anthropic",
						account: "anthropic",
						models: { sonnet: { model: "claude-sonnet", toolUse: true } },
					},
				},
				policies: {
					auto: {
						mode: "automatic",
						defaultTargets: [remoteRef, localRef],
						fallbackTargets: [localRef],
						taskTargets: { code_reasoning: [remoteRef] },
						allow: [remoteRef, localRef],
					},
				},
				taskClasses: {
					interactive: { reasoning: "medium", preferredTargets: [remoteRef] },
					code_reasoning: { reasoning: "high" },
				},
				agents: {
					rose: {
						defaultPolicy: "auto",
						roster: [remoteRef, localRef],
						preferredTargets: { interactive: [remoteRef] },
						pinnedTargets: { interactive: remoteRef },
					},
				},
				workloads: {
					default: { policy: "auto", taskClass: "interactive" },
					memoryExtraction: { target: remoteRef },
				},
				defaultPolicy: "auto",
			},
		});
	}

	it("accepts a fully-resolved config with no issues", () => {
		const parsed = validConfig();
		expect(parsed.ok).toBe(true);
		if (!parsed.ok) return;
		expect(validateRoutingReferences(parsed.value)).toEqual([]);
	});

	it("refuses to load when defaultPolicy points at a renamed/missing policy", () => {
		// Reproduces #1005: defaultPolicy: background-acpx after rename to background.
		const parsed = parseRoutingConfig({
			inference: {
				targets: {
					background: { executor: "acpx", acpx: { agent: "codex" }, models: { default: { model: "gpt" } } },
				},
				policies: { background: { mode: "automatic", defaultTargets: [makeRoutingTargetRef("background", "default")] } },
				defaultPolicy: "background-acpx",
			},
		});
		expect(parsed.ok).toBe(false);
		if (!("error" in parsed)) throw new Error("expected config parse failure");
		expect(parsed.error.code).toBe("invalid-config");
		expect(parsed.error.message).toContain('defaultPolicy="background-acpx"');
		expect(parsed.error.details?.issues).toHaveLength(1);
	});

	it("warns (but still loads) when a workload pins a missing target", () => {
		const parsed = validConfig();
		if (!parsed.ok) return;
		const broken = {
			...parsed.value,
			workloads: { ...parsed.value.workloads!, memoryExtraction: { target: "ghost/default" } },
		};
		const issues = validateRoutingReferences(broken);
		expect(issues.every((i) => i.severity === "warning")).toBe(true);
		expect(issues.some((i) => i.field === "workloads.memoryExtraction.target" && i.ref === "ghost/default")).toBe(true);
	});

	it("warns (but still loads) when a workload references a missing policy", () => {
		const parsed = validConfig();
		if (!parsed.ok) return;
		const broken = {
			...parsed.value,
			workloads: { ...parsed.value.workloads!, default: { policy: "nope", taskClass: "interactive" } },
		};
		const issues = validateRoutingReferences(broken);
		expect(issues.every((i) => i.severity === "warning")).toBe(true);
		expect(issues.some((i) => i.field === "workloads.default.policy" && i.ref === "nope")).toBe(true);
	});

	it("warns (but still loads) when policy defaultTargets reference a missing target", () => {
		const parsed = validConfig();
		if (!parsed.ok) return;
		const broken = {
			...parsed.value,
			policies: {
				...parsed.value.policies,
				auto: { ...parsed.value.policies.auto!, defaultTargets: ["ghost/default"] },
			},
		};
		const issues = validateRoutingReferences(broken);
		expect(issues.every((i) => i.severity === "warning")).toBe(true);
		expect(issues.some((i) => i.field === "policies.auto.defaultTargets" && i.ref === "ghost/default")).toBe(true);
	});

	it("warns when a target references a missing account", () => {
		const parsed = validConfig();
		if (!parsed.ok) return;
		const broken = {
			...parsed.value,
			targets: { ...parsed.value.targets, remote: { ...parsed.value.targets.remote!, account: "ghost-account" } },
		};
		const issues = validateRoutingReferences(broken);
		expect(issues.every((i) => i.severity === "warning")).toBe(true);
		expect(issues.some((i) => i.field === "targets.remote.account" && i.ref === "ghost-account")).toBe(true);
	});

	it("warns on dangling agent roster / pinned / preferred references", () => {
		const parsed = validConfig();
		if (!parsed.ok) return;
		const broken = {
			...parsed.value,
			agents: {
				rose: {
					defaultPolicy: "ghost-policy",
					roster: ["ghost/default"],
					preferredTargets: { interactive: ["ghost2/default"] },
					pinnedTargets: { interactive: "ghost3/default" },
				},
			},
		};
		const issues = validateRoutingReferences(broken);
		const fields = issues.map((i) => i.field);
		expect(fields).toContain("agents.rose.defaultPolicy");
		expect(fields).toContain("agents.rose.roster");
		expect(fields).toContain("agents.rose.preferredTargets.interactive");
		expect(fields).toContain("agents.rose.pinnedTargets.interactive");
		expect(issues.every((i) => i.severity === "warning")).toBe(true);
	});

	it("collects multiple broken references at once instead of failing on the first", () => {
		const parsed = validConfig();
		if (!parsed.ok) return;
		const broken = {
			...parsed.value,
			workloads: {
				...parsed.value.workloads!,
				memoryExtraction: { target: "ghost-a/default" },
				aggregateRecall: { target: "ghost-b/default" },
			},
			defaultPolicy: "ghost-policy",
		};
		const issues = validateRoutingReferences(broken);
		const refs = issues.map((i) => i.ref).sort();
		expect(refs).toEqual(["ghost-a/default", "ghost-b/default", "ghost-policy"]);
	});

	it("does NOT block config load for a stale workload pin (routes via fallback)", () => {
		// Regression guard (#1005 review): a stale workloads.<name>.target must not
		// refuse the whole config, since routing falls back to the policy chain.
		const parsed = parseRoutingConfig({
			inference: {
				targets: {
					real: { executor: "ollama", models: { default: { model: "gemma" } } },
				},
				policies: {
					auto: {
						mode: "automatic",
						defaultTargets: [makeRoutingTargetRef("real", "default")],
						fallbackTargets: [makeRoutingTargetRef("real", "default")],
					},
				},
				workloads: { memoryExtraction: { target: "ghost/default" } },
				defaultPolicy: "auto",
			},
		});
		expect(parsed.ok).toBe(true);
		if (!parsed.ok) return;
		const issues = validateRoutingReferences(parsed.value);
		expect(issues.every((i) => i.severity === "warning")).toBe(true);
		expect(issues.some((i) => i.field === "workloads.memoryExtraction.target")).toBe(true);
	});

	it("warns on dangling taskClass keys in policy taskTargets / agent pinned/preferred", () => {
		const parsed = validConfig();
		if (!parsed.ok) return;
		const broken = {
			...parsed.value,
			policies: {
				...parsed.value.policies,
				auto: { ...parsed.value.policies.auto!, taskTargets: { code_reasining: [makeRoutingTargetRef("remote", "sonnet")] } },
			},
			agents: {
				rose: {
					...parsed.value.agents.rose!,
					preferredTargets: { intaractive: [makeRoutingTargetRef("remote", "sonnet")] },
					pinnedTargets: { intaractive: makeRoutingTargetRef("remote", "sonnet") },
				},
			},
		};
		const issues = validateRoutingReferences(broken);
		const fields = issues.map((i) => i.field);
		expect(fields).toContain("policies.auto.taskTargets.code_reasining");
		expect(fields).toContain("agents.rose.preferredTargets.intaractive");
		expect(fields).toContain("agents.rose.pinnedTargets.intaractive");
		expect(issues.every((i) => i.severity === "warning")).toBe(true);
	});

	it("does not flag classifier-synthetic taskClass keys (hard_coding / local_sensitive)", () => {
		const parsed = validConfig();
		if (!parsed.ok) return;
		const remoteRef = makeRoutingTargetRef("remote", "sonnet");
		const cfg = {
			...parsed.value,
			policies: {
				...parsed.value.policies,
				auto: { ...parsed.value.policies.auto!, taskTargets: { hard_coding: [remoteRef] } },
			},
			agents: {
				rose: { ...parsed.value.agents.rose!, pinnedTargets: { local_sensitive: remoteRef } },
			},
		};
		const issues = validateRoutingReferences(cfg);
		expect(issues.filter((i) => i.field.includes("hard_coding") || i.field.includes("local_sensitive"))).toEqual([]);
	});

	it("tolerates a dangling defaultPolicy when no policies are declared (CLI no-legacy path)", () => {
		// Regression guard (#1005 review): the CLI `route pin`/`unpin` commands
		// parse config with no legacy merge, so a mid-setup agent.yaml may set
		// defaultPolicy before any policies block exists. This must not block load.
		const parsed = parseRoutingConfig({
			inference: {
				defaultPolicy: "nonexistent",
				targets: { t: { executor: "ollama", models: { default: { model: "x" } } } },
			},
		});
		expect(parsed.ok).toBe(true);
		if (!parsed.ok) return;
		// And the validator must not flag it either.
		expect(validateRoutingReferences(parsed.value).filter((i) => i.field === "defaultPolicy")).toEqual([]);
	});

	it("does not flag agents.<id>.pinnedTargets.default (engine fallback pin key)", () => {
		// Regression guard (#1005 review): the CLI `route pin` writes
		// pinnedTargets.default by default, and the engine reads it as a fallback
		// pin, so it must not warn even when taskClasses.default is undeclared.
		const parsed = parseRoutingConfig({
			inference: {
				targets: { primary: { executor: "ollama", models: { fast: { model: "x" } } } },
				agents: { default: { pinnedTargets: { default: "primary/fast" } } },
			},
		});
		expect(parsed.ok).toBe(true);
		if (!parsed.ok) return;
		expect(validateRoutingReferences(parsed.value)).toEqual([]);
	});
});


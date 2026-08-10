import { defaultPipelineModel } from "@signet/core";
import type { ExtractionProviderChoice, HarnessChoice } from "./setup-shared.js";

export const EXTRACTION_SAFETY_WARNING =
	"Extraction is intended for Claude Code (haiku), Codex CLI (gpt-5.4-mini) on a Pro/Max subscription, or local llama.cpp / Ollama with qwen3:4b or larger. Remote API extraction can rack up extreme usage fees fast. On a VPS, set the provider to none unless you explicitly want background extraction.";

/**
 * Providers eligible for the distinct aggregate-recall workload are sourced
 * from pi-ai via aggregateRecallProviderIds() in setup-inference-connect
 * (pi-ai families + local servers; ACPX is excluded — aggregate recall is
 * latency-sensitive, and spawn latency would dominate).
 */

export interface SetupPipelineConfig {
	readonly enabled: boolean;
	readonly semanticContradictionEnabled?: boolean;
	readonly graph?: {
		readonly enabled: boolean;
	};
	readonly reranker?: {
		readonly enabled: boolean;
	};
	readonly autonomous?: {
		readonly enabled: boolean;
		readonly allowUpdateDelete: boolean;
		readonly maintenanceMode: "execute";
	};
}

type DirectExtractionProviderChoice = Exclude<ExtractionProviderChoice, "acpx">;

export function defaultExtractionModel(provider: DirectExtractionProviderChoice): string {
	return defaultPipelineModel(provider);
}

export function buildSetupPipeline(provider: ExtractionProviderChoice): SetupPipelineConfig {
	if (provider === "none") {
		return {
			enabled: false,
		};
	}

	// Provider/model selection is written to inference.workloads. The memory
	// pipeline retains only operation tuning and worker enablement.
	return {
		enabled: true,
		semanticContradictionEnabled: true,
		graph: { enabled: true },
		reranker: { enabled: true },
		autonomous: {
			enabled: true,
			allowUpdateDelete: true,
			maintenanceMode: "execute",
		},
	};
}
export interface SetupInferenceConfig {
	readonly defaultPolicy: string;
	readonly targets: Record<string, unknown>;
	readonly accounts?: Record<string, unknown>;
	readonly policies: Record<string, unknown>;
	readonly taskClasses: Record<string, unknown>;
	readonly workloads: Record<string, unknown>;
}

export type SetupAcpxAgent = "codex" | "claude" | "opencode";

function toAcpxAgent(provider: Extract<HarnessChoice, "codex" | "claude-code" | "opencode">): SetupAcpxAgent {
	return provider === "claude-code" ? "claude" : provider;
}

function selectAcpxAgent(
	harnesses: readonly string[],
	availableProviders: readonly ExtractionProviderChoice[] = [],
): SetupAcpxAgent {
	for (const harness of harnesses) {
		if (harness === "codex" || harness === "claude-code" || harness === "opencode") return toAcpxAgent(harness);
	}
	for (const provider of availableProviders) {
		if (provider === "codex" || provider === "claude-code" || provider === "opencode") return toAcpxAgent(provider);
	}
	return "codex";
}

export function defaultAcpxModelForAgent(agent: SetupAcpxAgent): string {
	switch (agent) {
		case "claude":
			return defaultPipelineModel("claude-code");
		case "opencode":
			return defaultPipelineModel("opencode");
		case "codex":
			return defaultPipelineModel("codex");
	}
}

export function defaultAcpxModel(
	harnesses: readonly string[] = [],
	availableProviders: readonly ExtractionProviderChoice[] = [],
): string {
	return defaultAcpxModelForAgent(selectAcpxAgent(harnesses, availableProviders));
}

export function buildSetupInference(
	provider: ExtractionProviderChoice,
	model?: string,
	harnesses: readonly string[] = [],
	availableProviders: readonly ExtractionProviderChoice[] = [],
	acpxBin?: string,
	endpoint?: string,
): SetupInferenceConfig | undefined {
	if (provider === "none") return undefined;

	const harnessProvider = provider === "claude-code" || provider === "codex" || provider === "opencode";
	if (provider === "acpx" || harnessProvider) {
		if (!acpxBin) return undefined;
		const agent = harnessProvider ? toAcpxAgent(provider) : selectAcpxAgent(harnesses, availableProviders);
		const resolved = model?.trim() || defaultAcpxModelForAgent(agent);
		const targetRef = "background-acpx/default";
		return {
			defaultPolicy: "background-acpx",
			targets: {
				"background-acpx": {
					executor: "acpx",
					acpx: {
						agent,
						bin: acpxBin,
						package: "acpx@0.7.0",
						version: "0.7.0",
						mode: "exec",
						permissions: "deny-all",
						hooks: "disabled",
						terminal: "inherit",
					},
					models: {
						default: {
							model: resolved,
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
					defaultTargets: [targetRef],
					fallbackTargets: [targetRef],
				},
			},
			taskClasses: {
				memory_extraction: { reasoning: "medium", toolsRequired: true, privacy: "restricted_remote" },
			},
			workloads: {
				memoryExtraction: { target: targetRef, taskClass: "memory_extraction" },
			},
		};
	}

	const resolved = model?.trim() || defaultExtractionModel(provider);
	const target: Record<string, unknown> = {
		executor: provider,
		models: { default: { model: resolved, reasoning: "medium" } },
	};
	let accounts: Record<string, unknown> | undefined;
	if (provider === "openai-compatible") {
		target.endpoint = endpoint?.trim() || "http://localhost:1234/v1";
	}
	if (provider === "openrouter") {
		target.account = "extraction";
		accounts = {
			extraction: { kind: "api", providerFamily: "openrouter", credentialRef: "OPENROUTER_API_KEY" },
		};
	}
	const targetRef = "background/default";
	return {
		defaultPolicy: "background",
		targets: { background: target },
		...(accounts ? { accounts } : {}),
		policies: {
			background: {
				mode: "automatic",
				defaultTargets: [targetRef],
				fallbackTargets: [targetRef],
			},
		},
		taskClasses: {
			memory_extraction: { reasoning: "medium", toolsRequired: true, privacy: "restricted_remote" },
		},
		workloads: {
			memoryExtraction: { target: targetRef, taskClass: "memory_extraction" },
		},
	};
}

export function applySetupInferenceRoute(
	config: Record<string, unknown>,
	inference: SetupInferenceConfig | undefined,
): void {
	if (inference) {
		config.inference = inference;
		return;
	}

	const existing = config.inference;
	if (typeof existing !== "object" || existing === null || Array.isArray(existing)) return;
	const route = existing as {
		defaultPolicy?: unknown;
		targets?: Record<string, unknown>;
		policies?: Record<string, unknown>;
		workloads?: Record<string, unknown>;
		taskClasses?: Record<string, unknown>;
	};
	const generated =
		route.defaultPolicy === "background-acpx"
			? { target: "background-acpx", policy: "background-acpx", workloadTarget: "background-acpx/default" }
			: route.defaultPolicy === "background"
				? { target: "background", policy: "background", workloadTarget: "background/default" }
				: null;
	if (!generated) return;

	const workload = route.workloads?.memoryExtraction;
	if (!isGeneratedSetupWorkload(workload, generated.workloadTarget)) return;
	if (route.targets) Reflect.deleteProperty(route.targets, generated.target);
	if (route.policies) Reflect.deleteProperty(route.policies, generated.policy);
	if (route.workloads) Reflect.deleteProperty(route.workloads, "memoryExtraction");
	if (route.taskClasses && isGeneratedSetupTaskClass(route.taskClasses.memory_extraction)) {
		Reflect.deleteProperty(route.taskClasses, "memory_extraction");
	}
	if (route.targets && Object.keys(route.targets).length === 0) Reflect.deleteProperty(route, "targets");
	if (route.policies && Object.keys(route.policies).length === 0) Reflect.deleteProperty(route, "policies");
	if (route.taskClasses && Object.keys(route.taskClasses).length === 0) Reflect.deleteProperty(route, "taskClasses");
	if (route.workloads && Object.keys(route.workloads).length === 0) Reflect.deleteProperty(route, "workloads");
	Reflect.deleteProperty(route, "defaultPolicy");
	if (Object.keys(route).length === 0) Reflect.deleteProperty(config, "inference");
}

function isGeneratedSetupTaskClass(value: unknown): boolean {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const record = value as { reasoning?: unknown; toolsRequired?: unknown; privacy?: unknown };
	return record.reasoning === "medium" && record.toolsRequired === true && record.privacy === "restricted_remote";
}

function isGeneratedSetupWorkload(value: unknown, target: string): boolean {
	return (
		typeof value === "object" &&
		value !== null &&
		!Array.isArray(value) &&
		(value as { target?: unknown }).target === target
	);
}

/**
 * Build the modern routing-config fragment that binds a distinct provider to
 * the aggregate-recall workload. Merged into config.inference by the daemon
 * (parseRoutingConfig overlays inference.* atop the legacy pipeline.* base),
 * so extraction/session-synthesis keep working from the extraction provider.
 *
 * Mirrors the dashboard's InferenceSection writer: a target bound to
 * workloads.aggregateRecall (target only, no taskClass — the daemon validates
 * taskClasses and 'aggregate_recall' is not declared). For the openrouter
 * family we either reuse the connected extraction account or create the
 * established OPENROUTER_API_KEY-backed account. Both shapes ensure the daemon
 * can resolve the credential instead of hard-blocking the target as 'missing'.
 */
export function buildSetupAggregateRecall(
	provider: string,
	model: string,
	endpoint?: string,
	reuseConnectedOpenRouterAccount = false,
): { targets: Record<string, unknown>; accounts?: Record<string, unknown>; workloads: Record<string, unknown> } {
	const resolvedModel = model.trim();
	const target: Record<string, unknown> = {
		executor: provider,
		models: { default: { model: resolvedModel, reasoning: "medium" } },
	};
	let accounts: Record<string, unknown> | undefined;
	if (provider === "openai-compatible") {
		target.endpoint = endpoint?.trim() || "http://localhost:1234/v1";
	} else if (provider === "openrouter") {
		// The interactive connect flow stores its API key as SIGNET_KEY_OPENROUTER
		// on the extraction account. Reuse that account rather than creating an
		// aggregation account that points at the unrelated legacy env variable.
		if (reuseConnectedOpenRouterAccount) {
			target.account = "openrouter";
		} else {
			target.account = "aggregation";
			accounts = { aggregation: { kind: "api", providerFamily: "openrouter", credentialRef: "OPENROUTER_API_KEY" } };
		}
	}
	return {
		targets: { aggregation: target },
		...(accounts ? { accounts } : {}),
		workloads: { aggregateRecall: { target: "aggregation/default" } },
	};
}

/** Merge an aggregate-recall fragment into config.inference (creating it if the
 * acpx route did not). */
export function applyAggregateRecallRoute(
	config: Record<string, unknown>,
	aggregateRecall: {
		targets: Record<string, unknown>;
		accounts?: Record<string, unknown>;
		workloads: Record<string, unknown>;
	},
): void {
	const existing = (config.inference ?? {}) as Record<string, unknown>;
	const targets = { ...((existing.targets as Record<string, unknown>) ?? {}), ...aggregateRecall.targets };
	const workloads = { ...((existing.workloads as Record<string, unknown>) ?? {}), ...aggregateRecall.workloads };
	const accounts = aggregateRecall.accounts
		? { ...((existing.accounts as Record<string, unknown>) ?? {}), ...aggregateRecall.accounts }
		: (existing.accounts as Record<string, unknown> | undefined);
	const policies = (existing.policies as Record<string, unknown> | undefined) ?? {};
	// Targets/accounts/workloads without a policy dead-end every generation path
	// in "No routing policy is configured." (#1072). When the merged config has
	// targets but zero policies, emit a default policy over all of them; leave
	// user-authored or acpx-generated policies alone.
	const refs =
		Object.keys(policies).length === 0 && Object.keys(targets).length > 0
			? Object.entries(targets).flatMap(([targetId, target]) =>
					Object.keys((target as { models?: Record<string, unknown> })?.models ?? {}).map(
						(modelId) => `${targetId}/${modelId}`,
					),
				)
			: null;
	config.inference = {
		...existing,
		targets,
		workloads,
		...(accounts ? { accounts } : {}),
		...(refs
			? {
					defaultPolicy: "default",
					policies: {
						default: {
							mode: "automatic",
							defaultTargets: refs,
							fallbackTargets: refs,
						},
					},
				}
			: {}),
	};
}

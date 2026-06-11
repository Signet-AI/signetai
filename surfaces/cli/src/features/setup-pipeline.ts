import { defaultPipelineModel } from "@signet/core";
import type { ExtractionProviderChoice, HarnessChoice } from "./setup-shared.js";

export const EXTRACTION_SAFETY_WARNING =
	"Extraction is intended for Claude Code (haiku), Codex CLI (gpt-5.4-mini) on a Pro/Max subscription, or local llama.cpp / Ollama with qwen3:4b or larger. Remote API extraction can rack up extreme usage fees fast. On a VPS, set the provider to none unless you explicitly want background extraction.";

export interface SetupPipelineConfig {
	readonly enabled: boolean;
	readonly extraction: {
		readonly provider: ExtractionProviderChoice;
		readonly model: string;
		readonly endpoint?: string;
	};
	readonly synthesis?: {
		readonly enabled: boolean;
		readonly provider: ExtractionProviderChoice;
		readonly model: string;
		readonly endpoint?: string;
		readonly timeout: number;
	};
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

export function buildSetupPipeline(
	provider: ExtractionProviderChoice,
	model?: string,
	endpoint?: string,
): SetupPipelineConfig {
	const resolved = model?.trim() || (provider === "acpx" ? "" : defaultExtractionModel(provider));
	const resolvedEndpoint = endpoint?.trim() || undefined;
	if (provider === "none") {
		return {
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
		};
	}

	return {
		enabled: true,
		extraction: {
			provider,
			model: resolved,
			...(resolvedEndpoint ? { endpoint: resolvedEndpoint } : {}),
		},
		synthesis: {
			enabled: true,
			provider,
			model: resolved,
			...(resolvedEndpoint ? { endpoint: resolvedEndpoint } : {}),
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
	};
}
export interface SetupInferenceConfig {
	readonly defaultPolicy: string;
	readonly targets: Record<string, unknown>;
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
): SetupInferenceConfig | undefined {
	if (provider !== "acpx" || !acpxBin) return undefined;
	const agent = selectAcpxAgent(harnesses, availableProviders);
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
			session_synthesis: { reasoning: "medium", toolsRequired: true, privacy: "restricted_remote" },
		},
		workloads: {
			memoryExtraction: { target: targetRef, taskClass: "memory_extraction" },
			sessionSynthesis: { target: targetRef, taskClass: "session_synthesis" },
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
	if (route.defaultPolicy !== "background-acpx") return;
	const generatedTaskClasses = new Set<string>();
	if (route.targets) Reflect.deleteProperty(route.targets, "background-acpx");
	if (route.policies) Reflect.deleteProperty(route.policies, "background-acpx");
	if (route.workloads?.memoryExtraction && isGeneratedAcpxWorkload(route.workloads.memoryExtraction)) {
		generatedTaskClasses.add(getAcpxWorkloadTaskClass(route.workloads.memoryExtraction, "memory_extraction"));
		Reflect.deleteProperty(route.workloads, "memoryExtraction");
	}
	if (route.workloads?.sessionSynthesis && isGeneratedAcpxWorkload(route.workloads.sessionSynthesis)) {
		generatedTaskClasses.add(getAcpxWorkloadTaskClass(route.workloads.sessionSynthesis, "session_synthesis"));
		Reflect.deleteProperty(route.workloads, "sessionSynthesis");
	}
	for (const taskClass of generatedTaskClasses) {
		if (isGeneratedAcpxTaskClass(taskClass, route.taskClasses?.[taskClass])) {
			Reflect.deleteProperty(route.taskClasses, taskClass);
		}
	}
	if (route.targets && Object.keys(route.targets).length === 0) Reflect.deleteProperty(route, "targets");
	if (route.policies && Object.keys(route.policies).length === 0) Reflect.deleteProperty(route, "policies");
	if (route.taskClasses && Object.keys(route.taskClasses).length === 0) Reflect.deleteProperty(route, "taskClasses");
	if (route.workloads && Object.keys(route.workloads).length === 0) Reflect.deleteProperty(route, "workloads");
	Reflect.deleteProperty(route, "defaultPolicy");
	if (Object.keys(route).length === 0) Reflect.deleteProperty(config, "inference");
}

function getAcpxWorkloadTaskClass(value: unknown, fallback: string): string {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return fallback;
	const taskClass = (value as { taskClass?: unknown }).taskClass;
	return typeof taskClass === "string" && taskClass.length > 0 ? taskClass : fallback;
}

function isGeneratedAcpxTaskClass(taskClass: string, value: unknown): boolean {
	if (taskClass !== "memory_extraction" && taskClass !== "session_synthesis") return false;
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const record = value as { reasoning?: unknown; toolsRequired?: unknown; privacy?: unknown };
	return record.reasoning === "medium" && record.toolsRequired === true && record.privacy === "restricted_remote";
}

function isGeneratedAcpxWorkload(value: unknown): boolean {
	return (
		typeof value === "object" &&
		value !== null &&
		!Array.isArray(value) &&
		(value as { target?: unknown }).target === "background-acpx/default"
	);
}

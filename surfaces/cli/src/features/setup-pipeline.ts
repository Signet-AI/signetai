import { defaultPipelineModel } from "@signet/core";
import type { ExtractionProviderChoice, HarnessChoice } from "./setup-shared.js";

export const EXTRACTION_SAFETY_WARNING =
	"Extraction is intended for Claude Code (Haiku), Codex CLI (GPT Mini) on a Pro/Max subscription, or local llama.cpp (qwen3.5:4b+) / Ollama (qwen3:4b+) models. Remote API extraction can rack up extreme usage fees fast. On a VPS, set the provider to none unless you explicitly want background extraction.";

export interface SetupPipelineConfig {
	readonly enabled: boolean;
	readonly extraction: {
		readonly provider: ExtractionProviderChoice;
		readonly model: string;
	};
	readonly synthesis?: {
		readonly enabled: boolean;
		readonly provider: ExtractionProviderChoice;
		readonly model: string;
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

export function defaultExtractionModel(provider: ExtractionProviderChoice): string {
	if (provider === "acpx") return "gpt-5-codex-mini";
	return defaultPipelineModel(provider);
}

export function buildSetupPipeline(provider: ExtractionProviderChoice, model?: string): SetupPipelineConfig {
	const resolved = model?.trim() || defaultExtractionModel(provider);
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
		},
		synthesis: {
			enabled: true,
			provider,
			model: resolved,
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

function selectAcpxAgent(
	harnesses: readonly string[],
	availableProviders: readonly ExtractionProviderChoice[] = [],
): Extract<HarnessChoice, "codex" | "claude-code" | "opencode"> {
	for (const harness of harnesses) {
		if (harness === "codex" || harness === "claude-code" || harness === "opencode") return harness;
	}
	for (const provider of availableProviders) {
		if (provider === "codex" || provider === "claude-code" || provider === "opencode") return provider;
	}
	return "codex";
}

export function buildSetupInference(
	provider: ExtractionProviderChoice,
	model?: string,
	harnesses: readonly string[] = [],
	availableProviders: readonly ExtractionProviderChoice[] = [],
): SetupInferenceConfig | undefined {
	if (provider !== "acpx") return undefined;
	const resolved = model?.trim() || defaultExtractionModel(provider);
	const targetRef = "background-acpx/default";
	return {
		defaultPolicy: "background-acpx",
		targets: {
			"background-acpx": {
				executor: "acpx",
				acpx: {
					agent: selectAcpxAgent(harnesses, availableProviders),
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

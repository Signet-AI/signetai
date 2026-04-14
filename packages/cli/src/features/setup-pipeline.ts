import { defaultPipelineModel } from "@signet/core";
import type { ExtractionProviderChoice } from "./setup-shared.js";

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
	readonly predictor?: {
		readonly enabled: boolean;
	};
	readonly predictorPipeline?: {
		readonly agentFeedback: boolean;
		readonly trainingTelemetry: boolean;
	};
}

export function defaultExtractionModel(provider: ExtractionProviderChoice): string {
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
		predictor: { enabled: true },
		predictorPipeline: {
			agentFeedback: true,
			trainingTelemetry: false,
		},
	};
}

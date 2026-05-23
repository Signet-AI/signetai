import { modelDefaultForProvider } from "./llm-model-catalog";

export const OPENCODE_PIPELINE_AGENT = "signet-pipeline";

export const OPENCODE_PIPELINE_SYSTEM_PROMPT =
	"You are a structured data extraction system. Return ONLY valid JSON matching the requested schema. No explanations, no markdown, no code fences.";

export const PIPELINE_PROVIDER_CHOICES = [
	"none",
	"acpx",
	"llama-cpp",
	"ollama",
	"claude-code",
	"codex",
	"opencode",
	"anthropic",
	"openrouter",
	"openai-compatible",
	"command",
] as const;

export type PipelineProviderChoice = (typeof PIPELINE_PROVIDER_CHOICES)[number];
export type SynthesisProviderChoice = Exclude<PipelineProviderChoice, "command">;

export const SYNTHESIS_PROVIDER_CHOICES = PIPELINE_PROVIDER_CHOICES.filter(
	(provider): provider is SynthesisProviderChoice => provider !== "command",
);

export const DEFAULT_PIPELINE_TIMEOUT_MS = 90000;

const PIPELINE_PROVIDER_SET = new Set<string>(PIPELINE_PROVIDER_CHOICES);
const SYNTHESIS_PROVIDER_SET = new Set<string>(SYNTHESIS_PROVIDER_CHOICES);

export function isPipelineProvider(value: unknown): value is PipelineProviderChoice {
	return typeof value === "string" && PIPELINE_PROVIDER_SET.has(value);
}

export function isSynthesisProvider(value: unknown): value is SynthesisProviderChoice {
	return typeof value === "string" && SYNTHESIS_PROVIDER_SET.has(value);
}

export function defaultPipelineModel(provider: PipelineProviderChoice): string {
	return modelDefaultForProvider(provider);
}

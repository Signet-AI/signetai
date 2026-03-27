export const PIPELINE_PROVIDER_CHOICES = [
	"none",
	"ollama",
	"claude-code",
	"codex",
	"opencode",
	"anthropic",
	"openrouter",
	"command",
] as const;

export type PipelineProviderChoice = (typeof PIPELINE_PROVIDER_CHOICES)[number];

export const DEFAULT_PIPELINE_TIMEOUT_MS = 90000;

const MODEL_DEFAULTS = {
	none: "",
	ollama: "qwen3:4b",
	"claude-code": "haiku",
	codex: "gpt-5-codex-mini",
	opencode: "anthropic/claude-haiku-4-5-20251001",
	anthropic: "haiku",
	openrouter: "openai/gpt-4o-mini",
	command: "",
} as const satisfies Record<PipelineProviderChoice, string>;

const PIPELINE_PROVIDER_SET = new Set<string>(PIPELINE_PROVIDER_CHOICES);

export function isPipelineProvider(value: unknown): value is PipelineProviderChoice {
	return typeof value === "string" && PIPELINE_PROVIDER_SET.has(value);
}

export function defaultPipelineModel(provider: PipelineProviderChoice): string {
	return MODEL_DEFAULTS[provider];
}

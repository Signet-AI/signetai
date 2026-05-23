export interface PipelineModelPreset {
	readonly value: string;
	readonly label: string;
	readonly tier: "low" | "mid" | "high";
	readonly source: "provider" | "harness" | "local";
}

export type ModelCatalogProvider =
	| "none"
	| "acpx"
	| "llama-cpp"
	| "ollama"
	| "claude-code"
	| "codex"
	| "opencode"
	| "anthropic"
	| "openrouter"
	| "openai-compatible"
	| "command";

export const PIPELINE_MODEL_CATALOG = {
	none: [],
	command: [],
	acpx: [
		{ value: "haiku", label: "Claude Code · haiku", tier: "low", source: "harness" },
		{ value: "gpt-5.4-mini", label: "Codex CLI · gpt-5.4-mini", tier: "low", source: "harness" },
		{ value: "google/gemini-2.5-flash", label: "OpenCode · google/gemini-2.5-flash", tier: "low", source: "harness" },
	],
	"llama-cpp": [
		{ value: "qwen3:4b", label: "qwen3:4b", tier: "low", source: "local" },
		{ value: "qwen3:8b", label: "qwen3:8b", tier: "low", source: "local" },
	],
	ollama: [
		{ value: "qwen3:4b", label: "qwen3:4b", tier: "low", source: "local" },
		{ value: "llama3", label: "llama3", tier: "low", source: "local" },
	],
	"claude-code": [
		{ value: "haiku", label: "Haiku", tier: "low", source: "harness" },
		{ value: "sonnet", label: "Sonnet", tier: "mid", source: "harness" },
		{ value: "opus", label: "Opus", tier: "high", source: "harness" },
	],
	codex: [
		{ value: "gpt-5.4-mini", label: "gpt-5.4-mini", tier: "low", source: "harness" },
		{ value: "gpt-5.4", label: "gpt-5.4", tier: "mid", source: "harness" },
		{ value: "gpt-5.5", label: "gpt-5.5", tier: "high", source: "harness" },
		{ value: "gpt-5.3-codex", label: "gpt-5.3-codex", tier: "mid", source: "harness" },
		{ value: "gpt-5.3-codex-spark", label: "gpt-5.3-codex-spark", tier: "low", source: "harness" },
		{ value: "gpt-5.2", label: "gpt-5.2", tier: "mid", source: "harness" },
	],
	opencode: [
		{ value: "google/gemini-2.5-flash", label: "google/gemini-2.5-flash", tier: "low", source: "harness" },
		{ value: "openai/gpt-5.4-mini", label: "openai/gpt-5.4-mini", tier: "low", source: "harness" },
		{ value: "openai/gpt-5.4", label: "openai/gpt-5.4", tier: "mid", source: "harness" },
	],
	anthropic: [
		{ value: "claude-3-5-haiku-20241022", label: "Claude 3.5 Haiku", tier: "low", source: "provider" },
		{ value: "claude-sonnet-4-20250514", label: "Claude Sonnet 4", tier: "mid", source: "provider" },
	],
	openrouter: [
		{ value: "openai/gpt-4o-mini", label: "openai/gpt-4o-mini", tier: "low", source: "provider" },
		{ value: "openai/gpt-5.4-mini", label: "openai/gpt-5.4-mini", tier: "low", source: "provider" },
		{ value: "anthropic/claude-3.5-haiku", label: "anthropic/claude-3.5-haiku", tier: "low", source: "provider" },
		{ value: "google/gemini-2.5-flash", label: "google/gemini-2.5-flash", tier: "low", source: "provider" },
	],
	"openai-compatible": [
		{ value: "gpt-4o-mini", label: "gpt-4o-mini", tier: "low", source: "provider" },
		{ value: "gpt-4.1-mini", label: "gpt-4.1-mini", tier: "low", source: "provider" },
		{ value: "local-model", label: "local-model", tier: "low", source: "provider" },
	],
} as const satisfies Record<ModelCatalogProvider, readonly PipelineModelPreset[]>;

export const MODEL_DEFAULTS = {
	none: "",
	acpx: "haiku",
	"llama-cpp": "qwen3:4b",
	ollama: "qwen3:4b",
	"claude-code": "haiku",
	codex: "gpt-5.4-mini",
	opencode: "google/gemini-2.5-flash",
	anthropic: "claude-3-5-haiku-20241022",
	openrouter: "openai/gpt-4o-mini",
	"openai-compatible": "gpt-4o-mini",
	command: "",
} as const satisfies Record<ModelCatalogProvider, string>;

export function modelPresetsForProvider(provider: string): readonly PipelineModelPreset[] {
	return Object.prototype.hasOwnProperty.call(PIPELINE_MODEL_CATALOG, provider)
		? PIPELINE_MODEL_CATALOG[provider as ModelCatalogProvider]
		: [];
}

export function modelDefaultForProvider(provider: ModelCatalogProvider): string {
	return MODEL_DEFAULTS[provider];
}

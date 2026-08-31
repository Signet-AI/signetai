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

// Provider-backed entries are curated against @earendil-works/pi-ai 0.84.4.
// Pi's complete provider catalogs remain the authority for connect/setup flows;
// these are the small checked presets used by the legacy pipeline endpoints.
export const PIPELINE_MODEL_CATALOG = {
	none: [],
	command: [],
	acpx: [
		{ value: "haiku", label: "Claude Code · haiku", tier: "low", source: "harness" },
		{ value: "gpt-5.4-mini", label: "Codex CLI · gpt-5.4-mini", tier: "low", source: "harness" },
		{
			value: "opencode/gemini-3-flash",
			label: "OpenCode · opencode/gemini-3-flash",
			tier: "low",
			source: "harness",
		},
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
		{ value: "gpt-5.3-codex-spark", label: "gpt-5.3-codex-spark", tier: "low", source: "harness" },
		{ value: "gpt-5.4-mini", label: "gpt-5.4-mini", tier: "low", source: "harness" },
		{ value: "gpt-5.4", label: "gpt-5.4", tier: "mid", source: "harness" },
		{ value: "gpt-5.5", label: "gpt-5.5", tier: "high", source: "harness" },
		{ value: "gpt-5.6-luna", label: "gpt-5.6-luna", tier: "high", source: "harness" },
		{ value: "gpt-5.6-sol", label: "gpt-5.6-sol", tier: "high", source: "harness" },
		{ value: "gpt-5.6-terra", label: "gpt-5.6-terra", tier: "high", source: "harness" },
	],
	opencode: [
		{ value: "opencode/gemini-3-flash", label: "opencode/gemini-3-flash", tier: "low", source: "harness" },
		{ value: "opencode/gpt-5.4-mini", label: "opencode/gpt-5.4-mini", tier: "low", source: "harness" },
		{ value: "opencode/gpt-5.5", label: "opencode/gpt-5.5", tier: "mid", source: "harness" },
	],
	anthropic: [
		{ value: "claude-haiku-4-5", label: "Claude Haiku 4.5", tier: "low", source: "provider" },
		{ value: "claude-sonnet-4-6", label: "Claude Sonnet 4.6", tier: "mid", source: "provider" },
		{ value: "claude-opus-4-6", label: "Claude Opus 4.6", tier: "high", source: "provider" },
	],
	openrouter: [
		{ value: "openai/gpt-5.4-mini", label: "openai/gpt-5.4-mini", tier: "low", source: "provider" },
		{ value: "openai/gpt-5.4", label: "openai/gpt-5.4", tier: "mid", source: "provider" },
		{ value: "anthropic/claude-sonnet-4.6", label: "anthropic/claude-sonnet-4.6", tier: "mid", source: "provider" },
		{
			value: "google/gemini-3.1-pro-preview",
			label: "google/gemini-3.1-pro-preview",
			tier: "high",
			source: "provider",
		},
		{ value: "deepseek/deepseek-v4-pro", label: "deepseek/deepseek-v4-pro", tier: "high", source: "provider" },
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
	opencode: "opencode/gemini-3-flash",
	anthropic: "claude-haiku-4-5",
	openrouter: "openai/gpt-5.4-mini",
	"openai-compatible": "gpt-4o-mini",
	command: "",
} as const satisfies Record<ModelCatalogProvider, string>;

export function modelPresetsForProvider(provider: string): readonly PipelineModelPreset[] {
	return Object.hasOwn(PIPELINE_MODEL_CATALOG, provider)
		? PIPELINE_MODEL_CATALOG[provider as ModelCatalogProvider]
		: [];
}

export function modelDefaultForProvider(provider: ModelCatalogProvider): string {
	return MODEL_DEFAULTS[provider];
}

import type { PipelineProviderChoice } from "@signet/core/pipeline-providers";

export type IdentityPresetName = "minimal" | "hermes" | "openclaw" | "custom";

export const IDENTITY_PRESET_META: Array<{
	name: IdentityPresetName;
	title: string;
	subtitle: string;
	files: string;
}> = [
	{
		name: "minimal",
		title: "Minimal",
		subtitle: "AGENTS.md operating instructions plus dreaming. Light and focused.",
		files: "AGENTS.md + DREAMING.md",
	},
	{
		name: "hermes",
		title: "Hermes",
		subtitle: "SOUL.md primary identity with project-context discovery.",
		files: "SOUL.md + AGENTS.md + DREAMING.md",
	},
	{
		name: "openclaw",
		title: "OpenClaw",
		subtitle: "Rich identity stack for character-forward agents.",
		files: "AGENTS.md + SOUL.md + IDENTITY.md + USER.md + MEMORY.md",
	},
	{
		name: "custom",
		title: "Custom",
		subtitle: "Select your own startup files later in settings.",
		files: "AGENTS.md + DREAMING.md",
	},
];

export interface OnboardingState {
	identityPreset: IdentityPresetName;
	agentName: string;
	agentDescription: string;
	selectedHarnesses: string[];
	selectedHarness: string;
	embeddingProvider: EmbeddingProvider;
	embeddingModel: string;
	embeddingEndpoint: string;
	extractionProvider: PipelineProviderChoice;
	extractionModel: string;
	extractionEndpoint: string;
	synthesisEnabled: boolean;
	showAdvancedProviders: boolean;
	currentStep: number;
	saving: boolean;
}

export type EmbeddingProvider = "native" | "llama-cpp" | "ollama" | "openai" | "none";

export const EMBEDDING_PROVIDER_OPTIONS: Array<{
	readonly value: EmbeddingProvider;
	readonly label: string;
	readonly detail: string;
	readonly defaultModel: string;
	readonly defaultEndpoint: string;
}> = [
	{
		value: "native",
		label: "Native (built-in)",
		detail: "On-device embedding with no external server. Recommended.",
		defaultModel: "nomic-embed-text-v1.5",
		defaultEndpoint: "",
	},
	{
		value: "llama-cpp",
		label: "llama.cpp",
		detail: "OpenAI-compatible server bundled with llama.cpp.",
		defaultModel: "nomic-embed-text",
		defaultEndpoint: "http://localhost:8080/v1",
	},
	{
		value: "ollama",
		label: "Ollama",
		detail: "Ollama daemon on this machine or LAN.",
		defaultModel: "nomic-embed-text",
		defaultEndpoint: "http://localhost:11434",
	},
	{
		value: "openai",
		label: "OpenAI",
		detail: "OpenAI text-embedding API. Requires API key in secrets.",
		defaultModel: "text-embedding-3-small",
		defaultEndpoint: "https://api.openai.com/v1",
	},
	{
		value: "none",
		label: "Off",
		detail: "Disable vector search. Memory will be keyword-only.",
		defaultModel: "",
		defaultEndpoint: "",
	},
];

export const EMBEDDING_MODEL_PRESETS: Record<string, Array<{ value: string; label: string }>> = {
	native: [{ value: "nomic-embed-text-v1.5", label: "nomic-embed-text-v1.5" }],
	"llama-cpp": [
		{ value: "nomic-embed-text", label: "nomic-embed-text" },
		{ value: "all-minilm", label: "all-minilm" },
		{ value: "mxbai-embed-large", label: "mxbai-embed-large" },
	],
	ollama: [
		{ value: "nomic-embed-text", label: "nomic-embed-text" },
		{ value: "all-minilm", label: "all-minilm" },
		{ value: "mxbai-embed-large", label: "mxbai-embed-large" },
	],
	openai: [
		{ value: "text-embedding-3-small", label: "text-embedding-3-small" },
		{ value: "text-embedding-3-large", label: "text-embedding-3-large" },
	],
	none: [],
};

export type ExtractionProviderOption = {
	value: PipelineProviderChoice;
	label: string;
	detail: string;
	mode: "agent" | "local" | "api" | "off" | "custom";
	endpointPlaceholder?: string;
};

export const EXTRACTION_PROVIDER_OPTIONS: ExtractionProviderOption[] = [
	{
		value: "acpx",
		label: "ACPX",
		detail: "Route extraction through a selected installed agent harness.",
		mode: "agent",
	},
	{
		value: "llama-cpp",
		label: "llama.cpp",
		detail: "Use a local llama.cpp OpenAI-compatible server.",
		mode: "local",
		endpointPlaceholder: "http://127.0.0.1:8080/v1",
	},
	{
		value: "ollama",
		label: "Ollama",
		detail: "Use an Ollama daemon running on this machine or LAN.",
		mode: "local",
		endpointPlaceholder: "http://127.0.0.1:11434",
	},
	{
		value: "claude-code",
		label: "Claude Code",
		detail: "Call the local Claude Code CLI directly for extraction.",
		mode: "agent",
	},
	{
		value: "codex",
		label: "Codex",
		detail: "Call the local Codex CLI directly for extraction.",
		mode: "agent",
	},
	{
		value: "opencode",
		label: "OpenCode",
		detail: "Use OpenCode as the extraction backend.",
		mode: "agent",
	},
	{
		value: "anthropic",
		label: "Anthropic API",
		detail: "Use Anthropic directly with configured secrets.",
		mode: "api",
		endpointPlaceholder: "https://api.anthropic.com",
	},
	{
		value: "openrouter",
		label: "OpenRouter",
		detail: "Use OpenRouter with configured secrets.",
		mode: "api",
		endpointPlaceholder: "https://openrouter.ai/api/v1",
	},
	{
		value: "command",
		label: "Command",
		detail: "Use a custom command provider configured in advanced settings.",
		mode: "custom",
	},
	{
		value: "none",
		label: "Off",
		detail: "Leave extraction disabled for now.",
		mode: "off",
	},
];

export const EXTRACTION_MODEL_PRESETS: Partial<Record<PipelineProviderChoice, string[]>> = {
	acpx: ["gpt-5-codex-mini", "gpt-5-codex", "claude-haiku-4-5"],
	"llama-cpp": ["qwen3.5:4b", "qwen3:8b", "llama-3.1-8b"],
	ollama: ["qwen3:4b", "qwen3:8b", "glm-4.7-flash"],
	"claude-code": ["haiku", "sonnet", "opus"],
	codex: ["gpt-5-codex-mini", "gpt-5-codex", "gpt-5.4"],
	opencode: ["anthropic/claude-haiku-4-5-20251001", "google/gemini-2.5-flash"],
	anthropic: ["haiku", "sonnet", "opus"],
	openrouter: ["openai/gpt-4o-mini", "anthropic/claude-haiku-4-5-20251001"],
};

export const EXTRACTION_SAFETY_TEXT =
	"Remote API extraction can stack up extreme fees fast. Intended usage: Claude Code on haiku, Codex CLI on gpt-5-codex-mini with a pro/max subscription, or local providers (llama.cpp or Ollama) at qwen3:4b or larger.";

export const RECOMMENDED_EXTRACTION: PipelineProviderChoice[] = ["acpx", "ollama", "codex", "claude-code"];

export function createDefaultState(): OnboardingState {
	return {
		identityPreset: "minimal",
		agentName: "My Agent",
		agentDescription: "Personal AI assistant",
		selectedHarnesses: [],
		selectedHarness: "",
		embeddingProvider: "native",
		embeddingModel: "nomic-embed-text-v1.5",
		embeddingEndpoint: "",
		extractionProvider: "acpx",
		extractionModel: "gpt-5-codex-mini",
		extractionEndpoint: "",
		synthesisEnabled: true,
		showAdvancedProviders: false,
		currentStep: 0,
		saving: false,
	};
}

export interface ModelConfig {
  id: string
  provider: "openai" | "anthropic" | "google"
  displayName: string
  supportsTemperature: boolean
  defaultTemperature: number
  maxTokensParam: "maxTokens" | "max_completion_tokens" | "maxOutputTokens"
  defaultMaxTokens: number
}

type ModelProvider = ModelConfig["provider"]
type ModelOverrides = Partial<
  Pick<ModelConfig, "supportsTemperature" | "defaultTemperature" | "maxTokensParam">
>

const modelDefaults = {
  supportsTemperature: true,
  defaultTemperature: 0,
  maxTokensParam: "maxTokens",
  defaultMaxTokens: 1000,
} as const

function defineModel(
  provider: ModelProvider,
  id: string,
  displayName: string,
  overrides?: ModelOverrides
): ModelConfig {
  return { id, provider, displayName, ...modelDefaults, ...overrides }
}

const noTemperature: ModelOverrides = {
  supportsTemperature: false,
  defaultTemperature: 1,
  maxTokensParam: "max_completion_tokens",
}

export const MODEL_CONFIGS: Record<string, ModelConfig> = {
  "gpt-4o": defineModel("openai", "gpt-4o", "GPT-4o (Legacy)"),
  "gpt-4o-mini": defineModel("openai", "gpt-4o-mini", "GPT-4o Mini (Legacy)"),
  "gpt-4.1": defineModel("openai", "gpt-4.1", "GPT-4.1"),
  "gpt-4.1-mini": defineModel("openai", "gpt-4.1-mini", "GPT-4.1 Mini"),
  "gpt-4.1-nano": defineModel("openai", "gpt-4.1-nano", "GPT-4.1 Nano"),
  "gpt-5": defineModel("openai", "gpt-5", "GPT-5", noTemperature),
  "gpt-5-mini": defineModel("openai", "gpt-5-mini", "GPT-5 Mini", noTemperature),
  o1: defineModel("openai", "o1", "o1", noTemperature),
  "o1-pro": defineModel("openai", "o1-pro", "o1 Pro", noTemperature),
  o3: defineModel("openai", "o3", "o3", noTemperature),
  "o3-mini": defineModel("openai", "o3-mini", "o3 Mini", noTemperature),
  "o3-pro": defineModel("openai", "o3-pro", "o3 Pro", noTemperature),
  "o4-mini": defineModel("openai", "o4-mini", "o4 Mini", noTemperature),
  "opus-4.5": defineModel("anthropic", "claude-opus-4-5-20251101", "Claude Opus 4.5"),
  "sonnet-4.5": defineModel("anthropic", "claude-sonnet-4-5-20250929", "Claude Sonnet 4.5"),
  "haiku-4.5": defineModel("anthropic", "claude-haiku-4-5-20251001", "Claude Haiku 4.5"),
  "opus-4.1": defineModel("anthropic", "claude-opus-4-1-20250805", "Claude Opus 4.1"),
  "sonnet-4": defineModel("anthropic", "claude-sonnet-4-20250514", "Claude Sonnet 4"),
  "gemini-2.5-pro": defineModel("google", "gemini-2.5-pro", "Gemini 2.5 Pro"),
  "gemini-2.5-flash": defineModel("google", "gemini-2.5-flash", "Gemini 2.5 Flash"),
  "gemini-2.5-flash-lite": defineModel("google", "gemini-2.5-flash-lite", "Gemini 2.5 Flash Lite"),
  "gemini-2.0-flash": defineModel("google", "gemini-2.0-flash", "Gemini 2.0 Flash"),
  "gemini-3-pro-preview": defineModel("google", "gemini-3-pro-preview", "Gemini 3 Pro Preview", {
    defaultTemperature: 1,
  }),
}

export const DEFAULT_ANSWERING_MODEL = "gpt-4o"
export const DEFAULT_JUDGE_MODELS: Record<string, string> = {
  openai: "gpt-4o",
  anthropic: "sonnet-4",
  google: "gemini-2.5-flash",
}

export function getModelConfig(alias: string): ModelConfig {
  const lowerAlias = alias.toLowerCase()
  const configured = MODEL_CONFIGS[lowerAlias]
  if (configured) return configured

  const isOpenAIWithoutTemperature =
    lowerAlias.startsWith("gpt-5") ||
    lowerAlias.startsWith("o1") ||
    lowerAlias.startsWith("o3") ||
    lowerAlias.startsWith("o4") ||
    lowerAlias.endsWith(".gguf") ||
    lowerAlias.includes("gemma-4") ||
    lowerAlias.includes("inception/mercury")
  const provider = isOpenAIWithoutTemperature
    ? "openai"
    : lowerAlias.startsWith("claude-")
      ? "anthropic"
      : lowerAlias.startsWith("gemini-")
        ? "google"
        : "openai"

  return defineModel(provider, alias, alias, {
    supportsTemperature: !isOpenAIWithoutTemperature,
    defaultTemperature: isOpenAIWithoutTemperature || lowerAlias.startsWith("gemini-3") ? 1 : 0,
    maxTokensParam: isOpenAIWithoutTemperature ? "max_completion_tokens" : "maxTokens",
  })
}

export const MODEL_ALIASES = MODEL_CONFIGS

export function resolveModel(alias: string): ModelConfig {
  return getModelConfig(alias)
}

export function getModelId(alias: string): string {
  return getModelConfig(alias).id
}

export function getModelProvider(alias: string): ModelProvider {
  return getModelConfig(alias).provider
}

export function listAvailableModels(): string[] {
  return Object.keys(MODEL_CONFIGS)
}

export function listModelsByProvider(provider: ModelProvider): string[] {
  return Object.keys(MODEL_CONFIGS).filter((alias) => MODEL_CONFIGS[alias].provider === provider)
}

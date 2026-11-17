import type { JSONValue } from "ai"

export type ModelProvider =
  | "openai"
  | "anthropic"
  | "google"
  | "zai"
  | "openrouter"
  | "local"

export interface OpenRouterModelSettings {
  provider?: Record<string, JSONValue>
  reasoning?: Record<string, JSONValue>
}

export interface ModelPricing {
  inputPerMillion: number
  outputPerMillion: number
  cachedInputPerMillion?: number
}

export interface ModelConfig {
  id: string
  provider: ModelProvider
  displayName: string
  supportsTemperature: boolean
  defaultTemperature: number
  maxTokensParam: "maxTokens" | "max_completion_tokens" | "maxOutputTokens"
  defaultMaxTokens: number
  thinking?: "enabled" | "disabled"
  reasoningEffort?: string
  thinkingBudgetTokens?: number
  openrouterSettings?: OpenRouterModelSettings
  pricing?: ModelPricing
}

const GLM_5_3_FLASH_PRICING: ModelPricing = {
  inputPerMillion: 0.15,
  outputPerMillion: 0.5,
  cachedInputPerMillion: 0.03,
}

export const MODEL_CONFIGS: Record<string, ModelConfig> = {
  "gpt-4o": {
    id: "gpt-4o",
    provider: "openai",
    displayName: "GPT-4o (Legacy)",
    supportsTemperature: true,
    defaultTemperature: 0,
    maxTokensParam: "maxTokens",
    defaultMaxTokens: 1000,
  },
  "gpt-4o-mini": {
    id: "gpt-4o-mini",
    provider: "openai",
    displayName: "GPT-4o Mini (Legacy)",
    supportsTemperature: true,
    defaultTemperature: 0,
    maxTokensParam: "maxTokens",
    defaultMaxTokens: 1000,
  },
  "gpt-4.1": {
    id: "gpt-4.1",
    provider: "openai",
    displayName: "GPT-4.1",
    supportsTemperature: true,
    defaultTemperature: 0,
    maxTokensParam: "maxTokens",
    defaultMaxTokens: 1000,
  },
  "gpt-4.1-mini": {
    id: "gpt-4.1-mini",
    provider: "openai",
    displayName: "GPT-4.1 Mini",
    supportsTemperature: true,
    defaultTemperature: 0,
    maxTokensParam: "maxTokens",
    defaultMaxTokens: 1000,
  },
  "gpt-4.1-nano": {
    id: "gpt-4.1-nano",
    provider: "openai",
    displayName: "GPT-4.1 Nano",
    supportsTemperature: true,
    defaultTemperature: 0,
    maxTokensParam: "maxTokens",
    defaultMaxTokens: 1000,
  },
  "gpt-5": {
    id: "gpt-5",
    provider: "openai",
    displayName: "GPT-5",
    supportsTemperature: false,
    defaultTemperature: 1,
    maxTokensParam: "max_completion_tokens",
    defaultMaxTokens: 1000,
  },
  "gpt-5-mini": {
    id: "gpt-5-mini",
    provider: "openai",
    displayName: "GPT-5 Mini",
    supportsTemperature: false,
    defaultTemperature: 1,
    maxTokensParam: "max_completion_tokens",
    defaultMaxTokens: 1000,
  },
  o1: {
    id: "o1",
    provider: "openai",
    displayName: "o1",
    supportsTemperature: false,
    defaultTemperature: 1,
    maxTokensParam: "max_completion_tokens",
    defaultMaxTokens: 1000,
  },
  "o1-pro": {
    id: "o1-pro",
    provider: "openai",
    displayName: "o1 Pro",
    supportsTemperature: false,
    defaultTemperature: 1,
    maxTokensParam: "max_completion_tokens",
    defaultMaxTokens: 1000,
  },
  o3: {
    id: "o3",
    provider: "openai",
    displayName: "o3",
    supportsTemperature: false,
    defaultTemperature: 1,
    maxTokensParam: "max_completion_tokens",
    defaultMaxTokens: 1000,
  },
  "o3-mini": {
    id: "o3-mini",
    provider: "openai",
    displayName: "o3 Mini",
    supportsTemperature: false,
    defaultTemperature: 1,
    maxTokensParam: "max_completion_tokens",
    defaultMaxTokens: 1000,
  },
  "o3-pro": {
    id: "o3-pro",
    provider: "openai",
    displayName: "o3 Pro",
    supportsTemperature: false,
    defaultTemperature: 1,
    maxTokensParam: "max_completion_tokens",
    defaultMaxTokens: 1000,
  },
  "o4-mini": {
    id: "o4-mini",
    provider: "openai",
    displayName: "o4 Mini",
    supportsTemperature: false,
    defaultTemperature: 1,
    maxTokensParam: "max_completion_tokens",
    defaultMaxTokens: 1000,
  },
  "opus-4.5": {
    id: "claude-opus-4-5-20251101",
    provider: "anthropic",
    displayName: "Claude Opus 4.5",
    supportsTemperature: true,
    defaultTemperature: 0,
    maxTokensParam: "maxTokens",
    defaultMaxTokens: 1000,
  },
  "sonnet-4.5": {
    id: "claude-sonnet-4-5-20250929",
    provider: "anthropic",
    displayName: "Claude Sonnet 4.5",
    supportsTemperature: true,
    defaultTemperature: 0,
    maxTokensParam: "maxTokens",
    defaultMaxTokens: 1000,
  },
  "haiku-4.5": {
    id: "claude-haiku-4-5-20251001",
    provider: "anthropic",
    displayName: "Claude Haiku 4.5",
    supportsTemperature: true,
    defaultTemperature: 0,
    maxTokensParam: "maxTokens",
    defaultMaxTokens: 1000,
  },
  "opus-4.1": {
    id: "claude-opus-4-1-20250805",
    provider: "anthropic",
    displayName: "Claude Opus 4.1",
    supportsTemperature: true,
    defaultTemperature: 0,
    maxTokensParam: "maxTokens",
    defaultMaxTokens: 1000,
  },
  "sonnet-4": {
    id: "claude-sonnet-4-20250514",
    provider: "anthropic",
    displayName: "Claude Sonnet 4",
    supportsTemperature: true,
    defaultTemperature: 0,
    maxTokensParam: "maxTokens",
    defaultMaxTokens: 1000,
  },
  "gemini-2.5-pro": {
    id: "gemini-2.5-pro",
    provider: "google",
    displayName: "Gemini 2.5 Pro",
    supportsTemperature: true,
    defaultTemperature: 0,
    maxTokensParam: "maxTokens",
    defaultMaxTokens: 1000,
  },
  "gemini-2.5-flash": {
    id: "gemini-2.5-flash",
    provider: "google",
    displayName: "Gemini 2.5 Flash",
    supportsTemperature: true,
    defaultTemperature: 0,
    maxTokensParam: "maxTokens",
    defaultMaxTokens: 1000,
  },
  "gemini-2.5-flash-lite": {
    id: "gemini-2.5-flash-lite",
    provider: "google",
    displayName: "Gemini 2.5 Flash Lite",
    supportsTemperature: true,
    defaultTemperature: 0,
    maxTokensParam: "maxTokens",
    defaultMaxTokens: 1000,
  },
  "gemini-2.0-flash": {
    id: "gemini-2.0-flash",
    provider: "google",
    displayName: "Gemini 2.0 Flash",
    supportsTemperature: true,
    defaultTemperature: 0,
    maxTokensParam: "maxTokens",
    defaultMaxTokens: 1000,
  },
  "gemini-3-pro-preview": {
    id: "gemini-3-pro-preview",
    provider: "google",
    displayName: "Gemini 3 Pro Preview",
    supportsTemperature: true,
    defaultTemperature: 1,
    maxTokensParam: "maxTokens",
    defaultMaxTokens: 1000,
  },
  "glm-5.3-flash": {
    id: "glm-5.3-flash",
    provider: "zai",
    displayName: "GLM-5.3-Flash",
    supportsTemperature: true,
    defaultTemperature: 0,
    maxTokensParam: "maxTokens",
    defaultMaxTokens: 1000,
    thinking: "disabled",
    pricing: GLM_5_3_FLASH_PRICING,
  },
  "glm-5.3-flash-thinking": {
    id: "glm-5.3-flash",
    provider: "zai",
    displayName: "GLM-5.3-Flash (thinking)",
    supportsTemperature: false,
    defaultTemperature: 1,
    maxTokensParam: "maxTokens",
    defaultMaxTokens: 16000,
    thinking: "enabled",
    pricing: GLM_5_3_FLASH_PRICING,
  },
}

export const DEFAULT_ANSWERING_MODEL = "gpt-4o"

const LOCAL_PREFIX = "local:"
const DEFAULT_LOCAL_MAX_TOKENS = 16_000
const OPENROUTER_PREFIX = "openrouter:"
const OPENROUTER_MODELS_ENV = "MEMORYBENCH_OPENROUTER_MODELS"
const OPENROUTER_SETTINGS_KEYS = ["provider", "reasoning", "maxTokens"]
const DEFAULT_OPENROUTER_MAX_TOKENS = 1000

function readOpenRouterModelSettings(
  env: NodeJS.ProcessEnv
): Record<string, OpenRouterModelSettings & { maxTokens?: number }> {
  const raw = env[OPENROUTER_MODELS_ENV]?.trim()
  if (!raw) return {}

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error(`${OPENROUTER_MODELS_ENV} is not valid JSON`)
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${OPENROUTER_MODELS_ENV} must be a JSON object keyed by model id`)
  }

  const settings: Record<string, OpenRouterModelSettings & { maxTokens?: number }> = {}
  for (const [id, value] of Object.entries(parsed)) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new Error(`${OPENROUTER_MODELS_ENV} entry for ${id} must be an object`)
    }
    const entry = value as Record<string, unknown>
    for (const key of Object.keys(entry)) {
      if (!OPENROUTER_SETTINGS_KEYS.includes(key)) {
        throw new Error(`${OPENROUTER_MODELS_ENV} entry for ${id} has unknown key "${key}"`)
      }
    }
    for (const key of ["provider", "reasoning"] as const) {
      const field = entry[key]
      if (field === undefined) continue
      if (typeof field !== "object" || field === null || Array.isArray(field)) {
        throw new Error(`${OPENROUTER_MODELS_ENV} entry for ${id} has a non-object "${key}"`)
      }
    }
    const maxTokens = entry.maxTokens
    if (maxTokens !== undefined && (typeof maxTokens !== "number" || maxTokens <= 0)) {
      throw new Error(`${OPENROUTER_MODELS_ENV} entry for ${id} has an invalid "maxTokens"`)
    }
    settings[id] = entry as OpenRouterModelSettings & { maxTokens?: number }
  }
  return settings
}

function readLocalMaxTokens(env: NodeJS.ProcessEnv): number {
  const parsed = Number.parseInt(env.MEMORYBENCH_LOCAL_MAX_TOKENS ?? "", 10)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : DEFAULT_LOCAL_MAX_TOKENS
}

export function getModelConfig(alias: string, env: NodeJS.ProcessEnv = process.env): ModelConfig {
  const lowerAlias = alias.toLowerCase()

  if (lowerAlias.startsWith(LOCAL_PREFIX)) {
    const id = alias.slice(LOCAL_PREFIX.length)
    if (!id) throw new Error(`Local model alias ${alias} is missing a model id`)
    const reasoningEffort = env.MEMORYBENCH_LOCAL_REASONING_EFFORT?.trim()
    const budget = Number.parseInt(env.MEMORYBENCH_LOCAL_THINKING_BUDGET ?? "", 10)
    const thinkingBudgetTokens = Number.isInteger(budget) && budget > 0 ? budget : undefined
    return {
      id,
      provider: "local",
      displayName: reasoningEffort
        ? `${id} (local, reasoning ${reasoningEffort})`
        : `${id} (local)`,
      supportsTemperature: false,
      defaultTemperature: 1,
      maxTokensParam: "maxTokens",
      defaultMaxTokens: readLocalMaxTokens(env),
      ...(reasoningEffort ? { reasoningEffort } : {}),
      ...(thinkingBudgetTokens ? { thinkingBudgetTokens } : {}),
    }
  }

  if (lowerAlias.startsWith(OPENROUTER_PREFIX)) {
    const id = alias.slice(OPENROUTER_PREFIX.length)
    if (!id) throw new Error(`OpenRouter model alias ${alias} is missing a model id`)
    const settings = readOpenRouterModelSettings(env)[id]
    return {
      id,
      provider: "openrouter",
      displayName: `${id} (openrouter)`,
      supportsTemperature: true,
      defaultTemperature: 0,
      maxTokensParam: "maxTokens",
      defaultMaxTokens: settings?.maxTokens ?? DEFAULT_OPENROUTER_MAX_TOKENS,
      ...(settings
        ? {
            openrouterSettings: {
              ...(settings.provider ? { provider: settings.provider } : {}),
              ...(settings.reasoning ? { reasoning: settings.reasoning } : {}),
            },
          }
        : {}),
    }
  }

  if (MODEL_CONFIGS[lowerAlias]) {
    return MODEL_CONFIGS[lowerAlias]
  }
  if (
    lowerAlias.startsWith("gpt-5") ||
    lowerAlias.startsWith("o1") ||
    lowerAlias.startsWith("o3") ||
    lowerAlias.startsWith("o4") ||
    lowerAlias.endsWith(".gguf") ||
    lowerAlias.includes("gemma-4") ||
    lowerAlias.includes("inception/mercury")
  ) {
    return {
      id: alias,
      provider: "openai",
      displayName: alias,
      supportsTemperature: false,
      defaultTemperature: 1,
      maxTokensParam: "max_completion_tokens",
      defaultMaxTokens: 1000,
    }
  }
  if (lowerAlias.startsWith("gpt-")) {
    return {
      id: alias,
      provider: "openai",
      displayName: alias,
      supportsTemperature: true,
      defaultTemperature: 0,
      maxTokensParam: "maxTokens",
      defaultMaxTokens: 1000,
    }
  }
  if (lowerAlias.startsWith("glm-")) {
    return {
      id: alias,
      provider: "zai",
      displayName: alias,
      supportsTemperature: true,
      defaultTemperature: 0,
      maxTokensParam: "maxTokens",
      defaultMaxTokens: 1000,
      thinking: "disabled",
    }
  }
  if (lowerAlias.startsWith("claude-")) {
    return {
      id: alias,
      provider: "anthropic",
      displayName: alias,
      supportsTemperature: true,
      defaultTemperature: 0,
      maxTokensParam: "maxTokens",
      defaultMaxTokens: 1000,
    }
  }
  if (lowerAlias.startsWith("gemini-3")) {
    return {
      id: alias,
      provider: "google",
      displayName: alias,
      supportsTemperature: true,
      defaultTemperature: 1,
      maxTokensParam: "maxTokens",
      defaultMaxTokens: 1000,
    }
  }
  if (lowerAlias.startsWith("gemini-")) {
    return {
      id: alias,
      provider: "google",
      displayName: alias,
      supportsTemperature: true,
      defaultTemperature: 0,
      maxTokensParam: "maxTokens",
      defaultMaxTokens: 1000,
    }
  }
  return {
    id: alias,
    provider: "openai",
    displayName: alias,
    supportsTemperature: true,
    defaultTemperature: 0,
    maxTokensParam: "maxTokens",
    defaultMaxTokens: 1000,
  }
}
export const MODEL_ALIASES = MODEL_CONFIGS

export function resolveModel(alias: string): ModelConfig {
  return getModelConfig(alias)
}

export function openRouterModelSettings(
  aliases: string[],
  env: NodeJS.ProcessEnv = process.env
): Record<string, OpenRouterModelSettings> {
  const used: Record<string, OpenRouterModelSettings> = {}
  for (const alias of aliases) {
    const settings = getModelConfig(alias, env).openrouterSettings
    if (settings && Object.keys(settings).length > 0) used[alias] = settings
  }
  return used
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
  return Object.entries(MODEL_CONFIGS)
    .filter(([_, config]) => config.provider === provider)
    .map(([alias]) => alias)
}

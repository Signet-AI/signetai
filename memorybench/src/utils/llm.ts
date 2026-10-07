import { createAnthropic } from "@ai-sdk/anthropic"
import { createGoogleGenerativeAI } from "@ai-sdk/google"
import { createOpenAICompatible } from "@ai-sdk/openai-compatible"
import { generateText, type LanguageModel, type LanguageModelUsage } from "ai"
import { config, createConfiguredOpenAI } from "./config"
import type { ModelConfig, ModelProvider } from "./models"

export interface ModelUsage {
  requests: number
  unreportedRequests: number
  inputTokens: number
  outputTokens: number
  reasoningTokens: number
  cachedInputTokens: number
}

export interface GenerateOptions {
  system?: string
  maxOutputTokens?: number
}

export interface GenerateResult {
  text: string
  usage: ModelUsage
}

const CREDENTIAL_ENV: Record<ModelProvider, string> = {
  openai: "OPENAI_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
  google: "GOOGLE_API_KEY",
  zai: "ZAI_API_KEY",
}

export function emptyUsage(): ModelUsage {
  return {
    requests: 0,
    unreportedRequests: 0,
    inputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    cachedInputTokens: 0,
  }
}

export function addUsage(target: ModelUsage, source: ModelUsage | undefined): ModelUsage {
  if (!source) return target
  target.requests += source.requests
  target.unreportedRequests += source.unreportedRequests
  target.inputTokens += source.inputTokens
  target.outputTokens += source.outputTokens
  target.reasoningTokens += source.reasoningTokens
  target.cachedInputTokens += source.cachedInputTokens
  return target
}

export function usageFromSdk(usage: LanguageModelUsage | undefined): ModelUsage {
  const reported = usage?.inputTokens != null && usage.outputTokens != null
  return {
    requests: 1,
    unreportedRequests: reported ? 0 : 1,
    inputTokens: usage?.inputTokens ?? 0,
    outputTokens: usage?.outputTokens ?? 0,
    reasoningTokens: usage?.reasoningTokens ?? 0,
    cachedInputTokens: usage?.cachedInputTokens ?? 0,
  }
}

function credential(provider: ModelProvider): string {
  switch (provider) {
    case "openai":
      return config.openaiApiKey
    case "anthropic":
      return config.anthropicApiKey
    case "google":
      return config.googleApiKey
    case "zai":
      return config.zaiApiKey
  }
}

export function assertModelCredentials(modelConfig: ModelConfig): void {
  if (!credential(modelConfig.provider).trim()) {
    throw new Error(
      `${modelConfig.displayName} requires ${CREDENTIAL_ENV[modelConfig.provider]} to be set`
    )
  }
}

export function getLanguageModel(modelConfig: ModelConfig): LanguageModel {
  switch (modelConfig.provider) {
    case "openai":
      return createConfiguredOpenAI(config.openaiApiKey)(modelConfig.id)
    case "anthropic":
      return createAnthropic({ apiKey: config.anthropicApiKey })(modelConfig.id)
    case "google":
      return createGoogleGenerativeAI({ apiKey: config.googleApiKey })(modelConfig.id)
    case "zai":
      return createOpenAICompatible({
        name: "zai",
        apiKey: config.zaiApiKey,
        baseURL: config.zaiBaseUrl,
      }).chatModel(modelConfig.id)
  }
}

export async function generateWithModel(
  modelConfig: ModelConfig,
  prompt: string,
  options: GenerateOptions = {}
): Promise<GenerateResult> {
  const result = await generateText({
    model: getLanguageModel(modelConfig),
    prompt,
    ...(options.system ? { system: options.system } : {}),
    maxOutputTokens: options.maxOutputTokens ?? modelConfig.defaultMaxTokens,
    ...(modelConfig.supportsTemperature ? { temperature: modelConfig.defaultTemperature } : {}),
    ...(modelConfig.thinking
      ? {
          providerOptions: { [modelConfig.provider]: { thinking: { type: modelConfig.thinking } } },
        }
      : {}),
  })
  return { text: result.text, usage: usageFromSdk(result.usage) }
}

export function estimateCostUsd(modelConfig: ModelConfig, usage: ModelUsage): number | undefined {
  const pricing = modelConfig.pricing
  if (!pricing || usage.unreportedRequests > 0) return undefined
  const cached = pricing.cachedInputPerMillion === undefined ? 0 : usage.cachedInputTokens
  const uncached = usage.inputTokens - cached
  return (
    (uncached * pricing.inputPerMillion +
      cached * (pricing.cachedInputPerMillion ?? pricing.inputPerMillion) +
      usage.outputTokens * pricing.outputPerMillion) /
    1_000_000
  )
}

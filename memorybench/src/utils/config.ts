import { createOpenAI, type OpenAIProviderSettings } from "@ai-sdk/openai"

export interface Config {
  supermemoryApiKey: string
  supermemoryBaseUrl: string
  mem0ApiKey: string
  zepApiKey: string
  signetBaseUrl: string
  openaiApiKey: string
  openaiBaseUrl: string
  anthropicApiKey: string
  googleApiKey: string
}

export const config: Config = {
  supermemoryApiKey: process.env.SUPERMEMORY_API_KEY || "",
  supermemoryBaseUrl: process.env.SUPERMEMORY_BASE_URL || "https://api.supermemory.ai",
  mem0ApiKey: process.env.MEM0_API_KEY || "",
  zepApiKey: process.env.ZEP_API_KEY || "",
  signetBaseUrl: process.env.SIGNET_BENCH_DAEMON_URL || process.env.SIGNET_BASE_URL || "",
  openaiApiKey: process.env.OPENAI_API_KEY || "",
  openaiBaseUrl: process.env.OPENAI_BASE_URL || "",
  anthropicApiKey: process.env.ANTHROPIC_API_KEY || "",
  googleApiKey: process.env.GOOGLE_API_KEY || "",
}

function openRouterHeaders(baseUrl: string): Record<string, string> | undefined {
  if (!baseUrl.toLowerCase().includes("openrouter.ai")) return undefined

  const headers: Record<string, string> = {}
  const referer = process.env.OPENROUTER_HTTP_REFERER || process.env.OPENROUTER_SITE_URL
  const title = process.env.OPENROUTER_APP_NAME || "Signet MemoryBench"
  if (referer) headers["HTTP-Referer"] = referer
  if (title) headers["X-Title"] = title
  return Object.keys(headers).length > 0 ? headers : undefined
}

export function createConfiguredOpenAI(apiKey: string): ReturnType<typeof createOpenAI> {
  const baseURL = config.openaiBaseUrl.trim()
  const options: OpenAIProviderSettings = { apiKey }
  if (baseURL) {
    options.baseURL = baseURL
    const headers = openRouterHeaders(baseURL)
    if (headers) options.headers = headers
  }
  return createOpenAI(options)
}

export function getProviderConfig(provider: string): { apiKey: string; baseUrl?: string } {
  switch (provider) {
    case "supermemory":
      return { apiKey: config.supermemoryApiKey, baseUrl: config.supermemoryBaseUrl }
    case "mem0":
      return { apiKey: config.mem0ApiKey }
    case "zep":
      return { apiKey: config.zepApiKey }
    case "filesystem":
      return { apiKey: config.openaiApiKey } // Filesystem uses OpenAI for memory extraction
    case "rag":
      return { apiKey: config.openaiApiKey } // RAG provider uses OpenAI for embeddings
    case "signet":
    case "signet-supermemory-parity":
      return { apiKey: config.openaiApiKey, baseUrl: config.signetBaseUrl }
    default:
      throw new Error(`Unknown provider: ${provider}`)
  }
}

export function getJudgeConfig(judge: string): { apiKey: string; model?: string } {
  switch (judge) {
    case "openai":
      return { apiKey: config.openaiApiKey }
    case "anthropic":
      return { apiKey: config.anthropicApiKey }
    case "google":
      return { apiKey: config.googleApiKey }
    default:
      throw new Error(`Unknown judge: ${judge}`)
  }
}

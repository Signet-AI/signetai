import type {
  Provider,
  ProviderConfig,
  IngestOptions,
  IngestResult,
  SearchOptions,
  IndexingProgressCallback,
} from "../../types/provider"
import type { UnifiedSession } from "../../types/unified"
import { logger } from "../../utils/logger"
import { SIGNET_PROMPTS } from "./prompts"

const DEFAULT_AGENT_ID = "memorybench"
const DEFAULT_PROJECT = "memorybench"
const DEFAULT_TIMEOUT_MS = 60_000

interface SignetRecallResponse {
  results?: unknown[]
  error?: string
}

interface SignetRememberResponse {
  id?: string
  ids?: string[]
  chunked?: boolean
  error?: string
}

function trimTrailingSlash(value: string): string {
  return value.endsWith("/") ? value.slice(0, -1) : value
}

function readPositiveInt(name: string, fallback: number): number {
  const parsed = Number.parseInt(process.env[name] ?? "", 10)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback
}

function formatSession(session: UnifiedSession): string {
  const date =
    (session.metadata?.formattedDate as string | undefined) ||
    (session.metadata?.date as string | undefined) ||
    "Unknown date"

  const body = session.messages
    .map((message) => {
      const speaker = message.speaker ? `${message.speaker} ` : ""
      return `${speaker}${message.role}: ${message.content}`
    })
    .join("\n\n")

  return [`# MemoryBench Session ${session.sessionId}`, `Date: ${date}`, "", body].join("\n")
}

async function parseJson<T>(response: Response): Promise<T> {
  const text = await response.text()
  if (!text.trim()) return {} as T
  try {
    return JSON.parse(text) as T
  } catch {
    throw new Error(`Invalid JSON response (${response.status}): ${text.slice(0, 500)}`)
  }
}

/**
 * Signet daemon provider.
 *
 * This adapter deliberately uses the public daemon HTTP API instead of reaching
 * into MemoryBench scoring or Signet internals. The benchmark harness still owns
 * datasets, answer generation, judging, checkpointing, and reports.
 */
export class SignetProvider implements Provider {
  name = "signet"
  prompts = SIGNET_PROMPTS
  concurrency = {
    default: 8,
    ingest: 2,
    search: 8,
  }

  private baseUrl = ""
  private agentId = process.env.SIGNET_BENCH_AGENT_ID || DEFAULT_AGENT_ID
  private project = process.env.SIGNET_BENCH_PROJECT || DEFAULT_PROJECT
  private timeoutMs = readPositiveInt("SIGNET_BENCH_REQUEST_TIMEOUT_MS", DEFAULT_TIMEOUT_MS)

  async initialize(config: ProviderConfig): Promise<void> {
    const baseUrl = typeof config.baseUrl === "string" ? config.baseUrl.trim() : ""
    if (!baseUrl) {
      throw new Error(
        "Signet provider requires SIGNET_BENCH_DAEMON_URL or SIGNET_BASE_URL. Use `bun run bench` to start an isolated daemon automatically."
      )
    }

    this.baseUrl = trimTrailingSlash(baseUrl)
    const health = await this.request<{ status?: string; agentsDir?: string }>("/health", {
      method: "GET",
    })
    if (health.status !== "healthy") {
      throw new Error(`Signet daemon is not healthy: ${JSON.stringify(health)}`)
    }

    logger.info(
      `Initialized Signet provider (${this.baseUrl}, agent=${this.agentId}, workspace=${health.agentsDir || "unknown"})`
    )
  }

  async ingest(sessions: UnifiedSession[], options: IngestOptions): Promise<IngestResult> {
    const documentIds: string[] = []

    for (const session of sessions) {
      const sourceId = `${options.containerTag}:${session.sessionId}`
      const result = await this.request<SignetRememberResponse>("/api/memory/remember", {
        method: "POST",
        body: JSON.stringify({
          content: formatSession(session),
          who: "memorybench",
          project: this.project,
          importance: 0.5,
          tags: `memorybench,${options.containerTag},${session.sessionId}`,
          sourceType: "memorybench-session",
          sourceId,
          scope: options.containerTag,
          agentId: this.agentId,
          visibility: "global",
        }),
      })

      if (result.error) {
        throw new Error(`Signet remember failed for ${session.sessionId}: ${result.error}`)
      }

      if (Array.isArray(result.ids)) {
        documentIds.push(...result.ids)
      } else if (typeof result.id === "string") {
        documentIds.push(result.id)
      }
    }

    return { documentIds }
  }

  async awaitIndexing(
    result: IngestResult,
    _containerTag: string,
    onProgress?: IndexingProgressCallback
  ): Promise<void> {
    // /api/memory/remember does the synchronous write before returning. Embedding
    // availability is reported per saved memory by the daemon and falls back to
    // keyword recall if vectors are unavailable, so there is no provider-side
    // async indexing job to wait on here.
    onProgress?.({
      completedIds: result.documentIds,
      failedIds: [],
      total: result.documentIds.length,
    })
  }

  async search(query: string, options: SearchOptions): Promise<unknown[]> {
    const response = await this.request<SignetRecallResponse>("/api/memory/recall", {
      method: "POST",
      body: JSON.stringify({
        query,
        limit: options.limit || 10,
        scope: options.containerTag,
        agentId: this.agentId,
        project: this.project,
      }),
    })

    if (response.error) {
      throw new Error(`Signet recall failed: ${response.error}`)
    }

    return Array.isArray(response.results) ? response.results : []
  }

  async clear(containerTag: string): Promise<void> {
    logger.info(
      `Signet provider clear skipped for ${containerTag}; isolated daemon workspace owns cleanup`
    )
  }

  private async request<T>(path: string, init: RequestInit): Promise<T> {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs)

    try {
      const response = await fetch(`${this.baseUrl}${path}`, {
        ...init,
        signal: controller.signal,
        headers: {
          "Content-Type": "application/json",
          ...(init.headers || {}),
        },
      })
      const data = await parseJson<T>(response)
      if (!response.ok) {
        const error =
          data && typeof data === "object" && "error" in data
            ? String(data.error)
            : response.statusText
        throw new Error(`${path} failed (${response.status}): ${error}`)
      }
      return data
    } finally {
      clearTimeout(timeout)
    }
  }
}

export default SignetProvider

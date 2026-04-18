import { createOpenAI } from "@ai-sdk/openai"
import { extractStructuredMemories } from "../../prompts/extraction"
import type {
  IndexingProgressCallback,
  IngestOptions,
  IngestResult,
  Provider,
  ProviderConfig,
  SearchOptions,
} from "../../types/provider"
import type { UnifiedSession } from "../../types/unified"
import { logger } from "../../utils/logger"
import { SIGNET_PROMPTS } from "./prompts"

const DEFAULT_AGENT_ID = "memorybench"
const DEFAULT_PROJECT = "memorybench"
const DEFAULT_TIMEOUT_MS = 60_000

interface SignetRecallResult {
  id?: string
  content?: string
  truncated?: boolean
  source?: string
  [key: string]: unknown
}

interface SignetRecallResponse {
  results?: SignetRecallResult[]
  error?: string
}

interface SignetRememberResponse {
  id?: string
  ids?: string[]
  chunked?: boolean
  embedded?: boolean
  error?: string
}

function trimTrailingSlash(value: string): string {
  return value.endsWith("/") ? value.slice(0, -1) : value
}

function readPositiveInt(name: string, fallback: number): number {
  const parsed = Number.parseInt(process.env[name] ?? "", 10)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback
}

function formatTranscript(session: UnifiedSession): string {
  const date =
    (session.metadata?.formattedDate as string | undefined) ||
    (session.metadata?.date as string | undefined) ||
    ""
  const raw = session.messages.map((m) => `${m.speaker || m.role}: ${m.content}`).join("\n")
  return date ? `[${date}]\n${raw}` : raw
}

function hasStructuredData(result: Awaited<ReturnType<typeof extractStructuredMemories>>): boolean {
  return (
    result.structured.entities.length > 0 ||
    result.structured.hints.length > 0 ||
    (result.structured.aspects?.length ?? 0) > 0
  )
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
 * The adapter keeps MemoryBench's scoring and judging intact, but uses the full
 * remember endpoint surface: extracted memory content, structured entities /
 * aspects / attributes / hints, scoped metadata, and lossless transcripts.
 */
export class SignetProvider implements Provider {
  name = "signet"
  prompts = SIGNET_PROMPTS
  concurrency = { default: 10, ingest: 5, search: 8 }

  private baseUrl = ""
  private openai: ReturnType<typeof createOpenAI> | null = null
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
    if (!config.apiKey || config.apiKey === "none") {
      throw new Error("Signet provider requires OPENAI_API_KEY for structured extraction")
    }

    this.baseUrl = trimTrailingSlash(baseUrl)
    this.openai = createOpenAI({ apiKey: config.apiKey })

    const health = await this.request<{ status?: string; agentsDir?: string; version?: string }>(
      "/health",
      { method: "GET" }
    )
    if (health.status !== "healthy") {
      throw new Error(`Signet daemon is not healthy: ${JSON.stringify(health)}`)
    }

    logger.info(
      `Initialized Signet provider (${this.baseUrl}, agent=${this.agentId}, workspace=${health.agentsDir || "unknown"}, version=${health.version || "unknown"})`
    )
  }

  async ingest(sessions: UnifiedSession[], options: IngestOptions): Promise<IngestResult> {
    if (!this.openai) throw new Error("Provider not initialized")

    const ids: string[] = []
    const pending: string[] = []

    for (const session of sessions) {
      let extracted: Awaited<ReturnType<typeof extractStructuredMemories>>
      try {
        extracted = await extractStructuredMemories(this.openai, session)
      } catch (error) {
        logger.warn(`Structured extraction failed for session ${session.sessionId}: ${error}`)
        continue
      }

      const sourceId = `${options.containerTag}:${session.sessionId}`
      const transcript = formatTranscript(session)
      const structured = hasStructuredData(extracted) ? extracted.structured : undefined

      const result = await this.request<SignetRememberResponse>("/api/memory/remember", {
        method: "POST",
        body: JSON.stringify({
          content: extracted.content,
          who: "memorybench",
          project: this.project,
          importance: 0.6,
          tags: `memorybench,${options.containerTag},${session.sessionId},structured`,
          sourceType: "memorybench-session",
          sourceId,
          scope: options.containerTag,
          agentId: this.agentId,
          visibility: "global",
          transcript,
          hints: structured?.hints,
          structured,
        }),
      })

      if (result.error) {
        throw new Error(`Signet remember failed for ${session.sessionId}: ${result.error}`)
      }

      this.collectMemoryIds(result, ids, pending)
    }

    logger.debug(
      `Ingested ${sessions.length} session(s) as ${ids.length} structured Signet memories for ${options.containerTag}`
    )
    return { documentIds: ids, taskIds: pending.length > 0 ? pending : undefined }
  }

  async awaitIndexing(
    result: IngestResult,
    _containerTag: string,
    onProgress?: IndexingProgressCallback
  ): Promise<void> {
    if (!result.taskIds || result.taskIds.length === 0) {
      onProgress?.({
        completedIds: result.documentIds,
        failedIds: [],
        total: result.documentIds.length,
      })
      return
    }

    const remaining = new Set(result.taskIds)
    const completed = result.documentIds.filter((id) => !remaining.has(id))
    const failed: string[] = []
    let delay = 500

    for (let attempt = 0; attempt < 60 && remaining.size > 0; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, delay))

      for (const id of [...remaining]) {
        try {
          const memory = await this.request<{ embedding_model?: string }>(`/api/memory/${id}`, {
            method: "GET",
          })
          if (memory.embedding_model) {
            remaining.delete(id)
            completed.push(id)
          }
        } catch {
          remaining.delete(id)
          failed.push(id)
        }
      }

      onProgress?.({ completedIds: completed, failedIds: failed, total: result.documentIds.length })
      delay = Math.min(delay * 1.5, 5000)
    }

    if (remaining.size > 0) {
      logger.warn(`${remaining.size} Signet memories did not finish embedding within timeout`)
    }
  }

  async search(query: string, options: SearchOptions): Promise<unknown[]> {
    const response = await this.request<SignetRecallResponse>("/api/memory/recall", {
      method: "POST",
      body: JSON.stringify({
        query,
        limit: Math.max(options.limit || 10, 10),
        threshold: options.threshold || 0.3,
        scope: options.containerTag,
        agentId: this.agentId,
        project: this.project,
        expand: false,
      }),
    })

    if (response.error) {
      throw new Error(`Signet recall failed: ${response.error}`)
    }

    return response.results ?? []
  }

  async clear(containerTag: string): Promise<void> {
    logger.info(
      `Signet provider clear skipped for ${containerTag}; isolated daemon workspace owns cleanup`
    )
  }

  private collectMemoryIds(result: SignetRememberResponse, ids: string[], pending: string[]): void {
    const embedded = result.embedded === true
    if (typeof result.id === "string") {
      ids.push(result.id)
      if (!embedded) pending.push(result.id)
    }
    if (Array.isArray(result.ids)) {
      ids.push(...result.ids)
      if (!embedded) pending.push(...result.ids)
    }
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
            ? String((data as { error?: unknown }).error)
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

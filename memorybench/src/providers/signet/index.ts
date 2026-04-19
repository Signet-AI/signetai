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
import { createConfiguredOpenAI } from "../../utils/config"
import { logger } from "../../utils/logger"
import { SIGNET_PROMPTS, SIGNET_SUPERMEMORY_PARITY_PROMPTS } from "./prompts"

const DEFAULT_AGENT_ID = "memorybench"
const DEFAULT_PROJECT = "memorybench"
const DEFAULT_TIMEOUT_MS = 60_000
const STRICT_SEARCH_LIMIT = 10
const SUPERMEMORY_PARITY_SEARCH_LIMIT = 30
const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
] as const

export type SignetBenchmarkProfile = "structured" | "supermemory-parity"
type StructuredPayload = Awaited<ReturnType<typeof extractStructuredMemories>>["structured"]

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

function parseSessionDate(session: UnifiedSession): string | undefined {
  const raw = session.metadata?.date
  if (typeof raw !== "string" || raw.trim().length === 0) return undefined
  const date = new Date(raw)
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString()
}

function trimTrailingSlash(value: string): string {
  return value.endsWith("/") ? value.slice(0, -1) : value
}

function readPositiveInt(name: string, fallback: number): number {
  const parsed = Number.parseInt(process.env[name] ?? "", 10)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback
}

function parseQuestionDate(value?: string): Date | undefined {
  if (!value) return undefined
  const match = value.match(/^(\d{4})\/(\d{2})\/(\d{2})/)
  if (!match) return undefined

  const year = Number.parseInt(match[1] ?? "", 10)
  const month = Number.parseInt(match[2] ?? "", 10)
  const day = Number.parseInt(match[3] ?? "", 10)
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day))
    return undefined

  const date = new Date(Date.UTC(year, month - 1, day))
  return Number.isNaN(date.getTime()) ? undefined : date
}

function formatTemporalHintDate(date: Date): string {
  const day = date.getUTCDate()
  const month = MONTH_NAMES[date.getUTCMonth()]
  const year = date.getUTCFullYear()
  return `${day} ${month} ${year}; ${month} ${day}, ${year}; ${year}-${String(
    date.getUTCMonth() + 1
  ).padStart(2, "0")}-${String(day).padStart(2, "0")}`
}

export function buildSignetRecallQuery(query: string, questionDate?: string): string {
  const anchor = parseQuestionDate(questionDate)
  if (!anchor) return query

  const hints: string[] = []
  const weekMatch = query.match(
    /\b(?:about\s+)?(?:a\s+)?(\d+|one|two|three|four|five|six)\s+weeks?\s+ago\b/i
  )
  const wordNumbers: Record<string, number> = {
    one: 1,
    two: 2,
    three: 3,
    four: 4,
    five: 5,
    six: 6,
  }
  if (weekMatch) {
    const raw = (weekMatch[1] ?? "").toLowerCase()
    const weeks = wordNumbers[raw] ?? Number.parseInt(raw, 10)
    if (Number.isFinite(weeks) && weeks > 0) {
      const date = new Date(anchor)
      date.setUTCDate(date.getUTCDate() - weeks * 7)
      hints.push(`${weekMatch[0]} resolves near ${formatTemporalHintDate(date)}`)
    }
  }

  const monthMatch = query.match(
    /\b(?:about\s+)?(?:a|one|two|three|four|five|six)\s+months?\s+ago\b/i
  )
  if (monthMatch) {
    const raw = monthMatch[0].match(/\b(a|one|two|three|four|five|six)\b/i)?.[1]?.toLowerCase()
    const months = raw === "a" ? 1 : raw ? (wordNumbers[raw] ?? 1) : 1
    const date = new Date(anchor)
    date.setUTCMonth(date.getUTCMonth() - months)
    hints.push(`${monthMatch[0]} resolves near ${formatTemporalHintDate(date)}`)
  }

  return hints.length > 0 ? `${query}\nTemporal search hints: ${hints.join("; ")}` : query
}

function formatTranscript(session: UnifiedSession): string {
  const date =
    (session.metadata?.formattedDate as string | undefined) ||
    (session.metadata?.date as string | undefined) ||
    ""
  const raw = session.messages.map((m) => `${m.speaker || m.role}: ${m.content}`).join("\n")
  return date ? `[${date}]\n${raw}` : raw
}

export function formatSupermemoryParityContent(session: UnifiedSession): string {
  const formattedDate = session.metadata?.formattedDate as string | undefined
  const sessionStr = JSON.stringify(session.messages).replace(/</g, "&lt;").replace(/>/g, "&gt;")

  return formattedDate
    ? `Here is the date the following session took place: ${formattedDate}\n\nHere is the session as a stringified JSON:\n${sessionStr}`
    : `Here is the session as a stringified JSON:\n${sessionStr}`
}

export function resolveSignetSearchLimit(
  profile: SignetBenchmarkProfile,
  requested?: number
): number {
  if (profile === "supermemory-parity") return SUPERMEMORY_PARITY_SEARCH_LIMIT
  return requested && Number.isInteger(requested) && requested > 0 ? requested : STRICT_SEARCH_LIMIT
}

function hasStructuredData(result: Awaited<ReturnType<typeof extractStructuredMemories>>): boolean {
  return (
    result.structured.entities.length > 0 ||
    result.structured.hints.length > 0 ||
    (result.structured.aspects?.length ?? 0) > 0
  )
}

export function hasUsableMemoryContent(content: string): boolean {
  return content.trim().length > 0
}

function canonicalEntityName(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, " ")
}

function scopeBenchmarkParticipant(name: string, containerTag: string): string {
  const canonical = canonicalEntityName(name)
  if (canonical === "benchmark user") return `MemoryBench User ${containerTag}`
  if (canonical === "benchmark assistant") return `MemoryBench Assistant ${containerTag}`
  return name
}

export function scopeStructuredBenchmarkParticipants(
  structured: StructuredPayload,
  containerTag: string
): StructuredPayload {
  return {
    entities: structured.entities.map((entity) => ({
      ...entity,
      source: scopeBenchmarkParticipant(entity.source, containerTag),
      target: scopeBenchmarkParticipant(entity.target, containerTag),
    })),
    aspects: structured.aspects.map((aspect) => ({
      ...aspect,
      entityName: scopeBenchmarkParticipant(aspect.entityName, containerTag),
      attributes: aspect.attributes.map((attribute) => ({ ...attribute })),
    })),
    hints: [...structured.hints],
  }
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
  private profile: SignetBenchmarkProfile

  constructor(profile: SignetBenchmarkProfile = "structured") {
    this.profile = profile
    if (profile === "supermemory-parity") {
      this.name = "signet-supermemory-parity"
      this.prompts = SIGNET_SUPERMEMORY_PARITY_PROMPTS
    }
  }

  async initialize(config: ProviderConfig): Promise<void> {
    const baseUrl = typeof config.baseUrl === "string" ? config.baseUrl.trim() : ""
    if (!baseUrl) {
      throw new Error(
        "Signet provider requires SIGNET_BENCH_DAEMON_URL or SIGNET_BASE_URL. Use `bun run bench` to start an isolated daemon automatically."
      )
    }
    if (this.profile === "structured" && (!config.apiKey || config.apiKey === "none")) {
      throw new Error("Signet provider requires OPENAI_API_KEY for structured extraction")
    }

    this.baseUrl = trimTrailingSlash(baseUrl)
    this.openai =
      config.apiKey && config.apiKey !== "none" ? createConfiguredOpenAI(config.apiKey) : null

    const health = await this.request<{ status?: string; agentsDir?: string; version?: string }>(
      "/health",
      { method: "GET" }
    )
    if (health.status !== "healthy") {
      throw new Error(`Signet daemon is not healthy: ${JSON.stringify(health)}`)
    }

    logger.info(
      `Initialized Signet provider (${this.baseUrl}, profile=${this.profile}, agent=${this.agentId}, workspace=${health.agentsDir || "unknown"}, version=${health.version || "unknown"})`
    )
  }

  protected async extractStructured(
    session: UnifiedSession
  ): Promise<Awaited<ReturnType<typeof extractStructuredMemories>>> {
    if (!this.openai) throw new Error("Provider not initialized")
    return extractStructuredMemories(this.openai, session)
  }

  async ingest(sessions: UnifiedSession[], options: IngestOptions): Promise<IngestResult> {
    if (this.profile === "structured" && !this.openai) throw new Error("Provider not initialized")

    const ids: string[] = []
    const pending: string[] = []

    for (const session of sessions) {
      if (this.profile === "supermemory-parity") {
        const result = await this.rememberSession(session, options, {
          content: formatSupermemoryParityContent(session),
          tags: `memorybench,${options.containerTag},${session.sessionId},supermemory-parity,raw-session`,
          transcript: formatTranscript(session),
        })
        this.collectMemoryIds(result, ids, pending)
        continue
      }

      let extracted: Awaited<ReturnType<typeof extractStructuredMemories>>
      try {
        extracted = await this.extractStructured(session)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        throw new Error(`Structured extraction failed for session ${session.sessionId}: ${message}`)
      }

      if (!hasUsableMemoryContent(extracted.content)) {
        throw new Error(
          `Structured extraction produced empty content for session ${session.sessionId}`
        )
      }

      const structured = hasStructuredData(extracted)
        ? scopeStructuredBenchmarkParticipants(extracted.structured, options.containerTag)
        : undefined
      const result = await this.rememberSession(session, options, {
        content: extracted.content,
        tags: `memorybench,${options.containerTag},${session.sessionId},structured`,
        transcript: formatTranscript(session),
        hints: structured?.hints,
        structured,
      })
      this.collectMemoryIds(result, ids, pending)
    }

    logger.debug(
      `Ingested ${sessions.length} session(s) as ${ids.length} ${this.profile} Signet memories for ${options.containerTag}`
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
    const recallQuery = buildSignetRecallQuery(query, options.questionDate)
    const response = await this.request<SignetRecallResponse>("/api/memory/recall", {
      method: "POST",
      body: JSON.stringify({
        query: recallQuery,
        limit: resolveSignetSearchLimit(this.profile, options.limit),
        threshold: options.threshold || 0.3,
        scope: options.containerTag,
        agentId: this.agentId,
        project: this.project,
        // Use Signet's lossless expansion surface during benchmarks.
        // The daemon still ranks ordinary recall results first, but expanded
        // results may include transcript-backed excerpts for retrieved sessions.
        expand: true,
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

  private async rememberSession(
    session: UnifiedSession,
    options: IngestOptions,
    payload: {
      content: string
      tags: string
      transcript: string
      hints?: string[]
      structured?: Awaited<ReturnType<typeof extractStructuredMemories>>["structured"]
    }
  ): Promise<SignetRememberResponse> {
    if (!hasUsableMemoryContent(payload.content)) {
      throw new Error(`Signet remember skipped for ${session.sessionId}: content is empty`)
    }

    const result = await this.request<SignetRememberResponse>("/api/memory/remember", {
      method: "POST",
      body: JSON.stringify({
        content: payload.content,
        who: "memorybench",
        project: this.project,
        importance: 0.6,
        tags: payload.tags,
        sourceType: "memorybench-session",
        sourceId: `${options.containerTag}:${session.sessionId}`,
        createdAt: parseSessionDate(session),
        scope: options.containerTag,
        agentId: this.agentId,
        visibility: "global",
        transcript: payload.transcript,
        hints: payload.hints,
        structured: payload.structured,
      }),
    })

    if (result.error) {
      throw new Error(`Signet remember failed for ${session.sessionId}: ${result.error}`)
    }

    return result
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

export class SignetSupermemoryParityProvider extends SignetProvider {
  constructor() {
    super("supermemory-parity")
  }
}

export default SignetProvider

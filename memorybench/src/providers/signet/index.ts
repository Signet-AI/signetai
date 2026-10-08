import { EXTRACTION_MODEL, extractStructuredMemories } from "../../prompts/extraction"
import type {
  IndexingProgressCallback,
  IngestOptions,
  IngestResult,
  FinalizeIngestOptions,
  Provider,
  ProviderConfig,
  RecallEvidenceKind,
  SearchOptions,
} from "../../types/provider"
import type { UnifiedSession } from "../../types/unified"
import type { DreamingPassUsage, IngestUsage } from "../../types/checkpoint"
import { addUsage, assertModelCredentials, emptyUsage } from "../../utils/llm"
import { logger } from "../../utils/logger"
import { SIGNET_PROMPTS, SIGNET_SUPERMEMORY_PARITY_PROMPTS } from "./prompts"

const DEFAULT_AGENT_ID = "memorybench"
const DEFAULT_PROJECT = "memorybench"
const DEFAULT_TIMEOUT_MS = 60_000
const DREAM_STATUS_CONCURRENCY = 4
const STRICT_SEARCH_LIMIT = 10
const SUPERMEMORY_PARITY_SEARCH_LIMIT = 30
const WEEKDAY_NAMES = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"]
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

export type SignetBenchmarkProfile = "structured" | "dreaming" | "supermemory-parity"
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

interface SignetSessionEndResponse {
  transcriptCaptureJobId?: string
  error?: string
}

interface TranscriptCaptureJobResponse {
  status?: "pending" | "processing" | "completed" | "failed" | "dead"
  error?: string | null
}

interface DreamingTriggerResponse {
  passId?: string
  error?: string
}

interface DreamingStatusPass {
  id?: string
  status?: string
  error?: string | null
  tokensInput?: number | null
  tokensOutput?: number | null
  tokensCacheRead?: number | null
  mutationsApplied?: number | null
}

interface EmbeddingHealthResponse {
  checks?: Array<{ name?: string; detail?: { unembedded?: number } }>
}

interface DreamingStatusResponse {
  worker?: { running?: boolean; activePasses?: unknown[] }
  config?: { maxConcurrentPasses?: number }
  passes?: DreamingStatusPass[]
  episodicTokensPending?: number
}

function finiteOrNull(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null
}

export function observeDreamingPasses(
  target: Record<string, DreamingPassUsage>,
  passes: readonly DreamingStatusPass[] | undefined
): void {
  for (const pass of passes ?? []) {
    if (!pass.id || pass.status === "running") continue
    target[pass.id] = {
      inputTokens: finiteOrNull(pass.tokensInput),
      outputTokens: finiteOrNull(pass.tokensOutput),
      cacheReadTokens: finiteOrNull(pass.tokensCacheRead),
    }
  }
}

function passHadNothingToDo(pass: DreamingStatusPass): boolean {
  return pass.status === "completed" && (pass.mutationsApplied ?? 0) === 0 && !((pass.tokensInput ?? 0) > 0)
}

const MAX_IDLE_DREAMING_PASSES = 3
const MAX_FAILED_DREAMING_PASSES = 3

const RAW_EVIDENCE_ID_PREFIXES = ["source-chunk:", "native-artifact:", "transcript:"] as const

export function classifySignetRecallResult(result: unknown): RecallEvidenceKind {
  const id =
    typeof result === "object" && result !== null && "id" in result ? result.id : undefined
  return typeof id === "string" && RAW_EVIDENCE_ID_PREFIXES.some((prefix) => id.startsWith(prefix))
    ? "raw-evidence"
    : "derived"
}

export function haystackAgentId(containerTag: string): string {
  const agentId = `memorybench-${containerTag}`
  if (!/^[A-Za-z0-9._:-]+$/.test(agentId)) {
    throw new Error(`Container tag ${containerTag} cannot form a Signet agent id`)
  }
  return agentId
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
    seven: 7,
    eight: 8,
    nine: 9,
    ten: 10,
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

  const dayMatch = query.match(/\b(\d+|one|two|three|four|five|six|seven|eight|nine|ten)\s+days?\s+ago\b/i)
  if (dayMatch) {
    const raw = (dayMatch[1] ?? "").toLowerCase()
    const days = wordNumbers[raw] ?? Number.parseInt(raw, 10)
    if (Number.isFinite(days) && days > 0) {
      const date = new Date(anchor)
      date.setUTCDate(date.getUTCDate() - days)
      hints.push(`${dayMatch[0]} resolves near ${formatTemporalHintDate(date)}`)
    }
  }

  const weekdayMatch = query.match(/\blast\s+(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/i)
  if (weekdayMatch) {
    const target = WEEKDAY_NAMES.indexOf((weekdayMatch[1] ?? "").toLowerCase())
    const date = new Date(anchor)
    const back = (date.getUTCDay() - target + 7) % 7 || 7
    date.setUTCDate(date.getUTCDate() - back)
    hints.push(`${weekdayMatch[0]} resolves near ${formatTemporalHintDate(date)}`)
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
export class SignetProvider implements Provider {
  name = "signet"
  prompts = SIGNET_PROMPTS
  concurrency = { default: 10, ingest: 5, search: 8 }

  private baseUrl = ""
  private readonly extractionUsage = emptyUsage()
  private readonly dreamingPasses: Record<string, DreamingPassUsage> = {}
  private readonly isolatedAgents = new Set<string>()
  private agentId = process.env.SIGNET_BENCH_AGENT_ID || DEFAULT_AGENT_ID
  private project = process.env.SIGNET_BENCH_PROJECT || DEFAULT_PROJECT
  private timeoutMs = readPositiveInt("SIGNET_BENCH_REQUEST_TIMEOUT_MS", DEFAULT_TIMEOUT_MS)
  private profile: SignetBenchmarkProfile
  private readonly dreamingAgentIds = new Set<string>()

  constructor(profile: SignetBenchmarkProfile = "structured") {
    this.profile = profile
    if (profile === "dreaming") {
      this.name = "signet-dreaming"
    } else if (profile === "supermemory-parity") {
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
    if (this.profile === "structured") assertModelCredentials(EXTRACTION_MODEL)

    this.baseUrl = trimTrailingSlash(baseUrl)

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
    const extracted = await extractStructuredMemories(session)
    addUsage(this.extractionUsage, extracted.usage)
    return extracted
  }

  classifyResult(result: unknown): RecallEvidenceKind {
    return classifySignetRecallResult(result)
  }

  getIngestUsage(): IngestUsage {
    return {
      harness: addUsage(emptyUsage(), this.extractionUsage),
      ...(Object.keys(this.dreamingPasses).length > 0
        ? { dreamingPasses: { ...this.dreamingPasses } }
        : {}),
    }
  }

  private async ensureIsolatedAgent(agentId: string): Promise<void> {
    if (this.isolatedAgents.has(agentId)) return
    try {
      await this.request(`/api/agents/${encodeURIComponent(agentId)}`, {
        method: "PATCH",
        body: JSON.stringify({ read_policy: "isolated" }),
      })
    } catch (error) {
      if (!(error instanceof Error) || !error.message.includes("failed (404)")) throw error
      await this.request("/api/agents", {
        method: "POST",
        body: JSON.stringify({ name: agentId, read_policy: "isolated" }),
      })
    }
    this.isolatedAgents.add(agentId)
  }

  private async readDreamStatuses(scopes: readonly string[], measure = false): Promise<DreamingStatusResponse[]> {
    const statuses: DreamingStatusResponse[] = new Array(scopes.length)
    let next = 0
    const worker = async (): Promise<void> => {
      while (next < scopes.length) {
        const index = next++
        statuses[index] = await this.readDreamStatus(scopes[index]!, measure)
      }
    }
    await Promise.all(Array.from({ length: Math.min(DREAM_STATUS_CONCURRENCY, scopes.length) }, worker))
    return statuses
  }

  private async readDreamStatus(agentId: string, measure = false): Promise<DreamingStatusResponse> {
    const status = await this.request<DreamingStatusResponse>(
      `/api/dream/status?agentId=${encodeURIComponent(agentId)}${measure ? "&measure=1" : ""}`,
      { method: "GET" }
    )
    observeDreamingPasses(this.dreamingPasses, status.passes)
    return status
  }

  async ingest(sessions: UnifiedSession[], options: IngestOptions): Promise<IngestResult> {

    const ids: string[] = []
    const pending: string[] = []
    const taskAgentIds: Record<string, string> = {}

    for (const session of sessions) {
      if (this.profile === "dreaming") {
        const agentId = this.agentIdForSession(session, options.containerTag)
        await this.ensureIsolatedAgent(agentId)
        const capture = await this.captureDreamingSession(session, options, agentId)
        if (!capture.transcriptCaptureJobId) {
          throw new Error(
            `Canonical transcript capture was not queued for session ${session.sessionId}`
          )
        }
        ids.push(this.benchmarkSessionId(session, options.containerTag))
        pending.push(capture.transcriptCaptureJobId)
        taskAgentIds[capture.transcriptCaptureJobId] = agentId
        this.dreamingAgentIds.add(agentId)
        continue
      }
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
      `Ingested ${sessions.length} session(s) as ${ids.length} ${this.profile} Signet inputs for ${options.containerTag}`
    )
    return {
      documentIds: ids,
      taskIds: pending.length > 0 ? pending : undefined,
      taskAgentIds: pending.length > 0 ? taskAgentIds : undefined,
    }
  }

  async awaitIndexing(
    result: IngestResult,
    _containerTag: string,
    onProgress?: IndexingProgressCallback
  ): Promise<void> {
    if (this.profile === "dreaming") {
      await this.awaitTranscriptCapture(result, onProgress)
      return
    }
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
    const agentId =
      options.agentId ??
      (this.profile === "dreaming" ? haystackAgentId(options.containerTag) : this.agentId)
    if (this.profile === "dreaming") await this.ensureIsolatedAgent(agentId)
    const response = await this.request<SignetRecallResponse>("/api/memory/recall", {
      method: "POST",
      body: JSON.stringify({
        query: recallQuery,
        limit: resolveSignetSearchLimit(this.profile, options.limit),
        threshold: options.threshold || 0.3,
        agentId,
        ...(this.profile === "dreaming"
          ? {}
          : { scope: options.containerTag, project: this.project }),
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
  async finalizeIngest(options: FinalizeIngestOptions): Promise<void> {
    if (this.profile !== "dreaming") return
    const ingested = new Set([...this.dreamingAgentIds, ...(options.agentIds ?? [])])
    const scopes = ingested.size > 0 ? [...ingested] : [this.agentId]
    const readyDeadline = Date.now() + 60_000
    let workerReady = false
    while (Date.now() < readyDeadline) {
      const statuses = await this.readDreamStatuses(scopes)
      if (statuses.every((status) => status.worker?.running)) {
        workerReady = true
        break
      }
      await new Promise((resolve) => setTimeout(resolve, 1_000))
    }
    if (!workerReady) throw new Error("Dreaming worker did not become ready after ingestion")

    const deadline = Date.now() + readPositiveInt("SIGNET_BENCH_DREAMING_WAIT_SECS", 720) * 1000
    const pollMs = Math.min(readPositiveInt("SIGNET_BENCH_DREAMING_POLL_SECS", 1), 5) * 1000
    const settled = new Set(
      ((await this.readDreamStatus(this.agentId)).passes ?? []).flatMap((pass) =>
        pass.id && pass.status !== "running" ? [pass.id] : []
      )
    )
    let idlePasses = 0
    let failedPasses = 0
    let emptyTriggers = 0
    let measured = false
    let holdTriggers = false
    await this.triggerDreaming()
    while (Date.now() < deadline) {
      const primary = await this.readDreamStatus(this.agentId)
      const slots = Math.max(1, Math.floor(primary.config?.maxConcurrentPasses ?? 1))
      const finished = (primary.passes ?? []).filter(
        (pass): pass is DreamingStatusPass & { id: string } =>
          typeof pass.id === "string" && pass.status !== "running" && !settled.has(pass.id)
      )
      for (const pass of finished) {
        settled.add(pass.id)
        if (pass.status !== "completed") {
          failedPasses++
          const failure = `Dreaming pass ${pass.id} ${pass.status || "failed"}: ${pass.error || "no detail"}`
          if (failedPasses >= MAX_FAILED_DREAMING_PASSES * slots) {
            throw new Error(`${failure} (${failedPasses} consecutive failed passes)`)
          }
          logger.warn(`${failure}; retrying (${failedPasses}/${MAX_FAILED_DREAMING_PASSES * slots})`)
          continue
        }
        failedPasses = 0
        if (passHadNothingToDo(pass)) {
          holdTriggers = true
          continue
        }
        holdTriggers = false
        idlePasses = (pass.mutationsApplied ?? 0) > 0 ? 0 : idlePasses + 1
      }

      const active = primary.worker?.activePasses?.length ?? 0
      if (finished.length > 0 || active === 0 || !measured) {
        measured = true
        const statuses = await this.readDreamStatuses(scopes, true)
        if (statuses.every((status) => status.episodicTokensPending === 0)) {
          if (active === 0) {
            await this.awaitDerivedEmbeddings(pollMs)
            return
          }
        } else {
          if (idlePasses >= MAX_IDLE_DREAMING_PASSES * slots) {
            const backlog = statuses.map((status) => status.episodicTokensPending ?? "unmeasured").join(", ")
            throw new Error(
              `Dreaming applied no mutations in ${idlePasses} consecutive passes while the backlog was not drained (${backlog})`
            )
          }
          if (active < slots && (active === 0 || !holdTriggers)) {
            const started = await this.triggerDreaming()
            const onlyEmpty = finished.length > 0 && finished.every(passHadNothingToDo)
            if (active === 0 && (onlyEmpty || (!started && finished.length === 0))) {
              emptyTriggers++
              if (emptyTriggers >= MAX_IDLE_DREAMING_PASSES) {
                throw new Error(`Dreaming started no new passes in ${emptyTriggers} consecutive triggers`)
              }
            } else {
              emptyTriggers = 0
            }
          }
        }
      }
      await new Promise((resolve) => setTimeout(resolve, pollMs))
    }
    throw new Error("Timed out draining the Dreaming episodic backlog")
  }

  private async triggerDreaming(): Promise<boolean> {
    try {
      const accepted = await this.request<DreamingTriggerResponse>("/api/dream/trigger", {
        method: "POST",
        body: JSON.stringify({ mode: "incremental", agentId: this.agentId }),
      })
      if (!accepted.passId) throw new Error(`Dreaming trigger failed: ${accepted.error || "missing pass id"}`)
      return true
    } catch (error) {
      if (error instanceof Error && error.message.includes("/api/dream/trigger failed (409)")) return false
      throw error
    }
  }

  private async awaitDerivedEmbeddings(pollMs: number): Promise<void> {
    const deadline = Date.now() + readPositiveInt("SIGNET_BENCH_EMBEDDING_WAIT_SECS", 1800) * 1000
    const stallMs = 180_000
    let best = Number.POSITIVE_INFINITY
    let progressAt = Date.now()
    while (Date.now() < deadline) {
      const health = await this.request<EmbeddingHealthResponse>("/api/embeddings/health", { method: "GET" })
      const coverage = health.checks?.find((check) => check.name === "coverage")?.detail
      const unembedded = typeof coverage?.unembedded === "number" ? coverage.unembedded : null
      if (unembedded === null) {
        logger.warn("Signet embedding health did not report coverage; searching without waiting")
        return
      }
      if (unembedded === 0) return
      if (unembedded < best) {
        best = unembedded
        progressAt = Date.now()
      } else if (Date.now() - progressAt > stallMs) {
        logger.warn(`${unembedded} Signet memories are still unembedded and embedding has stalled; searching anyway`)
        return
      }
      await new Promise((resolve) => setTimeout(resolve, Math.max(pollMs, 5_000)))
    }
    logger.warn("Timed out waiting for Signet memory embeddings; searching anyway")
  }

  private agentIdForSession(session: UnifiedSession, containerTag: string): string {
    const declared = session.metadata?.agentId
    if (declared === undefined) return haystackAgentId(containerTag)
    if (typeof declared !== "string" || !/^[A-Za-z0-9._:-]+$/.test(declared)) {
      throw new Error(`Dreaming benchmark session ${session.sessionId} has an invalid agentId`)
    }
    return declared
  }

  private benchmarkSessionId(session: UnifiedSession, containerTag: string): string {
    return `memorybench:${containerTag}:${session.sessionId}`
  }

  private async captureDreamingSession(
    session: UnifiedSession,
    options: IngestOptions,
    agentId: string
  ): Promise<SignetSessionEndResponse> {
    const transcript = formatTranscript(session)
    if (!hasUsableMemoryContent(transcript)) {
      throw new Error(
        `Canonical transcript capture skipped for ${session.sessionId}: transcript is empty`
      )
    }
    const sessionId = this.benchmarkSessionId(session, options.containerTag)
    const result = await this.request<SignetSessionEndResponse>("/api/hooks/session-end", {
      method: "POST",
      body: JSON.stringify({
        harness: "memorybench",
        sessionId,
        sessionKey: sessionId,
        agentId,
        cwd: this.project,
        reason: "session_shutdown",
        transcript,
        capturedAt: parseSessionDate(session),
      }),
    })
    if (result.error) {
      throw new Error(
        `Canonical transcript capture failed for ${session.sessionId}: ${result.error}`
      )
    }
    return result
  }

  private async awaitTranscriptCapture(
    result: IngestResult,
    onProgress?: IndexingProgressCallback
  ): Promise<void> {
    const pending = new Set(result.taskIds ?? [])
    const completed: string[] = []
    const failed: string[] = []
    const waitSecs = readPositiveInt("SIGNET_BENCH_CAPTURE_WAIT_SECS", 1800)
    const deadline = Date.now() + waitSecs * 1000
    let delay = 100

    while (pending.size > 0 && Date.now() < deadline) {
      for (const id of [...pending]) {
        const agentId = result.taskAgentIds?.[id]
        if (!agentId) {
          throw new Error(
            `Canonical transcript capture ${id} is missing its fixture agent scope; resume requires a scope-preserving checkpoint`
          )
        }
        const job = await this.request<TranscriptCaptureJobResponse>(
          `/api/hooks/transcript-capture/${encodeURIComponent(id)}?agentId=${encodeURIComponent(agentId)}`,
          { method: "GET" }
        )
        if (job.status === "completed") {
          pending.delete(id)
          completed.push(id)
        } else if (job.status === "dead") {
          pending.delete(id)
          failed.push(id)
          throw new Error(`Transcript capture ${id} ${job.status}: ${job.error || "no detail"}`)
        }
      }
      onProgress?.({ completedIds: completed, failedIds: failed, total: result.documentIds.length })
      if (pending.size > 0) {
        await new Promise((resolve) => setTimeout(resolve, delay))
        delay = Math.min(Math.ceil(delay * 1.5), 1_000)
      }
    }

    if (pending.size > 0) {
      throw new Error(
        `Timed out after ${waitSecs}s waiting for ${pending.size} canonical transcript capture job(s); raise SIGNET_BENCH_CAPTURE_WAIT_SECS if the capture queue is still draining`
      )
    }
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

  protected async request<T>(path: string, init: RequestInit): Promise<T> {
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
export class SignetDreamingProvider extends SignetProvider {
  constructor() {
    super("dreaming")
  }
}

export default SignetProvider

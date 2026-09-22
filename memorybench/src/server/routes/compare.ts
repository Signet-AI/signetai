import { existsSync, readdirSync } from "fs"
import { CheckpointManager } from "../../orchestrator/checkpoint"
import { batchManager } from "../../orchestrator/batch"
import { getRunState } from "../runState"
import type { EventBroadcaster } from "../websocket"
import type { ProviderName } from "../../types/provider"
import type { BenchmarkName } from "../../types/benchmark"
import type { SamplingConfig } from "../../types/checkpoint"

const checkpointManager = new CheckpointManager()

const COMPARE_DIR = "./data/compare"
export type CompareState = {
  status: "running" | "stopping"
  startedAt: string
  benchmark?: string
  runIds: string[]
}

const activeCompares = new Map<string, CompareState>()

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  })
}

function requestStop(compareId: string): boolean {
  const state = activeCompares.get(compareId)
  if (!state) return false
  state.status = "stopping"
  return true
}

function startCompare(compareId: string, benchmark: string, runIds: string[]): void {
  activeCompares.set(compareId, {
    status: "running",
    startedAt: new Date().toISOString(),
    benchmark,
    runIds,
  })
}

function endCompare(compareId: string): void {
  activeCompares.delete(compareId)
}

function isCompareActive(compareId: string): boolean {
  return activeCompares.has(compareId)
}

function getCompareState(compareId: string): CompareState | undefined {
  return activeCompares.get(compareId)
}

export async function handleCompareRoutes(
  req: Request,
  url: URL,
  events: EventBroadcaster
): Promise<Response | null> {
  const method = req.method
  const pathname = url.pathname
  if (method === "GET" && pathname === "/api/compare") {
    if (!existsSync(COMPARE_DIR)) {
      return json([])
    }

    const compareIds = readdirSync(COMPARE_DIR, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort()

    const compareDetails = compareIds
      .map((compareId) => {
        const manifest = batchManager.loadManifest(compareId)
        if (!manifest) return null
        const runProgress = manifest.runs.map((run) => {
          const checkpoint = checkpointManager.load(run.runId)
          if (!checkpoint) {
            return {
              provider: run.provider,
              runId: run.runId,
              progress: { total: 0, evaluated: 0 },
              status: "pending",
            }
          }
          const summary = checkpointManager.getSummary(checkpoint)
          const status = getRunStatus(checkpoint, summary)
          return {
            provider: run.provider,
            runId: run.runId,
            progress: summary,
            status,
          }
        })
        const allCompleted = runProgress.every((r) => r.status === "completed")
        const anyFailed = runProgress.some((r) => r.status === "failed")
        const anyRunning = runProgress.some((r) => r.status === "running")
        const compareState = getCompareState(compareId)

        let overallStatus: string
        if (compareState?.status === "stopping") {
          overallStatus = "stopping"
        } else if (compareState?.status === "running" || anyRunning) {
          overallStatus = "running"
        } else if (anyFailed) {
          overallStatus = "failed"
        } else if (allCompleted) {
          overallStatus = "completed"
        } else {
          overallStatus = "partial"
        }

        return {
          compareId,
          benchmark: manifest.benchmark,
          judge: manifest.judge,
          answeringModel: manifest.answeringModel,
          createdAt: manifest.createdAt,
          updatedAt: manifest.updatedAt,
          targetQuestionCount: manifest.targetQuestionIds.length,
          providers: manifest.runs.map((r) => r.provider),
          status: overallStatus,
          runProgress,
        }
      })
      .filter(Boolean)
      .sort((a: any, b: any) => (b.createdAt || "").localeCompare(a.createdAt || ""))

    return json(compareDetails)
  }
  if (method === "POST" && pathname === "/api/compare/start") {
    try {
      const body = await req.json()
      const { providers, benchmark, judgeModel, answeringModel, sampling, force } = body

      if (!providers || !Array.isArray(providers) || providers.length === 0) {
        return json({ error: "Missing or invalid providers array" }, 400)
      }
      if (!benchmark || !judgeModel || !answeringModel) {
        return json(
          { error: "Missing required fields: benchmark, judgeModel, answeringModel" },
          400
        )
      }
      const { compareId } = await initializeComparison(
        {
          providers: providers as ProviderName[],
          benchmark: benchmark as BenchmarkName,
          judgeModel,
          answeringModel,
          sampling,
          force,
        },
        events
      )

      return json({ message: "Comparison started", compareId })
    } catch (e) {
      return json({ error: e instanceof Error ? e.message : "Invalid request body" }, 400)
    }
  }
  const compareIdMatch = pathname.match(/^\/api\/compare\/([^/]+)$/)
  if (method === "GET" && compareIdMatch) {
    const compareId = decodeURIComponent(compareIdMatch[1])
    const manifest = batchManager.loadManifest(compareId)
    if (!manifest) {
      return json({ error: "Comparison not found" }, 404)
    }
    const runDetails = manifest.runs.map((run) => {
      const checkpoint = checkpointManager.load(run.runId)
      if (!checkpoint) {
        return {
          provider: run.provider,
          runId: run.runId,
          status: "pending",
          summary: { total: 0, ingested: 0, indexed: 0, searched: 0, answered: 0, evaluated: 0 },
        }
      }

      const summary = checkpointManager.getSummary(checkpoint)
      const status = getRunStatus(checkpoint, summary)
      const questions = Object.values(checkpoint.questions)
      const evaluatedQuestions = questions.filter(
        (q: any) => q.phases?.evaluate?.status === "completed"
      )
      const correctCount = evaluatedQuestions.filter(
        (q: any) => q.phases?.evaluate?.score === 1
      ).length
      const accuracy =
        evaluatedQuestions.length > 0 ? correctCount / evaluatedQuestions.length : null

      return {
        provider: run.provider,
        runId: run.runId,
        status,
        progress: summary,
        accuracy,
      }
    })
    const compareState = getCompareState(compareId)
    const allCompleted = runDetails.every((r) => r.status === "completed")
    const anyFailed = runDetails.some((r) => r.status === "failed")
    const anyRunning = runDetails.some((r) => r.status === "running")

    let overallStatus: string
    if (compareState?.status === "stopping") {
      overallStatus = "stopping"
    } else if (compareState?.status === "running" || anyRunning) {
      overallStatus = "running"
    } else if (anyFailed) {
      overallStatus = "failed"
    } else if (allCompleted) {
      overallStatus = "completed"
    } else {
      overallStatus = "partial"
    }

    return json({
      ...manifest,
      providers: manifest.runs.map((r) => r.provider),
      status: overallStatus,
      runs: runDetails,
    })
  }
  const reportMatch = pathname.match(/^\/api\/compare\/([^/]+)\/report$/)
  if (method === "GET" && reportMatch) {
    const compareId = decodeURIComponent(reportMatch[1])
    const manifest = batchManager.loadManifest(compareId)
    if (!manifest) {
      return json({ error: "Comparison not found" }, 404)
    }

    const reports = batchManager.getReports(manifest)
    if (reports.length === 0) {
      return json({ error: "No reports available yet" }, 404)
    }
    return json({
      compareId: manifest.compareId,
      benchmark: manifest.benchmark,
      judge: manifest.judge,
      answeringModel: manifest.answeringModel,
      reports: reports.map((r) => ({
        provider: r.provider,
        report: r.report,
      })),
    })
  }
  const stopMatch = pathname.match(/^\/api\/compare\/([^/]+)\/stop$/)
  if (method === "POST" && stopMatch) {
    const compareId = decodeURIComponent(stopMatch[1])
    if (!isCompareActive(compareId)) {
      return json({ error: "Comparison is not active" }, 404)
    }

    const success = requestStop(compareId)
    if (!success) {
      return json({ error: "Failed to request stop" }, 500)
    }
    events.broadcast({
      type: "compare_stopping",
      compareId,
    })

    return json({ message: "Stop requested for comparison", compareId })
  }
  const resumeMatch = pathname.match(/^\/api\/compare\/([^/]+)\/resume$/)
  if (method === "POST" && resumeMatch) {
    const compareId = decodeURIComponent(resumeMatch[1])

    if (isCompareActive(compareId)) {
      return json({ error: "Comparison is already active" }, 409)
    }

    const manifest = batchManager.loadManifest(compareId)
    if (!manifest) {
      return json({ error: "Comparison not found" }, 404)
    }
    resumeComparison(compareId, events)

    return json({ message: "Comparison resumed", compareId })
  }
  const deleteMatch = pathname.match(/^\/api\/compare\/([^/]+)$/)
  if (method === "DELETE" && deleteMatch) {
    const compareId = decodeURIComponent(deleteMatch[1])

    if (isCompareActive(compareId)) {
      return json({ error: "Cannot delete active comparison" }, 409)
    }

    batchManager.delete(compareId)
    return json({ message: "Comparison deleted", compareId })
  }

  return null
}

function getRunStatus(checkpoint: any, summary: any): string {
  const runState = getRunState(checkpoint.runId)
  if (runState) {
    return runState.status
  }
  if (checkpoint.status === "completed") {
    return "completed"
  }
  if (checkpoint.status === "failed") {
    return "failed"
  }
  const questions = Object.values(checkpoint.questions || {}) as any[]
  const hasFailed = questions.some((q: any) => {
    const phases = q.phases || {}
    return (
      phases.ingest?.status === "failed" ||
      phases.indexing?.status === "failed" ||
      phases.search?.status === "failed" ||
      phases.answer?.status === "failed" ||
      phases.evaluate?.status === "failed"
    )
  })

  if (hasFailed) {
    return "failed"
  }

  if (summary.evaluated === summary.total && summary.total > 0) {
    return "completed"
  }
  if (checkpoint.status === "running" || checkpoint.status === "initializing") {
    if (summary.ingested > 0 || checkpoint.status === "running") {
      return "partial"
    }
    return "pending"
  }

  if (summary.ingested === 0) {
    return "pending"
  }
  return "partial"
}

async function initializeComparison(
  options: {
    providers: ProviderName[]
    benchmark: BenchmarkName
    judgeModel: string
    answeringModel: string
    sampling?: SamplingConfig
    force?: boolean
  },
  events: EventBroadcaster
): Promise<{ compareId: string }> {
  const manifest = await batchManager.createManifest(options)
  const compareId = manifest.compareId

  startCompare(
    compareId,
    options.benchmark,
    manifest.runs.map((r) => r.runId)
  )

  events.broadcast({
    type: "compare_started",
    compareId,
    benchmark: options.benchmark,
    providers: options.providers,
  })
  batchManager
    .executeRuns(manifest)
    .then(() => {
      events.broadcast({
        type: "compare_complete",
        compareId,
      })
    })
    .catch((error) => {
      events.broadcast({
        type: "error",
        compareId,
        message: error instanceof Error ? error.message : "Unknown error",
      })
    })
    .finally(() => {
      endCompare(compareId)
    })

  return { compareId }
}

async function resumeComparison(compareId: string, events: EventBroadcaster) {
  try {
    const manifest = batchManager.loadManifest(compareId)
    if (!manifest) {
      throw new Error(`Comparison not found: ${compareId}`)
    }

    startCompare(
      compareId,
      manifest.benchmark,
      manifest.runs.map((r) => r.runId)
    )

    events.broadcast({
      type: "compare_resumed",
      compareId,
    })

    await batchManager.resume(compareId)

    events.broadcast({
      type: "compare_complete",
      compareId,
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error"
    events.broadcast({
      type: "error",
      compareId,
      message,
    })
  } finally {
    endCompare(compareId)
  }
}

import { existsSync, readFileSync } from "fs"
import { join } from "path"
import { CheckpointManager } from "../../orchestrator/checkpoint"
import { orchestrator } from "../../orchestrator"
import { activeRuns, startRun, endRun, requestStop, isRunActive, getRunState } from "../runState"
import type { EventBroadcaster } from "../websocket"
import { createBenchmark } from "../../benchmarks"
import type { ProviderName } from "../../types/provider"
import type { BenchmarkName } from "../../types/benchmark"
import type { PhaseId, SamplingConfig } from "../../types/checkpoint"
import type { ConcurrencyConfig } from "../../types/concurrency"
import { getPhasesFromPhase, PHASE_ORDER } from "../../types/checkpoint"

const checkpointManager = new CheckpointManager()

const benchmarkRegistryCache: Record<string, any> = {}

function getQuestionTypeRegistry(benchmarkName: string) {
  if (!benchmarkRegistryCache[benchmarkName]) {
    const benchmark = createBenchmark(benchmarkName as BenchmarkName)
    benchmarkRegistryCache[benchmarkName] = benchmark.getQuestionTypes()
  }
  return benchmarkRegistryCache[benchmarkName]
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  })
}

export async function handleRunsRoutes(
  req: Request,
  url: URL,
  events: EventBroadcaster
): Promise<Response | null> {
  const method = req.method
  const pathname = url.pathname
  if (method === "GET" && pathname === "/api/runs") {
    const runs = checkpointManager.listRuns()
    const runDetails = runs
      .map((runId) => {
        const checkpoint = checkpointManager.load(runId)
        if (!checkpoint) return null
        const summary = checkpointManager.getSummary(checkpoint)
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
          runId,
          provider: checkpoint.provider,
          benchmark: checkpoint.benchmark,
          judge: checkpoint.judge,
          answeringModel: checkpoint.answeringModel,
          createdAt: checkpoint.createdAt,
          updatedAt: checkpoint.updatedAt,
          status: getRunStatus(checkpoint, summary),
          summary,
          accuracy,
        }
      })
      .filter(Boolean)
      .sort((a: any, b: any) => (b.createdAt || "").localeCompare(a.createdAt || ""))

    return json(runDetails)
  }
  const runIdMatch = pathname.match(/^\/api\/runs\/([^/]+)$/)
  if (method === "GET" && runIdMatch) {
    const runId = decodeURIComponent(runIdMatch[1])
    const checkpoint = checkpointManager.load(runId)
    if (!checkpoint) {
      return json({ error: "Run not found" }, 404)
    }
    const summary = checkpointManager.getSummary(checkpoint)
    return json({
      ...checkpoint,
      status: getRunStatus(checkpoint, summary),
      summary,
    })
  }
  const reportMatch = pathname.match(/^\/api\/runs\/([^/]+)\/report$/)
  if (method === "GET" && reportMatch) {
    const runId = decodeURIComponent(reportMatch[1])
    const reportPath = join(checkpointManager.getRunPath(runId), "report.json")
    if (!existsSync(reportPath)) {
      return json({ error: "Report not found" }, 404)
    }
    const report = JSON.parse(readFileSync(reportPath, "utf8"))
    return json(report)
  }
  const questionsMatch = pathname.match(/^\/api\/runs\/([^/]+)\/questions$/)
  if (method === "GET" && questionsMatch) {
    const runId = decodeURIComponent(questionsMatch[1])
    const checkpoint = checkpointManager.load(runId)
    if (!checkpoint) {
      return json({ error: "Run not found" }, 404)
    }
    const page = parseInt(url.searchParams.get("page") || "1")
    const limit = parseInt(url.searchParams.get("limit") || "50")
    const status = url.searchParams.get("status")
    const type = url.searchParams.get("type")

    let questions = Object.values(checkpoint.questions)
    if (status) {
      questions = questions.filter((q) => {
        const evalStatus = q.phases.evaluate.status
        if (status === "completed") return evalStatus === "completed"
        if (status === "failed") return evalStatus === "failed"
        if (status === "pending") return evalStatus !== "completed" && evalStatus !== "failed"
        return true
      })
    }
    if (type) {
      questions = questions.filter((q) => q.questionType === type)
    }

    const total = questions.length
    const start = (page - 1) * limit
    const paged = questions.slice(start, start + limit)

    return json({
      questions: paged,
      questionTypeRegistry: getQuestionTypeRegistry(checkpoint.benchmark),
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    })
  }
  const questionDetailMatch = pathname.match(/^\/api\/runs\/([^/]+)\/questions\/([^/]+)$/)
  if (method === "GET" && questionDetailMatch) {
    const runId = decodeURIComponent(questionDetailMatch[1])
    const questionId = decodeURIComponent(questionDetailMatch[2])
    const checkpoint = checkpointManager.load(runId)
    if (!checkpoint) {
      return json({ error: "Run not found" }, 404)
    }
    const question = checkpoint.questions[questionId]
    if (!question) {
      return json({ error: "Question not found" }, 404)
    }
    const resultsPath = join(checkpointManager.getResultsDir(runId), `${questionId}.json`)
    let searchResults = null
    if (existsSync(resultsPath)) {
      searchResults = JSON.parse(readFileSync(resultsPath, "utf8"))
    }

    return json({
      ...question,
      searchResultsFile: searchResults,
    })
  }
  if (method === "POST" && pathname === "/api/runs/start") {
    try {
      const body = await req.json()
      console.log("[API] Start run request body:", JSON.stringify(body, null, 2))
      const {
        provider,
        benchmark,
        runId,
        judgeModel,
        answeringModel,
        limit,
        sampling,
        concurrency,
        force,
        fromPhase,
        sourceRunId,
      } = body
      console.log("[API] Extracted sampling:", sampling)
      console.log("[API] Extracted concurrency:", concurrency)

      if (!provider || !benchmark || !runId || !judgeModel) {
        return json(
          {
            error: "Missing required fields: provider, benchmark, runId, judgeModel",
          },
          400
        )
      }

      if (fromPhase && !PHASE_ORDER.includes(fromPhase)) {
        return json(
          {
            error: `Invalid phase: ${fromPhase}. Valid phases: ${PHASE_ORDER.join(", ")}`,
          },
          400
        )
      }
      if (sourceRunId && fromPhase === "ingest") {
        return json(
          {
            error:
              "Cannot start from ingest phase in advanced mode. Use indexing, search, answer, evaluate, or report.",
          },
          400
        )
      }

      if (activeRuns.has(runId)) {
        return json({ error: "Run is already active" }, 409)
      }
      if (sourceRunId) {
        const sourceCheckpoint = checkpointManager.load(sourceRunId)
        if (!sourceCheckpoint) {
          return json({ error: `Source run not found: ${sourceRunId}` }, 404)
        }
        if (sourceCheckpoint.provider !== provider) {
          return json(
            {
              error: `Provider mismatch: source run has ${sourceCheckpoint.provider}, not ${provider}`,
            },
            400
          )
        }
        if (sourceCheckpoint.benchmark !== benchmark) {
          return json(
            {
              error: `Benchmark mismatch: source run has ${sourceCheckpoint.benchmark}, not ${benchmark}`,
            },
            400
          )
        }
        if (checkpointManager.exists(runId)) {
          return json({ error: `Run ${runId} already exists` }, 409)
        }
        checkpointManager.copyCheckpoint(sourceRunId, runId, fromPhase as PhaseId, {
          judge: judgeModel,
          answeringModel: answeringModel || sourceCheckpoint.answeringModel,
        })
        await checkpointManager.flush(runId)
      }

      startRun(runId, benchmark)

      runBenchmark(
        {
          provider: provider as ProviderName,
          benchmark: benchmark as BenchmarkName,
          runId,
          judgeModel,
          answeringModel,
          limit,
          sampling,
          concurrency,
          force: sourceRunId ? false : force,
          fromPhase: fromPhase as PhaseId | undefined,
        },
        events
      ).finally(() => {
        endRun(runId)
      })

      return json({ message: "Run started", runId })
    } catch (e) {
      return json({ error: e instanceof Error ? e.message : "Invalid request body" }, 400)
    }
  }
  const stopMatch = pathname.match(/^\/api\/runs\/([^/]+)\/stop$/)
  if (method === "POST" && stopMatch) {
    const runId = decodeURIComponent(stopMatch[1])
    if (!isRunActive(runId)) {
      return json({ error: "Run is not active" }, 404)
    }
    requestStop(runId)
    return json({ message: "Stop requested", runId })
  }
  const deleteMatch = pathname.match(/^\/api\/runs\/([^/]+)$/)
  if (method === "DELETE" && deleteMatch) {
    const runId = decodeURIComponent(deleteMatch[1])
    if (isRunActive(runId)) {
      return json({ error: "Cannot delete active run" }, 409)
    }
    checkpointManager.delete(runId)
    return json({ message: "Run deleted", runId })
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

async function runBenchmark(
  options: {
    provider: ProviderName
    benchmark: BenchmarkName
    runId: string
    judgeModel: string
    answeringModel?: string
    limit?: number
    sampling?: SamplingConfig
    concurrency?: ConcurrencyConfig
    force?: boolean
    fromPhase?: PhaseId
  },
  events: EventBroadcaster
) {
  try {
    events.broadcast({
      type: "run_started",
      runId: options.runId,
      provider: options.provider,
      benchmark: options.benchmark,
    })

    const phases = options.fromPhase ? getPhasesFromPhase(options.fromPhase) : undefined

    await orchestrator.run({
      provider: options.provider,
      benchmark: options.benchmark,
      runId: options.runId,
      judgeModel: options.judgeModel,
      answeringModel: options.answeringModel,
      limit: options.limit,
      sampling: options.sampling,
      concurrency: options.concurrency,
      force: options.force,
      phases,
    })

    events.broadcast({
      type: "run_complete",
      runId: options.runId,
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error"
    const wasStoppedByUser = message.includes("stopped by user")
    const checkpoint = checkpointManager.load(options.runId)
    if (checkpoint) {
      checkpointManager.updateStatus(checkpoint, "failed")
    }

    events.broadcast({
      type: wasStoppedByUser ? "run_stopped" : "error",
      runId: options.runId,
      message,
    })
  }
}

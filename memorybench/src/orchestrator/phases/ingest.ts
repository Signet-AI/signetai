import type { Provider, IngestResult } from "../../types/provider"
import type { Benchmark } from "../../types/benchmark"
import type { RunCheckpoint } from "../../types/checkpoint"
import { CheckpointManager } from "../checkpoint"
import { logger } from "../../utils/logger"
import { ConcurrentExecutor } from "../concurrent"
import { resolveConcurrency } from "../../types/concurrency"

const RATE_LIMIT_MS = 1000
const DEFAULT_SESSION_CONCURRENCY = 1
const MAX_SESSION_CONCURRENCY = 16

function readBoundedPositiveInt(value: string | undefined, fallback: number, max: number): number {
  const parsed = Number.parseInt(value ?? "", 10)
  if (!Number.isInteger(parsed) || parsed < 1) return fallback
  return Math.min(parsed, max)
}

export function resolveSessionConcurrency(env: NodeJS.ProcessEnv = process.env): number {
  return readBoundedPositiveInt(
    env.MEMORYBENCH_SESSION_CONCURRENCY || env.SIGNET_BENCH_SESSION_CONCURRENCY,
    DEFAULT_SESSION_CONCURRENCY,
    MAX_SESSION_CONCURRENCY
  )
}

function cloneIngestResult(result?: IngestResult): IngestResult {
  return {
    documentIds: [...(result?.documentIds || [])],
    taskIds: [...(result?.taskIds || [])],
  }
}

function appendIngestResult(target: IngestResult, source: IngestResult): void {
  target.documentIds.push(...source.documentIds)
  if (source.taskIds && source.taskIds.length > 0) {
    target.taskIds = [...(target.taskIds || []), ...source.taskIds]
  }
}

function finalizeIngestResult(result: IngestResult): IngestResult {
  return result.taskIds && result.taskIds.length > 0 ? result : { documentIds: result.documentIds }
}

export async function runIngestPhase(
  provider: Provider,
  benchmark: Benchmark,
  checkpoint: RunCheckpoint,
  checkpointManager: CheckpointManager,
  questionIds?: string[]
): Promise<void> {
  const questions = benchmark.getQuestions()
  const targetQuestions = questionIds
    ? questions.filter((q) => questionIds.includes(q.questionId))
    : questions

  const pendingQuestions = targetQuestions.filter((q) => {
    const status = checkpointManager.getPhaseStatus(checkpoint, q.questionId, "ingest")
    return status !== "completed"
  })

  if (pendingQuestions.length === 0) {
    logger.info("No questions pending ingestion")
    return
  }

  const concurrency = resolveConcurrency("ingest", checkpoint.concurrency, provider.concurrency)

  logger.info(`Ingesting ${pendingQuestions.length} questions (concurrency: ${concurrency})...`)

  await ConcurrentExecutor.executeBatched({
    items: pendingQuestions,
    concurrency,
    rateLimitMs: RATE_LIMIT_MS,
    runId: checkpoint.runId,
    phaseName: "ingest",
    executeTask: async ({ item: question, index, total }) => {
      const containerTag = `${question.questionId}-${checkpoint.dataSourceRunId}`
      const sessions = benchmark.getHaystackSessions(question.questionId)

      const sessionsMetadata = sessions.map((s) => ({
        sessionId: s.sessionId,
        date: s.metadata?.date as string | undefined,
        messageCount: s.messages.length,
      }))
      checkpointManager.updateSessions(checkpoint, question.questionId, sessionsMetadata)

      const startTime = Date.now()
      checkpointManager.updatePhase(checkpoint, question.questionId, "ingest", {
        status: "in_progress",
        startedAt: new Date().toISOString(),
      })

      try {
        const completedSessions =
          checkpoint.questions[question.questionId].phases.ingest.completedSessions
        const existingResult = checkpoint.questions[question.questionId].phases.ingest.ingestResult
        const combinedResult = cloneIngestResult(existingResult)
        const pendingSessions = sessions.filter((session) => {
          return !completedSessions.includes(session.sessionId)
        })
        const sessionConcurrency = resolveSessionConcurrency()

        if (pendingSessions.length > 0 && sessionConcurrency > 1) {
          logger.debug(
            `Ingesting ${pendingSessions.length} session(s) for ${question.questionId} with session concurrency ${sessionConcurrency}`
          )
        }

        await ConcurrentExecutor.executeBatched({
          items: pendingSessions,
          concurrency: sessionConcurrency,
          rateLimitMs: 0,
          runId: checkpoint.runId,
          phaseName: `ingest:${question.questionId}:sessions`,
          executeTask: async ({ item: session }) => {
            const result = await provider.ingest([session], { containerTag })
            return { sessionId: session.sessionId, result }
          },
          onTaskComplete: (_context, sessionResult) => {
            appendIngestResult(combinedResult, sessionResult.result)
            completedSessions.push(sessionResult.sessionId)
            checkpointManager.updatePhase(checkpoint, question.questionId, "ingest", {
              completedSessions: [...completedSessions],
              ingestResult: finalizeIngestResult(combinedResult),
            })
          },
        })

        const durationMs = Date.now() - startTime
        checkpointManager.updatePhase(checkpoint, question.questionId, "ingest", {
          status: "completed",
          ingestResult: finalizeIngestResult(combinedResult),
          completedAt: new Date().toISOString(),
          durationMs,
        })

        logger.progress(index + 1, total, `Ingested ${question.questionId} (${durationMs}ms)`)

        return { questionId: question.questionId, durationMs }
      } catch (e) {
        const error = e instanceof Error ? e.message : String(e)
        checkpointManager.updatePhase(checkpoint, question.questionId, "ingest", {
          status: "failed",
          error,
        })
        logger.error(`Failed to ingest ${question.questionId}: ${error}`)
        throw new Error(
          `Ingest failed at ${question.questionId}: ${error}. Fix the issue and resume with the same run ID.`
        )
      }
    },
  })

  logger.success("Ingest phase complete")
}

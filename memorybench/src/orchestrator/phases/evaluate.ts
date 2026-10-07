import type { Judge } from "../../types/judge"
import type { Benchmark } from "../../types/benchmark"
import type { RunCheckpoint } from "../../types/checkpoint"
import type { Provider } from "../../types/provider"
import { CheckpointManager } from "../checkpoint"
import { logger } from "../../utils/logger"
import { ConcurrentExecutor } from "../concurrent"
import { resolveConcurrency } from "../../types/concurrency"
import { calculateRetrievalMetrics } from "./retrieval-eval"
import type { ModelUsage } from "../../utils/llm"

interface HypothesisScore {
  score: number
  passed: boolean
  explanation: string
  metrics?: Record<string, number>
  details?: Record<string, unknown>
  usage?: ModelUsage
}

export async function runEvaluatePhase(
  judge: Judge,
  benchmark: Benchmark,
  checkpoint: RunCheckpoint,
  checkpointManager: CheckpointManager,
  questionIds?: string[],
  provider?: Provider
): Promise<void> {
  const questions = benchmark.getQuestions()
  const targetQuestions = questionIds
    ? questions.filter((q) => questionIds.includes(q.questionId))
    : questions

  const pendingQuestions = targetQuestions.filter((q) => {
    const status = checkpointManager.getPhaseStatus(checkpoint, q.questionId, "evaluate")
    const answerStatus = checkpointManager.getPhaseStatus(checkpoint, q.questionId, "answer")
    const hypothesis = checkpoint.questions[q.questionId]?.phases.answer.hypothesis
    return status !== "completed" && answerStatus === "completed" && hypothesis
  })

  if (pendingQuestions.length === 0) {
    logger.info("No questions pending evaluation")
    return
  }

  const concurrency = resolveConcurrency("evaluate", checkpoint.concurrency, provider?.concurrency)

  logger.info(
    `Evaluating ${pendingQuestions.length} questions with ${judge.name} (concurrency: ${concurrency})...`
  )

  await ConcurrentExecutor.execute(
    pendingQuestions,
    concurrency,
    checkpoint.runId,
    "evaluate",
    async ({ item: question, index, total }) => {
      const hypothesis = checkpoint.questions[question.questionId].phases.answer.hypothesis!

      const startTime = Date.now()
      checkpointManager.updatePhase(checkpoint, question.questionId, "evaluate", {
        status: "in_progress",
        startedAt: new Date().toISOString(),
      })

      try {
        const answerPhase = checkpoint.questions[question.questionId].phases.answer
        const scoreHypothesis = async (candidate: string): Promise<HypothesisScore> => {
          if (benchmark.protocol) {
            const evaluation = await benchmark.protocol.evaluateQuestion({
              question,
              hypothesis: candidate,
              judge,
            })
            return {
              score: evaluation.score,
              passed: evaluation.passed,
              explanation: evaluation.explanation,
              metrics: evaluation.metrics,
              details: evaluation.details,
              usage: evaluation.usage,
            }
          }
          const result = await judge.evaluate({
            question: question.question,
            questionType: question.questionType,
            groundTruth: question.groundTruth,
            hypothesis: candidate,
            providerPrompts: provider?.prompts,
          })
          return {
            score: result.score,
            passed: result.label === "correct",
            explanation: result.explanation,
            usage: result.usage,
          }
        }

        const searchResults = checkpoint.questions[question.questionId].phases.search.results || []
        const [product, retrievalMetrics] = await Promise.all([
          scoreHypothesis(hypothesis),
          benchmark.protocol
            ? Promise.resolve(undefined)
            : calculateRetrievalMetrics(
                judge.getModel(),
                question.question,
                question.groundTruth,
                searchResults,
                undefined,
                question.relevantSessionIds
              ),
        ])
        const derivedAnswer = answerPhase.derivedOnly
        const derived = !derivedAnswer
          ? undefined
          : derivedAnswer.reusedProductAnswer
            ? { score: product.score, passed: product.passed }
            : await scoreHypothesis(derivedAnswer.hypothesis).then((result) => ({
                score: result.score,
                passed: result.passed,
                usage: result.usage,
              }))

        const durationMs = Date.now() - startTime
        const label = product.passed ? "correct" : "incorrect"
        checkpointManager.updatePhase(checkpoint, question.questionId, "evaluate", {
          status: "completed",
          score: product.score,
          passed: product.passed,
          label,
          explanation: product.explanation,
          ...(product.metrics ? { metrics: product.metrics } : {}),
          ...(product.details ? { details: product.details } : {}),
          ...(retrievalMetrics ? { retrievalMetrics } : {}),
          usage: product.usage,
          ...(derived ? { derivedOnly: derived } : {}),
          completedAt: new Date().toISOString(),
          durationMs,
        })

        const retrievalInfo = retrievalMetrics
          ? ` | Hit@${retrievalMetrics.k}=${retrievalMetrics.hitAtK}, MRR=${retrievalMetrics.mrr.toFixed(2)}`
          : ""
        const derivedInfo = derived
          ? ` | derived-only: ${derived.passed ? "correct" : "incorrect"}`
          : ""
        logger.progress(
          index + 1,
          total,
          `Evaluated ${question.questionId}: ${label}${retrievalInfo}${derivedInfo} (${durationMs}ms)`
        )

        return { questionId: question.questionId, durationMs, label }
      } catch (e) {
        const error = e instanceof Error ? e.message : String(e)
        checkpointManager.updatePhase(checkpoint, question.questionId, "evaluate", {
          status: "failed",
          error,
        })
        logger.error(`Failed to evaluate ${question.questionId}: ${error}`)
        throw new Error(
          `Evaluate failed at ${question.questionId}: ${error}. Fix the issue and resume with the same run ID.`
        )
      }
    }
  )

  logger.success("Evaluate phase complete")
}

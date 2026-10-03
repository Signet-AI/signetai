import { readFileSync, existsSync } from "fs"
import type { AnswerPlan, Benchmark } from "../../types/benchmark"
import type { RunCheckpoint } from "../../types/checkpoint"
import type { Provider } from "../../types/provider"
import type { UnifiedQuestion } from "../../types/unified"
import { CheckpointManager } from "../checkpoint"
import { logger } from "../../utils/logger"
import { getModelConfig, DEFAULT_ANSWERING_MODEL } from "../../utils/models"
import { assertModelCredentials, generateWithModel } from "../../utils/llm"
import { buildDefaultAnswerPrompt } from "../../prompts/defaults"
import { buildContextString } from "../../types/prompts"
import { ConcurrentExecutor } from "../concurrent"
import { resolveConcurrency } from "../../types/concurrency"
import { countTokens } from "../../utils/tokens"

function buildAnswerPrompt(
  question: string,
  context: unknown[],
  questionDate?: string,
  provider?: Provider
): string {
  if (provider?.prompts?.answerPrompt) {
    const customPrompt = provider.prompts.answerPrompt
    if (typeof customPrompt === "function") {
      return customPrompt(question, context, questionDate)
    }
    const contextStr = buildContextString(context)
    return customPrompt
      .replace("{{question}}", question)
      .replace("{{questionDate}}", questionDate || "Not specified")
      .replace("{{context}}", contextStr)
  }

  return buildDefaultAnswerPrompt(question, context, questionDate)
}

export function planAnswer(
  benchmark: Benchmark,
  question: UnifiedQuestion,
  context: unknown[],
  questionDate?: string,
  provider?: Provider
): AnswerPlan {
  if (benchmark.protocol) {
    return benchmark.protocol.createAnswerPlan({
      question,
      sessions: benchmark.getHaystackSessions(question.questionId),
      results: context,
    })
  }
  return {
    prompt: buildAnswerPrompt(question.question, context, questionDate, provider),
    basePrompt: buildAnswerPrompt(question.question, [], questionDate, provider),
    evidenceCount: context.length,
  }
}

export function normalizeGeneratedAnswer(text: string): string {
  const trimmed = text.trim()
  return trimmed.length > 0 ? trimmed : "I don't know."
}

export async function runAnswerPhase(
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
    const status = checkpointManager.getPhaseStatus(checkpoint, q.questionId, "answer")
    const searchStatus = checkpointManager.getPhaseStatus(checkpoint, q.questionId, "search")
    const resultFile = checkpoint.questions[q.questionId]?.phases.search.resultFile
    return (
      status !== "completed" && searchStatus === "completed" && resultFile && existsSync(resultFile)
    )
  })

  if (pendingQuestions.length === 0) {
    logger.info("No questions pending answering")
    return
  }

  const modelConfig = getModelConfig(checkpoint.answeringModel || DEFAULT_ANSWERING_MODEL)
  assertModelCredentials(modelConfig)
  const concurrency = resolveConcurrency("answer", checkpoint.concurrency, provider?.concurrency)

  logger.info(
    `Generating answers for ${pendingQuestions.length} questions using ${modelConfig.displayName} (concurrency: ${concurrency})...`
  )

  await ConcurrentExecutor.execute(
    pendingQuestions,
    concurrency,
    checkpoint.runId,
    "answer",
    async ({ item: question, index, total }) => {
      const resultFile = checkpoint.questions[question.questionId].phases.search.resultFile!

      const startTime = Date.now()
      checkpointManager.updatePhase(checkpoint, question.questionId, "answer", {
        status: "in_progress",
        startedAt: new Date().toISOString(),
      })

      try {
        const searchData = JSON.parse(readFileSync(resultFile, "utf8"))
        const context: unknown[] = searchData.results || []
        const questionDate = checkpoint.questions[question.questionId]?.questionDate

        const plan = planAnswer(benchmark, question, context, questionDate, provider)

        const basePromptTokens = countTokens(plan.basePrompt, modelConfig)
        const promptTokens = countTokens(plan.prompt, modelConfig)
        const contextTokens = Math.max(0, promptTokens - basePromptTokens)

        const { text, usage } = await generateWithModel(modelConfig, plan.prompt)
        const hypothesis = normalizeGeneratedAnswer(text)
        if (hypothesis !== text.trim()) {
          logger.warn(
            `Answer model returned an empty response for ${question.questionId}; recording an explicit abstention so the question remains in the score denominator.`
          )
        }

        const durationMs = Date.now() - startTime
        checkpointManager.updatePhase(checkpoint, question.questionId, "answer", {
          status: "completed",
          hypothesis,
          promptTokens,
          basePromptTokens,
          contextTokens,
          evidenceCount: plan.evidenceCount,
          usage,
          completedAt: new Date().toISOString(),
          durationMs,
        })

        logger.progress(
          index + 1,
          total,
          `Answered ${question.questionId} (${durationMs}ms, ${promptTokens} tokens: ${basePromptTokens} base + ${contextTokens} context)`
        )
        return { questionId: question.questionId, durationMs }
      } catch (e) {
        const error = e instanceof Error ? e.message : String(e)
        checkpointManager.updatePhase(checkpoint, question.questionId, "answer", {
          status: "failed",
          error,
        })
        logger.error(`Failed to answer ${question.questionId}: ${error}`)
        throw new Error(
          `Answer failed at ${question.questionId}: ${error}. Fix the issue and resume with the same run ID.`
        )
      }
    }
  )

  logger.success("Answer phase complete")
}

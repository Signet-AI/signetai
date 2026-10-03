import { writeFileSync, mkdirSync, existsSync } from "fs"
import { join } from "path"
import type { Benchmark } from "../../types/benchmark"
import type { RunCheckpoint } from "../../types/checkpoint"
import type {
  BenchmarkResult,
  EvaluationResult,
  LatencyStats,
  QuestionTypeStats,
  RetrievalMetrics,
  RetrievalAggregates,
  RunUsage,
  TokenMetrics,
  TranscriptReliance,
  UsageSummary,
} from "../../types/unified"
import { logger } from "../../utils/logger"
import { addUsage, emptyUsage, estimateCostUsd, type ModelUsage } from "../../utils/llm"
import { getModelConfig } from "../../utils/models"
import { tokenizerFor } from "../../utils/tokens"
import { EXTRACTION_MODEL } from "../../prompts/extraction"

const REPORTS_DIR = "./data/runs"

function aggregateRetrievalMetrics(metrics: RetrievalMetrics[]): RetrievalAggregates | undefined {
  if (metrics.length === 0) return undefined

  const sum = metrics.reduce(
    (acc, m) => ({
      hitAtK: acc.hitAtK + m.hitAtK,
      precisionAtK: acc.precisionAtK + m.precisionAtK,
      recallAtK: acc.recallAtK + m.recallAtK,
      f1AtK: acc.f1AtK + m.f1AtK,
      mrr: acc.mrr + m.mrr,
      ndcg: acc.ndcg + m.ndcg,
      k: m.k,
    }),
    { hitAtK: 0, precisionAtK: 0, recallAtK: 0, f1AtK: 0, mrr: 0, ndcg: 0, k: 10 }
  )

  const n = metrics.length
  return {
    hitAtK: sum.hitAtK / n,
    precisionAtK: sum.precisionAtK / n,
    recallAtK: sum.recallAtK / n,
    f1AtK: sum.f1AtK / n,
    mrr: sum.mrr / n,
    ndcg: sum.ndcg / n,
    k: sum.k,
  }
}

function calculateLatencyStats(durations: number[]): LatencyStats {
  if (durations.length === 0) {
    return { min: 0, max: 0, mean: 0, median: 0, p95: 0, p99: 0, stdDev: 0, count: 0 }
  }

  const sorted = [...durations].sort((a, b) => a - b)
  const n = sorted.length
  const sum = sorted.reduce((a, b) => a + b, 0)
  const mean = sum / n

  const variance = sorted.reduce((acc, val) => acc + Math.pow(val - mean, 2), 0) / n
  const stdDev = Math.sqrt(variance)

  return {
    min: sorted[0],
    max: sorted[n - 1],
    mean: Math.round(mean),
    median: sorted[Math.floor(n / 2)],
    p95: sorted[Math.floor(n * 0.95)] || sorted[n - 1],
    p99: sorted[Math.floor(n * 0.99)] || sorted[n - 1],
    stdDev: Math.round(stdDev),
    count: n,
  }
}

function summarizeUsage(modelAlias: string, usage: ModelUsage): UsageSummary {
  const estimatedCostUsd = estimateCostUsd(getModelConfig(modelAlias), usage)
  return {
    model: modelAlias,
    usage,
    ...(estimatedCostUsd === undefined ? {} : { estimatedCostUsd }),
  }
}

function summarizeRunUsage(checkpoint: RunCheckpoint, questionIds: string[]): RunUsage {
  const answer = emptyUsage()
  const judge = emptyUsage()
  const ablationAnswer = emptyUsage()
  const ablationJudge = emptyUsage()
  for (const questionId of questionIds) {
    const phases = checkpoint.questions[questionId]?.phases
    addUsage(answer, phases?.answer.usage)
    addUsage(judge, phases?.evaluate.usage)
    addUsage(ablationAnswer, phases?.answer.derivedOnly?.usage)
    addUsage(ablationJudge, phases?.evaluate.derivedOnly?.usage)
  }
  const harness = checkpoint.ingestUsage?.harness
  const passes = Object.values(checkpoint.ingestUsage?.dreamingPasses ?? {})
  return {
    answer: summarizeUsage(checkpoint.answeringModel, answer),
    judge: summarizeUsage(checkpoint.judge, judge),
    ...(harness && harness.requests > 0
      ? { extraction: summarizeUsage(EXTRACTION_MODEL.id, harness) }
      : {}),
    ...(passes.length > 0
      ? {
          dreaming: {
            passesObserved: passes.length,
            passesWithoutUsage: passes.filter((pass) => pass.inputTokens === null).length,
            inputTokens: passes.reduce((sum, pass) => sum + (pass.inputTokens ?? 0), 0),
            outputTokens: passes.reduce((sum, pass) => sum + (pass.outputTokens ?? 0), 0),
            cacheReadTokens: passes.reduce((sum, pass) => sum + (pass.cacheReadTokens ?? 0), 0),
          },
        }
      : {}),
    ...(ablationAnswer.requests + ablationJudge.requests > 0
      ? {
          ablation: {
            answer: summarizeUsage(checkpoint.answeringModel, ablationAnswer),
            judge: summarizeUsage(checkpoint.judge, ablationJudge),
          },
        }
      : {}),
    answerTokensPerQuestion:
      questionIds.length > 0
        ? Math.round((answer.inputTokens + answer.outputTokens) / questionIds.length)
        : 0,
  }
}

export function summarizeTranscriptReliance(
  checkpoint: RunCheckpoint,
  questionIds: string[]
): TranscriptReliance | undefined {
  const entries = questionIds.flatMap((questionId) => {
    const phases = checkpoint.questions[questionId]?.phases
    const answer = phases?.answer
    const evaluation = phases?.evaluate
    if (!answer?.derivedOnly || !evaluation?.derivedOnly || evaluation.score === undefined) return []
    return [{ answer, evaluation, derivedAnswer: answer.derivedOnly, derivedEval: evaluation.derivedOnly }]
  })
  if (entries.length === 0) return undefined
  const count = (predicate: (entry: (typeof entries)[number]) => boolean): number =>
    entries.filter(predicate).length
  const productPassed = (entry: (typeof entries)[number]): boolean =>
    entry.evaluation.passed ?? entry.evaluation.score === 1
  const sum = (values: number[]): number => values.reduce((total, value) => total + value, 0)
  const productInput = sum(entries.map((entry) => entry.answer.usage?.inputTokens ?? 0))
  const derivedInput = sum(
    entries.map((entry) =>
      entry.derivedAnswer.reusedProductAnswer
        ? (entry.answer.usage?.inputTokens ?? 0)
        : (entry.derivedAnswer.usage?.inputTokens ?? 0)
    )
  )
  const onlyWithTranscripts = count((entry) => productPassed(entry) && !entry.derivedEval.passed)
  return {
    questions: entries.length,
    questionsWithRawEvidence: count((entry) => (entry.answer.rawEvidenceCount ?? 0) > 0),
    rawEvidenceItems: sum(entries.map((entry) => entry.answer.rawEvidenceCount ?? 0)),
    productScore: sum(entries.map((entry) => entry.evaluation.score ?? 0)) / entries.length,
    derivedOnlyScore: sum(entries.map((entry) => entry.derivedEval.score)) / entries.length,
    bothCorrect: count((entry) => productPassed(entry) && entry.derivedEval.passed),
    onlyWithTranscripts,
    onlyWithoutTranscripts: count((entry) => !productPassed(entry) && entry.derivedEval.passed),
    bothWrong: count((entry) => !productPassed(entry) && !entry.derivedEval.passed),
    avgContextTokensProduct: Math.round(
      sum(entries.map((entry) => entry.answer.contextTokens ?? 0)) / entries.length
    ),
    avgContextTokensDerivedOnly: Math.round(
      sum(entries.map((entry) => entry.derivedAnswer.contextTokens)) / entries.length
    ),
    answerInputTokensProduct: productInput,
    answerInputTokensDerivedOnly: derivedInput,
    ...(onlyWithTranscripts > 0
      ? { extraInputTokensPerRescuedAnswer: Math.round((productInput - derivedInput) / onlyWithTranscripts) }
      : {}),
  }
}

export function generateReport(benchmark: Benchmark, checkpoint: RunCheckpoint): BenchmarkResult {
  const questions = benchmark.getQuestions()
  const evaluations: EvaluationResult[] = []

  const ingestDurations: number[] = []
  const indexingDurations: number[] = []
  const searchDurations: number[] = []
  const answerDurations: number[] = []
  const evaluateDurations: number[] = []
  const totalDurations: number[] = []

  const allRetrievalMetrics: RetrievalMetrics[] = []

  const byType: Record<
    string,
    {
      total: number
      correct: number
      searchDurations: number[]
      answerDurations: number[]
      totalDurations: number[]
      retrievalMetrics: RetrievalMetrics[]
    }
  > = {}

  for (const question of questions) {
    const qCheckpoint = checkpoint.questions[question.questionId]
    if (!qCheckpoint) continue

    const evalPhase = qCheckpoint.phases.evaluate
    if (evalPhase.status !== "completed") continue

    const ingestPhase = qCheckpoint.phases.ingest
    const indexingPhase = qCheckpoint.phases.indexing
    const searchPhase = qCheckpoint.phases.search
    const answerPhase = qCheckpoint.phases.answer

    const ingestDurationMs = ingestPhase.durationMs || 0
    const indexingDurationMs = indexingPhase.durationMs || 0
    const searchDurationMs = searchPhase.durationMs || 0
    const answerDurationMs = answerPhase.durationMs || 0
    const evaluateDurationMs = evalPhase.durationMs || 0
    const totalDurationMs =
      ingestDurationMs +
      indexingDurationMs +
      searchDurationMs +
      answerDurationMs +
      evaluateDurationMs

    const retrievalMetrics = evalPhase.retrievalMetrics

    const correct = evalPhase.passed ?? evalPhase.score === 1
    evaluations.push({
      questionId: question.questionId,
      questionType: question.questionType,
      question: question.question,
      score: evalPhase.score || 0,
      label: correct ? "correct" : "incorrect",
      explanation: evalPhase.explanation || "",
      hypothesis: answerPhase.hypothesis || "",
      groundTruth: question.groundTruth,
      searchResults: searchPhase.results || [],
      searchDurationMs,
      answerDurationMs,
      totalDurationMs,
      retrievalMetrics,
    })

    if (retrievalMetrics) {
      allRetrievalMetrics.push(retrievalMetrics)
    }

    if (ingestPhase.durationMs) ingestDurations.push(ingestPhase.durationMs)
    if (indexingPhase.durationMs) indexingDurations.push(indexingPhase.durationMs)
    if (searchPhase.durationMs) searchDurations.push(searchPhase.durationMs)
    if (answerPhase.durationMs) answerDurations.push(answerPhase.durationMs)
    if (evalPhase.durationMs) evaluateDurations.push(evalPhase.durationMs)
    if (totalDurationMs > 0) totalDurations.push(totalDurationMs)

    const qType = question.questionType
    if (!byType[qType]) {
      byType[qType] = {
        total: 0,
        correct: 0,
        searchDurations: [],
        answerDurations: [],
        totalDurations: [],
        retrievalMetrics: [],
      }
    }
    const typeStats = byType[qType]!
    typeStats.total++
    if (correct) {
      typeStats.correct++
    }
    if (searchDurationMs) typeStats.searchDurations.push(searchDurationMs)
    if (answerDurationMs) typeStats.answerDurations.push(answerDurationMs)
    if (totalDurationMs > 0) typeStats.totalDurations.push(totalDurationMs)
    if (retrievalMetrics) typeStats.retrievalMetrics.push(retrievalMetrics)
  }

  const byQuestionType: Record<string, QuestionTypeStats> = {}
  for (const type of Object.keys(byType)) {
    const raw = byType[type]!
    byQuestionType[type] = {
      total: raw.total,
      correct: raw.correct,
      accuracy: raw.total > 0 ? raw.correct / raw.total : 0,
      latency: {
        search: calculateLatencyStats(raw.searchDurations),
        answer: calculateLatencyStats(raw.answerDurations),
        total: calculateLatencyStats(raw.totalDurations),
      },
      retrieval: aggregateRetrievalMetrics(raw.retrievalMetrics),
    }
  }

  const overallRetrieval = aggregateRetrievalMetrics(allRetrievalMetrics)
  let tokenMetrics: TokenMetrics | undefined
  const allPromptTokens: number[] = []
  const allBasePromptTokens: number[] = []
  const allContextTokens: number[] = []

  for (const question of questions) {
    const qCheckpoint = checkpoint.questions[question.questionId]
    if (!qCheckpoint) continue
    if (qCheckpoint.phases.evaluate.status !== "completed") continue
    const answerPhase = qCheckpoint.phases.answer
    if (answerPhase.promptTokens != null) allPromptTokens.push(answerPhase.promptTokens)
    if (answerPhase.basePromptTokens != null)
      allBasePromptTokens.push(answerPhase.basePromptTokens)
    if (answerPhase.contextTokens != null) allContextTokens.push(answerPhase.contextTokens)
  }

  if (allPromptTokens.length > 0) {
    const totalTokens = allPromptTokens.reduce((a, b) => a + b, 0)
    const totalBasePromptTokens = allBasePromptTokens.reduce((a, b) => a + b, 0)
    const totalContextTokens = allContextTokens.reduce((a, b) => a + b, 0)
    tokenMetrics = {
      totalTokens,
      basePromptTokens: totalBasePromptTokens,
      contextTokens: totalContextTokens,
      avgTokensPerQuestion: Math.round(totalTokens / allPromptTokens.length),
      avgBasePromptTokens:
        allBasePromptTokens.length > 0
          ? Math.round(totalBasePromptTokens / allBasePromptTokens.length)
          : 0,
      avgContextTokens:
        allContextTokens.length > 0 ? Math.round(totalContextTokens / allContextTokens.length) : 0,
    }
  }

  const totalQuestions = evaluations.length
  const correctCount = evaluations.filter((e) => e.label === "correct").length
  const accuracy = totalQuestions > 0 ? correctCount / totalQuestions : 0

  const evaluatedIds = evaluations.map((evaluation) => evaluation.questionId)
  const evaluatedIdSet = new Set(evaluatedIds)
  const quality =
    benchmark.protocol && totalQuestions > 0
      ? benchmark.protocol.aggregate({
          questions: questions.filter((question) => evaluatedIdSet.has(question.questionId)),
          scores: new Map(evaluations.map((evaluation) => [evaluation.questionId, evaluation.score])),
        })
      : undefined

  const searchLatencyStats = calculateLatencyStats(searchDurations)
  const qualityPct = Math.round((quality?.primaryMetric.value ?? accuracy) * 100)
  const avgLatency = searchLatencyStats.mean

  let memscore: string | undefined
  let memscoreComponents: { quality: number; latencyMs: number; contextTokens: number } | undefined
  if (tokenMetrics && allPromptTokens.length === totalQuestions) {
    memscoreComponents = {
      quality: qualityPct,
      latencyMs: avgLatency,
      contextTokens: tokenMetrics.avgContextTokens,
    }
    memscore = `${qualityPct}% / ${avgLatency}ms / ${tokenMetrics.avgContextTokens}tok`
  }

  const result: BenchmarkResult = {
    provider: checkpoint.provider,
    benchmark: checkpoint.benchmark,
    runId: checkpoint.runId,
    dataSourceRunId: checkpoint.dataSourceRunId,
    judge: checkpoint.judge,
    answeringModel: checkpoint.answeringModel,
    timestamp: new Date().toISOString(),
    summary: {
      totalQuestions,
      correctCount,
      accuracy,
    },
    latency: {
      ingest: calculateLatencyStats(ingestDurations),
      indexing: calculateLatencyStats(indexingDurations),
      search: searchLatencyStats,
      answer: calculateLatencyStats(answerDurations),
      evaluate: calculateLatencyStats(evaluateDurations),
      total: calculateLatencyStats(totalDurations),
    },
    tokens: tokenMetrics,
    contextTokenizer: tokenizerFor(getModelConfig(checkpoint.answeringModel)),
    quality,
    protocol: checkpoint.protocol,
    benchmarkConfig: checkpoint.benchmarkConfig,
    datasetIdentity: checkpoint.datasetIdentity,
    usage: summarizeRunUsage(checkpoint, evaluatedIds),
    transcriptReliance: summarizeTranscriptReliance(checkpoint, evaluatedIds),
    memscore,
    memscoreComponents,
    retrieval: overallRetrieval,
    byQuestionType,
    questionTypeRegistry: benchmark.getQuestionTypes(),
    evaluations,
  }

  return result
}

export function saveReport(result: BenchmarkResult): string {
  const reportsDir = join(REPORTS_DIR, result.runId)
  if (!existsSync(reportsDir)) {
    mkdirSync(reportsDir, { recursive: true })
  }

  const reportPath = join(reportsDir, "report.json")
  writeFileSync(reportPath, JSON.stringify(result, null, 2))

  logger.success(`Report saved to ${reportPath}`)
  return reportPath
}

function formatLatencyRow(stats: LatencyStats): string {
  const pad = (n: number) => n.toString().padStart(7)
  return `${pad(stats.min)} ${pad(stats.max)} ${pad(stats.mean)} ${pad(stats.median)} ${pad(stats.p95)} ${pad(stats.p99)}`
}

export function printReport(result: BenchmarkResult): void {
  console.log("\n" + "=".repeat(60))
  console.log("MEMORYBENCH RESULTS")
  console.log("=".repeat(60))
  console.log(`Provider: ${result.provider}`)
  console.log(`Benchmark: ${result.benchmark}`)
  console.log(`Run ID: ${result.runId}`)
  console.log(`Data Source: ${result.dataSourceRunId}`)
  console.log(`Judge: ${result.judge}`)
  console.log(`Answering Model: ${result.answeringModel}`)
  console.log("-".repeat(60))
  console.log("\nSUMMARY:")
  console.log(`  Total Questions: ${result.summary.totalQuestions}`)
  console.log(`  Correct: ${result.summary.correctCount}`)
  console.log(`  Accuracy: ${(result.summary.accuracy * 100).toFixed(2)}%`)

  if (result.quality) {
    const primary = result.quality.primaryMetric
    console.log(`  ${primary.key}: ${(primary.value * 100).toFixed(2)}`)
    console.log(
      `  Pass accuracy (score >= 0.5): ${((result.quality.metrics.passAccuracy ?? 0) * 100).toFixed(2)}%`
    )
  }

  if (result.memscore && result.tokens && result.memscoreComponents) {
    const qualityPct = result.memscoreComponents.quality
    const avgLatency = result.latency.search.mean
    console.log("")
    console.log(`  Quality:  ${qualityPct}%`)
    console.log(`  Latency:  ${avgLatency}ms (avg)`)
    console.log(
      `  Tokens:   ${result.tokens.avgContextTokens.toLocaleString()} (avg context sent to answering model)`
    )
    console.log("")
    console.log(`  MemScore: ${result.memscore}`)
  }

  if (result.usage) {
    console.log("-".repeat(60))
    console.log("\nUSAGE (API-reported):")
    const line = (label: string, summary: UsageSummary) => {
      const cost =
        summary.estimatedCostUsd === undefined ? "" : `, ~$${summary.estimatedCostUsd.toFixed(4)} list`
      const unreported =
        summary.usage.unreportedRequests > 0
          ? `, ${summary.usage.unreportedRequests} request(s) without usage`
          : ""
      console.log(
        `  ${label.padEnd(11)} ${summary.model}: ${summary.usage.requests} req, ${summary.usage.inputTokens.toLocaleString()} in / ${summary.usage.outputTokens.toLocaleString()} out${cost}${unreported}`
      )
    }
    line("Answer:", result.usage.answer)
    line("Judge:", result.usage.judge)
    if (result.usage.extraction) line("Extraction:", result.usage.extraction)
    if (result.usage.dreaming) {
      const dreaming = result.usage.dreaming
      console.log(
        `  Dreaming:   ${dreaming.passesObserved} pass(es), ${dreaming.inputTokens.toLocaleString()} in / ${dreaming.outputTokens.toLocaleString()} out${dreaming.passesWithoutUsage > 0 ? `, ${dreaming.passesWithoutUsage} without usage` : ""}`
      )
    }
    if (result.usage.ablation) {
      line("Ablation:", result.usage.ablation.answer)
      line("  judge:", result.usage.ablation.judge)
    }
    console.log(`  Answer tokens/question: ${result.usage.answerTokensPerQuestion.toLocaleString()}`)
  }

  if (result.transcriptReliance) {
    const reliance = result.transcriptReliance
    console.log("-".repeat(60))
    console.log("\nTRANSCRIPT RELIANCE (product recall vs derived-only):")
    console.log(
      `  Score:            ${(reliance.productScore * 100).toFixed(2)} product / ${(reliance.derivedOnlyScore * 100).toFixed(2)} derived-only`
    )
    console.log(
      `  Raw evidence:     ${reliance.rawEvidenceItems} item(s) in ${reliance.questionsWithRawEvidence}/${reliance.questions} question(s)`
    )
    console.log(
      `  Outcomes:         ${reliance.bothCorrect} both correct, ${reliance.onlyWithTranscripts} only with transcripts, ${reliance.onlyWithoutTranscripts} only without, ${reliance.bothWrong} both wrong`
    )
    console.log(
      `  Context tokens:   ${reliance.avgContextTokensProduct} product / ${reliance.avgContextTokensDerivedOnly} derived-only (avg)`
    )
    console.log(
      `  Answer input:     ${reliance.answerInputTokensProduct.toLocaleString()} product / ${reliance.answerInputTokensDerivedOnly.toLocaleString()} derived-only (API)`
    )
    if (reliance.extraInputTokensPerRescuedAnswer !== undefined) {
      console.log(
        `  Cost per rescue:  ${reliance.extraInputTokensPerRescuedAnswer.toLocaleString()} extra input tokens per answer only transcripts got right`
      )
    }
  }

  console.log("-".repeat(60))
  console.log("\nLATENCY (ms):")
  console.log("                    min     max    mean  median     p95     p99")
  console.log(`  Ingest:       ${formatLatencyRow(result.latency.ingest)}`)
  console.log(`  Indexing:     ${formatLatencyRow(result.latency.indexing)}`)
  console.log(`  Search:       ${formatLatencyRow(result.latency.search)}`)
  console.log(`  Answer:       ${formatLatencyRow(result.latency.answer)}`)
  console.log(`  Evaluate:     ${formatLatencyRow(result.latency.evaluate)}`)
  console.log(`  Total:        ${formatLatencyRow(result.latency.total)}`)

  if (result.retrieval) {
    console.log("-".repeat(60))
    console.log("\nRETRIEVAL QUALITY (K=" + result.retrieval.k + "):")
    console.log(`  Hit@K:      ${(result.retrieval.hitAtK * 100).toFixed(1)}%`)
    console.log(`  Precision:  ${(result.retrieval.precisionAtK * 100).toFixed(1)}%`)
    console.log(`  Recall:     ${(result.retrieval.recallAtK * 100).toFixed(1)}%`)
    console.log(`  F1:         ${(result.retrieval.f1AtK * 100).toFixed(1)}%`)
    console.log(`  MRR:        ${result.retrieval.mrr.toFixed(3)}`)
    console.log(`  NDCG:       ${result.retrieval.ndcg.toFixed(3)}`)
  }

  console.log("-".repeat(60))
  console.log("\nBY QUESTION TYPE:")
  for (const [type, stats] of Object.entries(result.byQuestionType)) {
    const typeInfo = result.questionTypeRegistry?.[type]
    const description = typeInfo?.description ? ` (${typeInfo.description})` : ""
    console.log(`  ${type}${description}:`)
    console.log(
      `    Total: ${stats.total}, Correct: ${stats.correct}, Accuracy: ${(stats.accuracy * 100).toFixed(2)}%`
    )
    console.log(
      `    Latency: search=${stats.latency.search.median}ms, answer=${stats.latency.answer.median}ms, total=${stats.latency.total.median}ms (median)`
    )
    if (stats.retrieval) {
      console.log(
        `    Retrieval: Hit@${stats.retrieval.k}=${(stats.retrieval.hitAtK * 100).toFixed(0)}%, P=${(stats.retrieval.precisionAtK * 100).toFixed(0)}%, R=${(stats.retrieval.recallAtK * 100).toFixed(0)}%, MRR=${stats.retrieval.mrr.toFixed(2)}`
      )
    }
  }
  console.log("=".repeat(60) + "\n")
}

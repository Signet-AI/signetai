import { z } from "zod"
import type {
  AnswerPlan,
  BenchmarkProtocol,
  QualityReport,
  QuestionEvaluation,
} from "../../types/benchmark"
import type { Judge } from "../../types/judge"
import type { UnifiedQuestion, UnifiedSession } from "../../types/unified"
import { addUsage, emptyUsage, type ModelUsage } from "../../utils/llm"
import { sha256Text } from "./dataset"
import {
  BEAM_EVENT_EXTRACTION_VERSION,
  BEAM_EVENT_ORDERING_SCORING_VERSION,
  BEAM_KENDALL_TAU_IMPLEMENTATION,
  evaluateBeamEventOrdering,
  extractBeamPredictedEvents,
} from "./event-ordering"
import {
  BEAM_EVENT_EQUIVALENCE_PROMPT_VERSION,
  BEAM_EVENT_EQUIVALENCE_SYSTEM_PROMPT,
  BEAM_EVENT_EQUIVALENCE_USER_PROMPT,
  BEAM_EVENT_ORDERING_ANSWER_FORMAT_VERSION,
  BEAM_NUGGET_JUDGE_PROMPT,
  BEAM_NUGGET_JUDGE_PROMPT_VERSION,
  buildBeamAnswerPrompt,
  buildBeamEventEquivalencePrompt,
  buildBeamPaperNuggetPrompt,
  type BeamMemoryLike,
} from "./prompts"
import { BEAM_QUESTION_TYPE_IDS, type BeamQuestionType, type BeamScale } from "./types"

export const BEAM_PROTOCOL_ID = "beam-paper"
export const BEAM_PROTOCOL_VERSION = "signet-1.0.0"
export const BEAM_PAPER_ID = "arXiv:2510.27246"
export const BEAM_REFERENCE_REPOSITORY = "mohammadtavakoli78/BEAM"
export const BEAM_REFERENCE_COMMIT = "3e12035532eb85768f1a7cd779832b650c4b2ef9"
export const BEAM_UPSTREAM_HARNESS =
  "supermemoryai/memorybench@1d03aa8f0dba08e329a0c7dd155ef0a0fe767870"
export const BEAM_PAPER_JUDGE_MODEL = "gpt-4.1-mini"
export const BEAM_PASS_THRESHOLD = 0.5
export const BEAM_PAPER_TOP_K_VALUES = [5, 10, 15, 20] as const
export const BEAM_DEFAULT_TOP_K = 5
export const BEAM_MAX_TOP_K = 100
export const BEAM_OFFICIAL_QUESTION_COUNTS: Record<BeamScale, number> = {
  "1M": 700,
  "10M": 200,
}
export const BEAM_EVALUATION_PROFILES = ["paper", "custom-judge"] as const
export type BeamEvaluationProfile = (typeof BEAM_EVALUATION_PROFILES)[number]

const JUDGE_MAX_OUTPUT_TOKENS = 512
const JUDGE_MAX_ATTEMPTS = 3
const STRUCTURED_OUTPUT_MODE = "text-json-parse-v1"

const nuggetJudgmentSchema = z
  .object({
    score: z.union([z.literal(0), z.literal(0.5), z.literal(1)]),
    reason: z.string().trim().min(1),
  })
  .strict()

type NuggetJudgment = z.infer<typeof nuggetJudgmentSchema> & { nugget: string }

const ABILITY_SET = new Set<string>(BEAM_QUESTION_TYPE_IDS)

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export function isBeamEvaluationProfile(value: string): value is BeamEvaluationProfile {
  return (BEAM_EVALUATION_PROFILES as readonly string[]).includes(value)
}

export function parseNuggetJudgment(text: string): z.infer<typeof nuggetJudgmentSchema> {
  const match = text.match(/\{[\s\S]*\}/)
  if (!match) throw new Error("BEAM nugget judgment did not include a JSON object")
  return nuggetJudgmentSchema.parse(JSON.parse(match[0]))
}

export function parseEventEquivalence(text: string): boolean {
  const plain = text
    .trim()
    .replace(/[*`"'.!]/g, "")
    .trim()
    .toUpperCase()
  if (plain === "YES") return true
  if (plain === "NO") return false
  const match = text.match(/\{[\s\S]*\}/)
  if (match) {
    const parsed: unknown = JSON.parse(match[0])
    if (isRecord(parsed) && (parsed.answer === "YES" || parsed.answer === "NO")) {
      return parsed.answer === "YES"
    }
  }
  throw new Error(`BEAM event equivalence must be YES or NO, got ${JSON.stringify(text)}`)
}

async function judgeWithRetries<T>(
  judge: Judge,
  usage: ModelUsage,
  prompt: string,
  parse: (text: string) => T,
  system?: string
): Promise<T> {
  let lastError: unknown
  for (let attempt = 1; attempt <= JUDGE_MAX_ATTEMPTS; attempt++) {
    try {
      const result = await judge.generate(prompt, {
        system,
        maxOutputTokens: JUDGE_MAX_OUTPUT_TOKENS,
      })
      addUsage(usage, result.usage)
      return parse(result.text)
    } catch (error) {
      lastError = error
    }
  }
  const message = lastError instanceof Error ? lastError.message : String(lastError)
  throw new Error(`BEAM judge failed after ${JUDGE_MAX_ATTEMPTS} attempts: ${message}`)
}

function getRubric(question: UnifiedQuestion): string[] {
  const rubric = question.metadata?.rubric
  if (
    !Array.isArray(rubric) ||
    rubric.length === 0 ||
    rubric.some((item) => typeof item !== "string" || item.trim().length === 0)
  ) {
    throw new Error(`BEAM question ${question.questionId} must have a non-empty string rubric`)
  }
  return rubric
}

function getScale(question: UnifiedQuestion): BeamScale {
  const scale = question.metadata?.scale
  if (scale !== "1M" && scale !== "10M") {
    throw new Error(`BEAM question ${question.questionId} has unsupported tier ${String(scale)}`)
  }
  return scale
}

export function evidenceText(result: unknown): string {
  if (typeof result === "string") return result
  if (isRecord(result)) {
    for (const key of ["memory", "content", "text", "chunk", "summary", "fact"]) {
      const value = result[key]
      if (typeof value === "string" && value.trim()) return value
    }
  }
  return JSON.stringify(result)
}

function stringFields(record: Record<string, unknown>): string[] {
  return Object.values(record).flatMap((value) => {
    if (typeof value === "string") return [value]
    if (Array.isArray(value))
      return value.filter((item): item is string => typeof item === "string")
    return []
  })
}

export function matchEvidenceSession(
  result: unknown,
  sessionIds: ReadonlySet<string>
): string | undefined {
  if (!isRecord(result)) return undefined
  const fields = [...stringFields(result)]
  if (isRecord(result.metadata)) fields.push(...stringFields(result.metadata))
  for (const field of fields) {
    for (const token of field.split(/[\s,;|:]+/)) {
      if (sessionIds.has(token)) return token
    }
  }
  return undefined
}

function mean(values: readonly number[]): number {
  if (values.length === 0) throw new Error("Cannot average an empty list")
  return values.reduce((sum, value) => sum + value, 0) / values.length
}

export class BeamProtocol implements BenchmarkProtocol {
  readonly id = BEAM_PROTOCOL_ID
  readonly version = BEAM_PROTOCOL_VERSION
  readonly profile: BeamEvaluationProfile
  readonly retrievalTopK: number
  readonly identity: Record<string, unknown>

  constructor(options: { profile?: string; retrievalTopK?: number } = {}) {
    const profile = options.profile ?? "paper"
    if (!isBeamEvaluationProfile(profile)) {
      throw new Error(
        `Unsupported BEAM evaluation profile ${profile}; expected ${BEAM_EVALUATION_PROFILES.join(" or ")}`
      )
    }
    const topK = options.retrievalTopK ?? BEAM_DEFAULT_TOP_K
    if (!Number.isInteger(topK) || topK < 1 || topK > BEAM_MAX_TOP_K) {
      throw new Error(`BEAM retrieval Top-K must be an integer from 1 to ${BEAM_MAX_TOP_K}`)
    }
    if (profile === "paper" && !(BEAM_PAPER_TOP_K_VALUES as readonly number[]).includes(topK)) {
      throw new Error(
        `The BEAM paper profile allows Top-K ${BEAM_PAPER_TOP_K_VALUES.join(", ")}; use --evaluation-profile custom-judge for other values`
      )
    }
    this.profile = profile
    this.retrievalTopK = topK
    this.identity = {
      protocolId: BEAM_PROTOCOL_ID,
      version: BEAM_PROTOCOL_VERSION,
      profile,
      paperId: BEAM_PAPER_ID,
      referenceRepository: BEAM_REFERENCE_REPOSITORY,
      referenceCommit: BEAM_REFERENCE_COMMIT,
      portedFrom: BEAM_UPSTREAM_HARNESS,
      judgeRequirement: profile === "paper" ? BEAM_PAPER_JUDGE_MODEL : "any",
      retrievalTopK: topK,
      answerCutoff: topK,
      nuggetPromptVersion: BEAM_NUGGET_JUDGE_PROMPT_VERSION,
      nuggetPromptSha256: sha256Text(BEAM_NUGGET_JUDGE_PROMPT),
      eventEquivalencePromptVersion: BEAM_EVENT_EQUIVALENCE_PROMPT_VERSION,
      eventEquivalencePromptSha256: sha256Text(
        `${BEAM_EVENT_EQUIVALENCE_SYSTEM_PROMPT}\n\n${BEAM_EVENT_EQUIVALENCE_USER_PROMPT}`
      ),
      answerPromptSha256: sha256Text(buildBeamAnswerPrompt("<question>", [], new Map())),
      eventOrderingAnswerFormatVersion: BEAM_EVENT_ORDERING_ANSWER_FORMAT_VERSION,
      kendallTauImplementation: BEAM_KENDALL_TAU_IMPLEMENTATION,
      eventExtractionVersion: BEAM_EVENT_EXTRACTION_VERSION,
      eventOrderingScoringVersion: BEAM_EVENT_ORDERING_SCORING_VERSION,
      structuredOutputMode: STRUCTURED_OUTPUT_MODE,
      judgeMaxOutputTokens: JUDGE_MAX_OUTPUT_TOKENS,
      judgeMaxAttempts: JUDGE_MAX_ATTEMPTS,
      passThreshold: BEAM_PASS_THRESHOLD,
      aggregation: "equal-macro-over-abilities",
      ingestion: "ordered-sessions-shared-per-chat-provider-readiness",
    }
  }

  assertJudge(judge: Judge): void {
    if (this.profile !== "paper") return
    if (
      judge.modelConfig.provider !== "openai" ||
      judge.modelConfig.id !== BEAM_PAPER_JUDGE_MODEL
    ) {
      throw new Error(
        `The BEAM paper profile requires judge ${BEAM_PAPER_JUDGE_MODEL}; got ${judge.modelAlias}. Use --evaluation-profile custom-judge to score with a different judge (reported as beamRubricScore, not beamScore).`
      )
    }
  }

  createAnswerPlan(input: {
    question: UnifiedQuestion
    sessions: UnifiedSession[]
    results: unknown[]
  }): AnswerPlan {
    const evidence = input.results.slice(0, this.retrievalTopK)
    const dates = new Map<string, string>()
    for (const session of input.sessions) {
      const date = session.metadata?.documentDate
      if (typeof date === "string") dates.set(session.sessionId, date)
    }
    const sessionIds = new Set(input.sessions.map((session) => session.sessionId))
    const memories: BeamMemoryLike[] = evidence.map((result) => {
      const sessionId = matchEvidenceSession(result, sessionIds)
      return { content: evidenceText(result), ...(sessionId ? { metadata: { sessionId } } : {}) }
    })
    const format =
      input.question.questionType === "event_ordering" ? "event-ordering-lines" : "default"
    return {
      prompt: buildBeamAnswerPrompt(input.question.question, memories, dates, format),
      basePrompt: buildBeamAnswerPrompt(input.question.question, [], dates, format),
      evidenceCount: evidence.length,
    }
  }

  async evaluateQuestion(input: {
    question: UnifiedQuestion
    hypothesis: string
    judge: Judge
  }): Promise<QuestionEvaluation> {
    const { question, hypothesis, judge } = input
    this.assertJudge(judge)
    const rubric = getRubric(question)
    const usage = emptyUsage()

    if (question.questionType === "event_ordering") {
      const eventScore = await evaluateBeamEventOrdering({
        referenceEvents: rubric,
        predictedEvents: extractBeamPredictedEvents(hypothesis),
        equivalent: ({ referenceEvent, predictedEvent }) =>
          judgeWithRetries(
            judge,
            usage,
            buildBeamEventEquivalencePrompt({ referenceEvent, predictedEvent }),
            parseEventEquivalence,
            BEAM_EVENT_EQUIVALENCE_SYSTEM_PROMPT
          ),
      })
      const score = eventScore.normalizedKendallTauB
      return {
        score,
        passed: score >= BEAM_PASS_THRESHOLD,
        explanation: `BEAM event-ordering score (normalized Kendall tau-b): ${score.toFixed(4)}`,
        metrics: {
          kendallTauB: eventScore.kendall.tauB,
          normalizedKendallTauB: score,
          eventPrecision: eventScore.precision,
          eventRecall: eventScore.recall,
          eventF1: eventScore.f1,
        },
        details: { eventOrdering: eventScore },
        usage,
      }
    }

    const judgments: NuggetJudgment[] = []
    for (const nugget of rubric) {
      const judgment = await judgeWithRetries(
        judge,
        usage,
        buildBeamPaperNuggetPrompt({ question: question.question, nugget, answer: hypothesis }),
        parseNuggetJudgment
      )
      judgments.push({ nugget, ...judgment })
    }
    const score = mean(judgments.map((judgment) => judgment.score))
    return {
      score,
      passed: score >= BEAM_PASS_THRESHOLD,
      explanation: `BEAM nugget average: ${score.toFixed(4)}`,
      metrics: { nuggetAverage: score, nuggetCount: judgments.length },
      details: { nuggetJudgments: judgments },
      usage,
    }
  }

  aggregate(input: {
    questions: UnifiedQuestion[]
    scores: ReadonlyMap<string, number>
  }): QualityReport {
    const scored = input.questions.filter((question) => input.scores.has(question.questionId))
    if (scored.length === 0) throw new Error("Cannot aggregate a BEAM run with no evaluations")

    const scales = new Set(scored.map(getScale))
    if (scales.size !== 1) throw new Error("A BEAM report must cover exactly one tier")
    const scale = getScale(scored[0]!)

    const byAbility = new Map<BeamQuestionType, number[]>()
    for (const question of scored) {
      if (!ABILITY_SET.has(question.questionType)) {
        throw new Error(`Unsupported BEAM ability ${question.questionType}`)
      }
      const score = input.scores.get(question.questionId)!
      if (!Number.isFinite(score) || score < 0 || score > 1) {
        throw new Error(`Invalid BEAM score for ${question.questionId}`)
      }
      const ability = question.questionType as BeamQuestionType
      byAbility.set(ability, [...(byAbility.get(ability) ?? []), score])
    }

    const bySlice: Record<string, Record<string, number>> = {}
    const abilityScores: number[] = []
    let passed = 0
    for (const ability of BEAM_QUESTION_TYPE_IDS) {
      const scores = byAbility.get(ability)
      if (!scores) continue
      const average = mean(scores)
      const abilityPassed = scores.filter((score) => score >= BEAM_PASS_THRESHOLD).length
      abilityScores.push(average)
      passed += abilityPassed
      bySlice[ability] = {
        averageScore: average,
        passAccuracy: abilityPassed / scores.length,
        questionCount: scores.length,
      }
    }

    const expected = BEAM_OFFICIAL_QUESTION_COUNTS[scale]
    const perAbility = expected / BEAM_QUESTION_TYPE_IDS.length
    const official =
      scored.length === expected &&
      BEAM_QUESTION_TYPE_IDS.every((ability) => byAbility.get(ability)?.length === perAbility)
    const base = this.profile === "paper" ? "beamScore" : "beamRubricScore"
    const key = official ? base : `${base}Partial`
    const value = mean(abilityScores)

    return {
      primaryMetric: { key, value },
      metrics: {
        [key]: value,
        passAccuracy: passed / scored.length,
        questionCount: scored.length,
        coveredAbilities: abilityScores.length,
        officialQuestionSet: official ? 1 : 0,
      },
      bySlice,
    }
  }
}

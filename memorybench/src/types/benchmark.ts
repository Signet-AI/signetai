import type { UnifiedQuestion, UnifiedSession, QuestionTypeRegistry } from "./unified"
import type { Judge } from "./judge"
import type { ModelUsage } from "../utils/llm"

export interface BenchmarkConfig {
  dataPath?: string
  datasetRevision?: string
  retrievalTopK?: number
  evaluationProfile?: string
}

export interface QuestionFilter {
  questionTypes?: string[]
  limit?: number
  offset?: number
}

export interface AnswerPlan {
  prompt: string
  basePrompt: string
  evidenceCount: number
}

export interface QuestionEvaluation {
  score: number
  passed: boolean
  explanation: string
  metrics?: Record<string, number>
  details?: Record<string, unknown>
  usage: ModelUsage
}

export interface QualityReport {
  primaryMetric: { key: string; value: number }
  metrics: Record<string, number>
  bySlice: Record<string, Record<string, number>>
}

export interface BenchmarkProtocol {
  id: string
  version: string
  profile: string
  identity: Record<string, unknown>
  retrievalTopK: number
  assertJudge(judge: Judge): void
  createAnswerPlan(input: {
    question: UnifiedQuestion
    sessions: UnifiedSession[]
    results: unknown[]
  }): AnswerPlan
  evaluateQuestion(input: {
    question: UnifiedQuestion
    hypothesis: string
    judge: Judge
  }): Promise<QuestionEvaluation>
  aggregate(input: {
    questions: UnifiedQuestion[]
    scores: ReadonlyMap<string, number>
  }): QualityReport
}

export interface Benchmark {
  name: string
  protocol?: BenchmarkProtocol
  load(config?: BenchmarkConfig): Promise<void>
  getQuestions(filter?: QuestionFilter): UnifiedQuestion[]
  getHaystackSessions(questionId: string): UnifiedSession[]
  getGroundTruth(questionId: string): string
  getQuestionTypes(): QuestionTypeRegistry
  getIngestionGroupId?(questionId: string): string
  getDatasetIdentity?(): Record<string, unknown> | undefined
}

export type BenchmarkName =
  | "locomo"
  | "longmemeval"
  | "convomem"
  | "dreaming-scenarios"
  | "beam-1m"
  | "beam-10m"

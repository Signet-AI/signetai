import type { LanguageModel } from "ai"
import type { ProviderPrompts } from "./prompts"
import type { GenerateOptions, GenerateResult, ModelUsage } from "../utils/llm"
import type { ModelConfig } from "../utils/models"

export interface JudgeInput {
  question: string
  questionType: string
  groundTruth: string
  hypothesis: string
  context?: string
  providerPrompts?: ProviderPrompts
}

export interface JudgeResult {
  score: number
  label: "correct" | "incorrect"
  explanation: string
  usage?: ModelUsage
}

export interface Judge {
  name: string
  modelAlias: string
  modelConfig: ModelConfig
  evaluate(input: JudgeInput): Promise<JudgeResult>
  generate(prompt: string, options?: GenerateOptions): Promise<GenerateResult>
  getModel(): LanguageModel
}

import type { Judge, JudgeInput, JudgeResult } from "../types/judge"
import { getModelConfig, type ModelConfig } from "../utils/models"
import {
  assertModelCredentials,
  generateWithModel,
  getLanguageModel,
  type GenerateOptions,
  type GenerateResult,
} from "../utils/llm"
import { buildJudgePrompt, parseJudgeResponse } from "./base"

export class ModelJudge implements Judge {
  readonly name: string
  readonly modelAlias: string
  readonly modelConfig: ModelConfig

  constructor(modelAlias: string) {
    this.modelAlias = modelAlias
    this.modelConfig = getModelConfig(modelAlias)
    this.name = `${this.modelConfig.provider}:${this.modelConfig.displayName}`
    assertModelCredentials(this.modelConfig)
  }

  async evaluate(input: JudgeInput): Promise<JudgeResult> {
    const { text, usage } = await generateWithModel(this.modelConfig, buildJudgePrompt(input))
    return { ...parseJudgeResponse(text), usage }
  }

  generate(prompt: string, options?: GenerateOptions): Promise<GenerateResult> {
    return generateWithModel(this.modelConfig, prompt, options)
  }

  getModel(): ReturnType<typeof getLanguageModel> {
    return getLanguageModel(this.modelConfig)
  }
}

export function createJudge(modelAlias: string): Judge {
  return new ModelJudge(modelAlias)
}

export { buildJudgePrompt, parseJudgeResponse, getJudgePrompt } from "./base"

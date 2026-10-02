import { generateText, type LanguageModel } from "ai"
import type { Judge, JudgeConfig, JudgeInput, JudgeName, JudgeResult } from "../types/judge"
import type { ProviderPrompts } from "../types/prompts"
import { buildJudgePrompt, getJudgePrompt, parseJudgeResponse } from "./base"
import { logger } from "../utils/logger"
import { getModelConfig, type ModelConfig } from "../utils/models"

type LanguageModelFactory = (modelId: string) => LanguageModel
type ProviderClientFactory = (apiKey: string) => LanguageModelFactory

const JUDGE_DISPLAY_NAMES: Record<string, string> = {
  openai: "OpenAI",
  anthropic: "Anthropic",
  google: "Google",
}

export class ProviderJudge implements Judge {
  name: string
  private modelConfig: ModelConfig | null = null
  private client: LanguageModelFactory | null = null

  constructor(
    name: JudgeName,
    private readonly defaultModel: string,
    private readonly createClient: ProviderClientFactory
  ) {
    this.name = name
  }

  async initialize(config: JudgeConfig): Promise<void> {
    this.client = this.createClient(config.apiKey)
    const modelAlias = config.model || this.defaultModel
    this.modelConfig = getModelConfig(modelAlias)
    logger.info(
      `Initialized ${JUDGE_DISPLAY_NAMES[this.name] ?? this.name} judge with model: ${this.modelConfig.displayName} (${this.modelConfig.id})`
    )
  }

  async evaluate(input: JudgeInput): Promise<JudgeResult> {
    const { client, modelConfig } = this.initialized()
    const params: Record<string, unknown> = {
      model: client(modelConfig.id),
      prompt: buildJudgePrompt(input),
    }

    if (modelConfig.supportsTemperature) {
      params.temperature = modelConfig.defaultTemperature
    }

    params.maxTokens = modelConfig.defaultMaxTokens

    const { text } = await generateText(params as Parameters<typeof generateText>[0])
    return parseJudgeResponse(text)
  }

  getPromptForQuestionType(questionType: string, providerPrompts?: ProviderPrompts): string {
    return getJudgePrompt(questionType, providerPrompts)
  }

  getModel(): LanguageModel {
    const { client, modelConfig } = this.initialized()
    return client(modelConfig.id)
  }

  private initialized(): { client: LanguageModelFactory; modelConfig: ModelConfig } {
    if (!this.client || !this.modelConfig) throw new Error("Judge not initialized")
    return { client: this.client, modelConfig: this.modelConfig }
  }
}

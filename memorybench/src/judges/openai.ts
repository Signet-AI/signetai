import { DEFAULT_JUDGE_MODELS } from "../utils/models"
import { createConfiguredOpenAI } from "../utils/config"
import { ProviderJudge } from "./provider"

export class OpenAIJudge extends ProviderJudge {
  constructor() {
    super("openai", DEFAULT_JUDGE_MODELS.openai, createConfiguredOpenAI)
  }
}

export default OpenAIJudge

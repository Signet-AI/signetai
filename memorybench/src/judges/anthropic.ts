import { createAnthropic } from "@ai-sdk/anthropic"
import { DEFAULT_JUDGE_MODELS } from "../utils/models"
import { ProviderJudge } from "./provider"

export class AnthropicJudge extends ProviderJudge {
  constructor() {
    super("anthropic", DEFAULT_JUDGE_MODELS.anthropic, (apiKey) => createAnthropic({ apiKey }))
  }
}

export default AnthropicJudge

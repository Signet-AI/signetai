import { createGoogleGenerativeAI } from "@ai-sdk/google"
import { DEFAULT_JUDGE_MODELS } from "../utils/models"
import { ProviderJudge } from "./provider"

export class GoogleJudge extends ProviderJudge {
  constructor() {
    super("google", DEFAULT_JUDGE_MODELS.google, (apiKey) => createGoogleGenerativeAI({ apiKey }))
  }
}

export default GoogleJudge

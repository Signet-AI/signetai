import { describe, expect, it } from "bun:test"
import { getModelConfig } from "./models"

describe("getModelConfig", () => {
  it("omits temperature for local GGUF OpenAI-compatible models", () => {
    const cfg = getModelConfig("google_gemma-4-26B-A4B-it-Q5_K_M.gguf")

    expect(cfg.provider).toBe("openai")
    expect(cfg.supportsTemperature).toBe(false)
    expect(cfg.id).toBe("google_gemma-4-26B-A4B-it-Q5_K_M.gguf")
  })

  it("omits temperature for Mercury OpenRouter models", () => {
    expect(getModelConfig("inception/mercury-2").supportsTemperature).toBe(false)
  })

  it("keeps ordinary OpenAI-compatible chat models temperature-capable", () => {
    expect(getModelConfig("gpt-4.1-mini").supportsTemperature).toBe(true)
    expect(getModelConfig("custom-openai-model").supportsTemperature).toBe(true)
  })
})

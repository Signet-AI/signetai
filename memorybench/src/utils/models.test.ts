import { describe, expect, it } from "bun:test"
import { getModelConfig, openRouterModelSettings } from "./models"

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

  it("routes local: aliases to the local chat-completions provider with server sampling", () => {
    const cfg = getModelConfig("local:qwen3.8-27b", {})

    expect(cfg.provider).toBe("local")
    expect(cfg.id).toBe("qwen3.8-27b")
    expect(cfg.supportsTemperature).toBe(false)
    expect(cfg.defaultMaxTokens).toBe(16_000)
    expect(cfg.reasoningEffort).toBeUndefined()
  })

  it("reads local reasoning effort and output budget from the environment", () => {
    const cfg = getModelConfig("local:qwen3.8-27b", {
      MEMORYBENCH_LOCAL_REASONING_EFFORT: "low",
      MEMORYBENCH_LOCAL_MAX_TOKENS: "4096",
    })

    expect(cfg.reasoningEffort).toBe("low")
    expect(cfg.defaultMaxTokens).toBe(4096)
  })

  it("rejects a local alias without a model id", () => {
    expect(() => getModelConfig("local:", {})).toThrow("missing a model id")
  })

  it("routes openrouter: aliases to the openrouter provider", () => {
    const cfg = getModelConfig("openrouter:openai/gpt-4o-2024-08-06")

    expect(cfg.provider).toBe("openrouter")
    expect(cfg.id).toBe("openai/gpt-4o-2024-08-06")
    expect(cfg.displayName).toBe("openai/gpt-4o-2024-08-06 (openrouter)")
    expect(cfg.supportsTemperature).toBe(true)
    expect(cfg.defaultTemperature).toBe(0)
    expect(cfg.maxTokensParam).toBe("maxTokens")
    expect(cfg.defaultMaxTokens).toBe(1000)
  })

  it("rejects an openrouter alias without a model id", () => {
    expect(() => getModelConfig("openrouter:", {})).toThrow("missing a model id")
  })

  it("reads per-model routing settings from MEMORYBENCH_OPENROUTER_MODELS", () => {
    const cfg = getModelConfig("openrouter:openai/gpt-4o-2024-08-06", {
      MEMORYBENCH_OPENROUTER_MODELS: JSON.stringify({
        "openai/gpt-4o-2024-08-06": {
          provider: { quantizations: ["fp8"], allow_fallbacks: true },
          reasoning: { enabled: false },
          maxTokens: 2048,
        },
      }),
    })

    expect(cfg.defaultMaxTokens).toBe(2048)
    expect(cfg.openrouterSettings).toEqual({
      provider: { quantizations: ["fp8"], allow_fallbacks: true },
      reasoning: { enabled: false },
    })
  })

  it("gives openrouter models absent from the settings map no extra settings", () => {
    const cfg = getModelConfig("openrouter:openai/gpt-4o-2024-08-06", {
      MEMORYBENCH_OPENROUTER_MODELS: JSON.stringify({ "other/model": {} }),
    })

    expect(cfg.defaultMaxTokens).toBe(1000)
    expect(cfg.openrouterSettings).toBeUndefined()
  })

  it("rejects invalid MEMORYBENCH_OPENROUTER_MODELS config", () => {
    const env = (value: string) => ({ MEMORYBENCH_OPENROUTER_MODELS: value })
    expect(() => getModelConfig("openrouter:m", env("{not json"))).toThrow(
      "MEMORYBENCH_OPENROUTER_MODELS is not valid JSON"
    )
    expect(() => getModelConfig("openrouter:m", env("[]"))).toThrow(
      "must be a JSON object keyed by model id"
    )
    expect(() => getModelConfig("openrouter:m", env('{"m": 3}'))).toThrow(
      "entry for m must be an object"
    )
    expect(() => getModelConfig("openrouter:m", env('{"m": {"quantizations": []}}'))).toThrow(
      'unknown key "quantizations"'
    )
    expect(() => getModelConfig("openrouter:m", env('{"m": {"provider": 3}}'))).toThrow(
      'non-object "provider"'
    )
    expect(() => getModelConfig("openrouter:m", env('{"m": {"maxTokens": 0}}'))).toThrow(
      'invalid "maxTokens"'
    )
  })
})

describe("openRouterModelSettings", () => {
  it("throws naming an entry whose model the run does not use", () => {
    const env = {
      MEMORYBENCH_OPENROUTER_MODELS: JSON.stringify({
        "unused/model": { provider: { order: ["a"] } },
        "used/model": { maxTokens: 2048 },
      }),
    }
    expect(() => openRouterModelSettings(["openrouter:used/model"], env)).toThrow(
      "MEMORYBENCH_OPENROUTER_MODELS has an entry for a model this run does not use: unused/model"
    )
    expect(() => openRouterModelSettings(["glm-5.3-flash"], env)).toThrow("unused/model")
    expect(() =>
      openRouterModelSettings(["openrouter:used/model", "openrouter:unused/model"], env)
    ).not.toThrow()
  })

  it("records the effective maxTokens next to each used model's settings", () => {
    const env = {
      MEMORYBENCH_OPENROUTER_MODELS: JSON.stringify({ "used/model": { maxTokens: 2048 } }),
    }
    expect(openRouterModelSettings(["openrouter:used/model", "openrouter:other/model"], env)).toEqual({
      "openrouter:used/model": { maxTokens: 2048 },
      "openrouter:other/model": { maxTokens: 1000 },
    })
    expect(openRouterModelSettings(["glm-5.3-flash"], {})).toEqual({})
  })
})

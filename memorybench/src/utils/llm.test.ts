import { afterEach, describe, expect, it } from "bun:test"
import { config } from "./config"
import { estimateCostUsd, generateWithModel } from "./llm"
import { getModelConfig } from "./models"

interface RecordedRequest {
  path: string
  authorization: string | null
  body: Record<string, unknown>
}

const saved = {
  zaiApiKey: config.zaiApiKey,
  zaiBaseUrl: config.zaiBaseUrl,
  openaiApiKey: config.openaiApiKey,
  openaiBaseUrl: config.openaiBaseUrl,
}

afterEach(() => {
  Object.assign(config, saved)
})

function serve(response: (request: RecordedRequest) => Response): {
  url: string
  requests: RecordedRequest[]
  stop: () => void
} {
  const requests: RecordedRequest[] = []
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: async (request) => {
      const recorded = {
        path: new URL(request.url).pathname,
        authorization: request.headers.get("authorization"),
        body: (await request.json()) as Record<string, unknown>,
      }
      requests.push(recorded)
      return response(recorded)
    },
  })
  return {
    url: `http://127.0.0.1:${server.port}/api/coding/paas/v4`,
    requests,
    stop: () => server.stop(true),
  }
}

function chatCompletion(text: string): Response {
  return Response.json({
    id: "chatcmpl-test",
    object: "chat.completion",
    created: 1,
    model: "glm-5.3-flash",
    choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }],
    usage: {
      prompt_tokens: 120,
      completion_tokens: 30,
      total_tokens: 150,
      prompt_tokens_details: { cached_tokens: 20 },
      completion_tokens_details: { reasoning_tokens: 12 },
    },
  })
}

describe("Z.ai GLM transport", () => {
  it("sends Chat Completions with thinking disabled and the output cap", async () => {
    const server = serve(() => chatCompletion("Paris"))
    config.zaiBaseUrl = server.url
    config.zaiApiKey = "zai-test-key"
    try {
      const result = await generateWithModel(getModelConfig("glm-5.3-flash"), "Capital of France?")

      expect(result.text).toBe("Paris")
      expect(server.requests).toHaveLength(1)
      const request = server.requests[0]!
      expect(request.path).toBe("/api/coding/paas/v4/chat/completions")
      expect(request.authorization).toBe("Bearer zai-test-key")
      expect(request.body.model).toBe("glm-5.3-flash")
      expect(request.body.thinking).toEqual({ type: "disabled" })
      expect(request.body.max_tokens).toBe(1000)
      expect(request.body.temperature).toBe(0)
      expect(result.usage).toEqual({
        requests: 1,
        unreportedRequests: 0,
        inputTokens: 120,
        outputTokens: 30,
        reasoningTokens: 12,
        cachedInputTokens: 20,
      })
    } finally {
      server.stop()
    }
  })

  it("enables thinking with a larger cap and no temperature for the thinking alias", async () => {
    const server = serve(() => chatCompletion("Paris"))
    config.zaiBaseUrl = server.url
    config.zaiApiKey = "zai-test-key"
    try {
      await generateWithModel(getModelConfig("glm-5.3-flash-thinking"), "Capital of France?")

      const body = server.requests[0]!.body
      expect(body.model).toBe("glm-5.3-flash")
      expect(body.thinking).toEqual({ type: "enabled" })
      expect(body.max_tokens).toBe(16000)
      expect(body.temperature).toBeUndefined()
    } finally {
      server.stop()
    }
  })

  it("sends system prompts with the system role Z.ai supports", async () => {
    const server = serve(() => chatCompletion("YES"))
    config.zaiBaseUrl = server.url
    config.zaiApiKey = "zai-test-key"
    try {
      await generateWithModel(getModelConfig("glm-5.3-flash"), "First snippet: a", {
        system: "You are a binary classifier.",
        maxOutputTokens: 512,
      })

      const body = server.requests[0]!.body
      expect(body.messages).toEqual([
        { role: "system", content: "You are a binary classifier." },
        { role: "user", content: "First snippet: a" },
      ])
      expect(body.max_tokens).toBe(512)
    } finally {
      server.stop()
    }
  })

  it("enforces the configured output cap on OpenAI models", async () => {
    const server = serve(() =>
      Response.json({
        id: "resp_test",
        created_at: 1,
        model: "gpt-4o",
        status: "completed",
        output: [
          {
            id: "msg_test",
            type: "message",
            role: "assistant",
            status: "completed",
            content: [{ type: "output_text", text: "4", annotations: [] }],
          },
        ],
        usage: { input_tokens: 5, output_tokens: 1 },
      })
    )
    config.openaiBaseUrl = server.url
    config.openaiApiKey = "openai-test-key"
    try {
      await generateWithModel(getModelConfig("gpt-4o"), "2 + 2?")
      expect(server.requests[0]!.body.max_output_tokens).toBe(1000)
    } finally {
      server.stop()
    }
  })
})

describe("estimateCostUsd", () => {
  it("prices GLM usage at list rates with cached input discounted", () => {
    const cost = estimateCostUsd(getModelConfig("glm-5.3-flash"), {
      requests: 1,
      unreportedRequests: 0,
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
      reasoningTokens: 0,
      cachedInputTokens: 500_000,
    })
    expect(cost).toBeCloseTo(0.5 * 0.15 + 0.5 * 0.03 + 0.5, 10)
  })

  it("refuses to price usage that the API did not report", () => {
    expect(
      estimateCostUsd(getModelConfig("glm-5.3-flash"), {
        requests: 2,
        unreportedRequests: 1,
        inputTokens: 10,
        outputTokens: 10,
        reasoningTokens: 0,
        cachedInputTokens: 0,
      })
    ).toBeUndefined()
  })

  it("leaves models without pricing unpriced", () => {
    expect(
      estimateCostUsd(getModelConfig("gpt-4o"), {
        requests: 1,
        unreportedRequests: 0,
        inputTokens: 10,
        outputTokens: 10,
        reasoningTokens: 0,
        cachedInputTokens: 0,
      })
    ).toBeUndefined()
  })
})

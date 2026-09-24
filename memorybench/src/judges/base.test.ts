import { describe, expect, it } from "bun:test"
import type { JudgeResult } from "../types/judge"
import { config } from "../utils/config"
import { OpenAIJudge } from "./openai"

async function run(content: string): Promise<JudgeResult> {
  const previousBaseUrl = config.openaiBaseUrl
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: () =>
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
            content: [{ type: "output_text", text: content, annotations: [] }],
          },
        ],
        usage: { input_tokens: 1, output_tokens: 1 },
      }),
  })
  config.openaiBaseUrl = `http://127.0.0.1:${server.port}/v1`

  try {
    const judge = new OpenAIJudge()
    await judge.initialize({ apiKey: "local-test", model: "gpt-4o" })
    return await judge.evaluate({
      question: "What is 2 + 2?",
      questionType: "default",
      groundTruth: "4",
      hypothesis: "5",
    })
  } finally {
    server.stop(true)
    config.openaiBaseUrl = previousBaseUrl
  }
}

describe("OpenAIJudge response parsing", () => {
  it("accepts a valid JSON verdict", async () => {
    await expect(
      run('{"score":1,"label":"correct","explanation":"The answer is 4."}')
    ).resolves.toEqual({
      score: 1,
      label: "correct",
      explanation: "The answer is 4.",
    })
  })

  it("rejects unstructured text that happens to contain correct", async () => {
    await expect(
      run('The output is malformed, but the label "correct" should be used.')
    ).rejects.toThrow("Judge response")
  })

  it("rejects contradictory score and label fields", async () => {
    await expect(
      run('{"score":1,"label":"incorrect","explanation":"The answer is wrong."}')
    ).rejects.toThrow("Judge response")
  })

  it("rejects non-string explanations", async () => {
    await expect(
      run('{"score":0,"label":"incorrect","explanation":{"detail":"wrong"}}')
    ).rejects.toThrow("Judge response")
  })
})

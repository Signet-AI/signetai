import { describe, expect, test } from "bun:test"
import { SignetProvider } from "./index"
import type { UnifiedSession } from "../../types/unified"

class FailingSignetProvider extends SignetProvider {
  protected override async extractStructured(): Promise<never> {
    throw new Error("synthetic extraction failure")
  }
}

const session: UnifiedSession = {
  sessionId: "session-fails-extraction",
  messages: [{ role: "user", content: "I like lavender shampoo." }],
}

describe("Signet structured ingest integrity", () => {
  test("fails the ingest when structured extraction fails for a session", async () => {
    const provider = new FailingSignetProvider()
    Object.assign(provider, { openai: {} })

    await expect(provider.ingest([session], { containerTag: "question-run" })).rejects.toThrow(
      "Structured extraction failed for session session-fails-extraction"
    )
  })
})

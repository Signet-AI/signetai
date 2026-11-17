import { describe, expect, it } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { LoCoMoBenchmark } from "./index"
import type { LoCoMoItem } from "./types"

function conversation(sampleId: string): LoCoMoItem {
  return {
    sample_id: sampleId,
    qa: [
      { question: "q1", answer: "a1", evidence: ["1"], category: 1 },
      { question: "q2", answer: "a2", evidence: ["2"], category: 2 },
    ],
    conversation: {
      speaker_a: "Alice",
      speaker_b: "Bob",
      session_1: [
        { speaker: "Alice", dia_id: `${sampleId}-1`, text: "hello" },
        { speaker: "Bob", dia_id: `${sampleId}-2`, text: "hi" },
      ],
      session_1_date_time: "10:00 am on 5 march, 2023",
    },
    event_summary: {},
    observation: {},
    session_summary: {},
  }
}

describe("LoCoMo ingestion groups", () => {
  it("groups questions from the same conversation and separates conversations", async () => {
    const dir = mkdtempSync(".locomo-test-")
    const dataPath = `${dir}/locomo.json`
    writeFileSync(dataPath, JSON.stringify([conversation("conv-1"), conversation("conv-2")]))
    try {
      const benchmark = new LoCoMoBenchmark()
      await benchmark.load({ dataPath })

      const questions = benchmark.getQuestions()
      expect(questions).toHaveLength(4)
      expect(benchmark.getIngestionGroupId(questions[0]!.questionId)).toBe("conv-1")
      expect(benchmark.getIngestionGroupId(questions[1]!.questionId)).toBe("conv-1")
      expect(benchmark.getIngestionGroupId(questions[2]!.questionId)).toBe("conv-2")
      expect(benchmark.getIngestionGroupId(questions[0]!.questionId)).not.toBe(
        benchmark.getIngestionGroupId(questions[2]!.questionId)
      )
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

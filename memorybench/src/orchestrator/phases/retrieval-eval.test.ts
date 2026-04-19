import { describe, expect, test } from "bun:test"
import type { LanguageModel } from "ai"
import { calculateRetrievalMetrics } from "./retrieval-eval"

const unusedModel = {} as LanguageModel

describe("calculateRetrievalMetrics", () => {
  test("uses benchmark relevant session ids when results preserve source tags", async () => {
    const metrics = await calculateRetrievalMetrics(
      unusedModel,
      "How should I stay connected with colleagues?",
      "Use previous remote-work context.",
      [
        {
          tags: "memorybench,54026fce-run,54026fce-session-34,structured",
          content: "Remote concerts and fan livestreams.",
        },
        {
          tags: "memorybench,54026fce-run,54026fce-session-26,structured",
          content: "The user misses social interactions while working from home.",
        },
      ],
      5,
      ["54026fce-session-26"]
    )

    expect(metrics.hitAtK).toBe(1)
    expect(metrics.precisionAtK).toBe(0.5)
    expect(metrics.recallAtK).toBe(1)
    expect(metrics.mrr).toBe(0.5)
    expect(metrics.ndcg).toBeCloseTo(0.6309, 3)
    expect(metrics.relevantRetrieved).toBe(1)
    expect(metrics.totalRelevant).toBe(1)
  })

  test("does not call the judge model when relevant ids are available", async () => {
    const metrics = await calculateRetrievalMetrics(
      unusedModel,
      "What sugar should I use?",
      "The user prefers turbinado sugar.",
      [
        {
          metadata: { sourceId: "38146c39-run:38146c39-session-8" },
          content: "The user prefers turbinado sugar in cookies.",
        },
      ],
      5,
      ["38146c39-session-8"]
    )

    expect(metrics.hitAtK).toBe(1)
    expect(metrics.mrr).toBe(1)
    expect(metrics.ndcg).toBe(1)
  })

  test("does not let duplicate hits for one relevant session push NDCG above 1", async () => {
    const metrics = await calculateRetrievalMetrics(
      unusedModel,
      "What should I do with colleagues?",
      "Use previous remote-work context.",
      [
        {
          tags: "memorybench,run,54026fce-session-26,structured",
          content: "The user misses social interactions while working from home.",
        },
        {
          source_id: "run:54026fce-session-26",
          content: "A second chunk from the same virtual coffee break session.",
        },
      ],
      5,
      ["54026fce-session-26"]
    )

    expect(metrics.hitAtK).toBe(1)
    expect(metrics.relevantRetrieved).toBe(1)
    expect(metrics.ndcg).toBeLessThanOrEqual(1)
    expect(metrics.ndcg).toBe(1)
  })
})

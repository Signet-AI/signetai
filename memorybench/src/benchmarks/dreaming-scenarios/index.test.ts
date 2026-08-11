import { describe, expect, it } from "bun:test"
import { createBenchmark, getAvailableBenchmarks } from ".."
import { DreamingScenariosBenchmark, parseDreamingScenarioCorpus } from "."

describe("Dreaming scenario MemoryBench gate", () => {
  it("loads the committed deterministic corpus without a dataset download", async () => {
    const benchmark = new DreamingScenariosBenchmark()
    await benchmark.load()

    const questions = benchmark.getQuestions()
    expect(questions.map((question) => question.questionId)).toEqual([
      "joined-source-promotion",
      "correction-and-contradiction",
      "cross-scope-isolation",
      "rejected-evidence-repair",
    ])
    expect(questions.every((question) => question.metadata?.requiresExactSourceRefs === true)).toBe(true)
    expect(questions.every((question) => question.relevantSessionIds && question.relevantSessionIds.length > 0)).toBe(true)
    expect(questions.every((question) => Array.isArray(question.metadata?.sourceSessionIds))).toBe(true)
    expect(questions.every((question) => typeof question.metadata?.semanticOutcome === "object")).toBe(true)
    expect(questions.find((question) => question.questionId === "joined-source-promotion")?.metadata).toMatchObject({
      sourceSessionIds: ["atlas-confirmation"],
      semanticOutcome: {
        entity: "Atlas deployment",
        aspect: "runtime",
        claimKey: "deployment-runtime",
        value: "The Atlas deployment runs on the edge runtime.",
      },
    })

    const isolationSessions = benchmark.getHaystackSessions("cross-scope-isolation")
    expect(isolationSessions.map((session) => session.metadata?.agentId)).toEqual([
      "dreaming-gate-alpha",
      "dreaming-gate-beta",
    ])
  })

  it("registers the corpus through the standard MemoryBench registry", async () => {
    expect(getAvailableBenchmarks()).toContain("dreaming-scenarios")
    const benchmark = createBenchmark("dreaming-scenarios")
    await benchmark.load()
    expect(benchmark.getGroundTruth("correction-and-contradiction")).toBe("Meridian now uses PostgreSQL.")
  })

  it("rejects a source quote that is not grounded in a committed session", () => {
    expect(() =>
      parseDreamingScenarioCorpus({
        schemaVersion: 1,
        name: "invalid",
        scenarios: [
          {
            id: "invalid-scenario",
            agentId: "scope",
            question: "What changed?",
            groundTruth: "A fact changed.",
            sessions: [
              {
                id: "session",
                date: "2026-01-01T00:00:00.000Z",
                messages: [{ role: "user", content: "A different fact." }],
              },
            ],
            expected: {
              relevantSessionIds: ["session"],
              sourceQuotes: ["Ungrounded quote."],
              sourceSessionIds: ["session"],
              requiresExactSourceRefs: true,
              semanticOutcome: {
                entity: "Invalid scenario",
                aspect: "validation",
                claimKey: "grounding",
                value: "A fact changed.",
              },
            },
          },
        ],
      })
    ).toThrow("source quote is not present")
  })
})

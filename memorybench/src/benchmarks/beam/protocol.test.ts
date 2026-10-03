import { describe, expect, it } from "bun:test"
import type { Judge } from "../../types/judge"
import type { UnifiedQuestion, UnifiedSession } from "../../types/unified"
import type { GenerateResult } from "../../utils/llm"
import { getModelConfig } from "../../utils/models"
import {
  BeamProtocol,
  matchEvidenceSession,
  parseEventEquivalence,
  parseNuggetJudgment,
} from "./protocol"
import { BEAM_QUESTION_TYPE_IDS } from "./types"

function reply(text: string): GenerateResult {
  return {
    text,
    usage: {
      requests: 1,
      unreportedRequests: 0,
      inputTokens: 100,
      outputTokens: 10,
      reasoningTokens: 0,
      cachedInputTokens: 0,
    },
  }
}

function fakeJudge(
  alias: string,
  respond: (prompt: string, system?: string) => string
): Judge & {
  prompts: string[]
} {
  const prompts: string[] = []
  return {
    name: alias,
    modelAlias: alias,
    modelConfig: getModelConfig(alias),
    prompts,
    evaluate: () => Promise.reject(new Error("legacy judging is not used by BEAM")),
    generate: async (prompt, options) => {
      prompts.push(prompt)
      return reply(respond(prompt, options?.system))
    },
    getModel: () => {
      throw new Error("not used")
    },
  }
}

const exactEvents = fakeJudge("glm-5.3-flash", (prompt) => {
  const match = prompt.match(/^First snippet: ([\s\S]*) \n Second snippet: ([\s\S]*)$/)
  if (!match) throw new Error(`unexpected prompt ${prompt}`)
  return match[1] === match[2] ? "YES" : "NO"
})

function question(
  overrides: Partial<UnifiedQuestion> & { rubric?: string[] } = {}
): UnifiedQuestion {
  const { rubric, ...rest } = overrides
  return {
    questionId: "q",
    question: "What happened?",
    questionType: "information_extraction",
    groundTruth: "",
    haystackSessionIds: [],
    metadata: { scale: "1M", chatId: "1", rubric: rubric ?? ["A", "B"] },
    ...rest,
  }
}

const customJudge = new BeamProtocol({ profile: "custom-judge" })

describe("BEAM event ordering", () => {
  it("scores perfect and reversed sequences as 1 and 0", async () => {
    const event = question({ questionType: "event_ordering", rubric: ["A", "B", "C"] })
    const perfect = await customJudge.evaluateQuestion({
      question: event,
      hypothesis: "A\nB\nC",
      judge: exactEvents,
    })
    const reversed = await customJudge.evaluateQuestion({
      question: event,
      hypothesis: "C\nB\nA",
      judge: exactEvents,
    })
    expect(perfect.score).toBe(1)
    expect(perfect.passed).toBe(true)
    expect(reversed.score).toBe(0)
    expect(reversed.passed).toBe(false)
  })

  it("matches the authors' union-rank semantics for a missing event", async () => {
    const result = await customJudge.evaluateQuestion({
      question: question({ questionType: "event_ordering", rubric: ["A", "B", "C"] }),
      hypothesis: "A\nC",
      judge: exactEvents,
    })
    expect(result.score).toBeCloseTo(2 / 3, 12)
    expect(result.metrics?.eventF1).toBeCloseTo(0.8, 12)
    expect(result.usage.requests).toBeGreaterThan(0)
  })
})

describe("BEAM nugget scoring", () => {
  it("averages 0, 0.5, and 1 without rounding and accumulates judge usage", async () => {
    const scores = ["1.0", "0.5", "0.0"]
    const judge = fakeJudge(
      "glm-5.3-flash",
      () => `{"score": ${scores.shift()}, "reason": "checked"}`
    )
    const result = await customJudge.evaluateQuestion({
      question: question({ rubric: ["A", "B", "C"] }),
      hypothesis: "answer",
      judge,
    })
    expect(result.score).toBe(0.5)
    expect(result.passed).toBe(true)
    expect(result.usage).toMatchObject({ requests: 3, inputTokens: 300, outputTokens: 30 })
    expect(judge.prompts[0]).toContain("RUBRIC CRITERION (what to check): A")
  })

  it("retries malformed judge output and counts every paid attempt", async () => {
    const outputs = ["not json", '{"score": 1, "reason": "ok"}']
    const judge = fakeJudge("glm-5.3-flash", () => outputs.shift()!)
    const result = await customJudge.evaluateQuestion({
      question: question({ rubric: ["A"] }),
      hypothesis: "answer",
      judge,
    })
    expect(result.score).toBe(1)
    expect(result.usage.requests).toBe(2)
  })

  it("fails closed after three invalid judge outputs", async () => {
    const judge = fakeJudge("glm-5.3-flash", () => '{"score": 0.7, "reason": "between"}')
    await expect(
      customJudge.evaluateQuestion({
        question: question({ rubric: ["A"] }),
        hypothesis: "x",
        judge,
      })
    ).rejects.toThrow("BEAM judge failed after 3 attempts")
  })
})

describe("BEAM judge output parsing", () => {
  it("accepts only the paper's three nugget scores and no extra fields", () => {
    expect(parseNuggetJudgment('```json\n{"score": 0.5, "reason": "partial"}\n```')).toEqual({
      score: 0.5,
      reason: "partial",
    })
    expect(() => parseNuggetJudgment('{"score": 0.7, "reason": "x"}')).toThrow()
    expect(() => parseNuggetJudgment('{"score": 1, "reason": "x", "extra": 1}')).toThrow()
    expect(() => parseNuggetJudgment('{"score": 1, "reason": ""}')).toThrow()
  })

  it("reads plain and JSON YES/NO answers and rejects anything else", () => {
    expect(parseEventEquivalence("**YES**")).toBe(true)
    expect(parseEventEquivalence("no.")).toBe(false)
    expect(parseEventEquivalence('{"answer":"YES"}')).toBe(true)
    expect(() => parseEventEquivalence("probably")).toThrow()
  })
})

describe("BEAM profiles", () => {
  it("requires gpt-4.1-mini for the paper profile and accepts any judge otherwise", () => {
    const paper = new BeamProtocol()
    expect(() => paper.assertJudge(fakeJudge("glm-5.3-flash", () => ""))).toThrow(
      "requires judge gpt-4.1-mini"
    )
    expect(() => paper.assertJudge(fakeJudge("gpt-4.1-mini", () => ""))).not.toThrow()
    expect(() => customJudge.assertJudge(fakeJudge("glm-5.3-flash", () => ""))).not.toThrow()
  })

  it("limits the paper profile to the published Top-K values", () => {
    expect(new BeamProtocol().retrievalTopK).toBe(5)
    expect(() => new BeamProtocol({ retrievalTopK: 7 })).toThrow("allows Top-K 5, 10, 15, 20")
    expect(new BeamProtocol({ profile: "custom-judge", retrievalTopK: 7 }).retrievalTopK).toBe(7)
    expect(() => new BeamProtocol({ profile: "custom-judge", retrievalTopK: 0 })).toThrow()
    expect(() => new BeamProtocol({ profile: "custom-judge", retrievalTopK: 101 })).toThrow()
    expect(() => new BeamProtocol({ profile: "mem0-nugget" })).toThrow("Unsupported BEAM")
  })

  it("records profile and judge requirement in the protocol identity", () => {
    expect(new BeamProtocol().identity).toMatchObject({
      profile: "paper",
      judgeRequirement: "gpt-4.1-mini",
      retrievalTopK: 5,
    })
    expect(customJudge.identity).toMatchObject({ profile: "custom-judge", judgeRequirement: "any" })
  })
})

describe("BEAM answer plan", () => {
  const sessions: UnifiedSession[] = [
    {
      sessionId: "beam-1M-1-batch-1-turn-1",
      messages: [],
      metadata: { documentDate: "2024-03-01" },
    },
    {
      sessionId: "beam-1M-1-batch-2-turn-12",
      messages: [],
      metadata: { documentDate: "2024-04-02" },
    },
  ]

  it("cuts evidence to Top-K and dates it only from exact session matches", () => {
    const plan = new BeamProtocol({ retrievalTopK: 5 }).createAnswerPlan({
      question: question(),
      sessions,
      results: [
        { content: "later fact", tags: "memorybench,beam-1M-1-run,beam-1M-1-batch-2-turn-12" },
        { content: "earlier fact", source: "memorybench:beam-1M-1-run:beam-1M-1-batch-1-turn-1" },
        { content: "prefix only", tags: "beam-1M-1-batch-2-turn-1" },
        "plain string evidence",
        { memory: "fifth" },
        { content: "sixth is cut" },
      ],
    })
    expect(plan.evidenceCount).toBe(5)
    expect(plan.prompt).toContain("[2024-03-01] earlier fact")
    expect(plan.prompt).toContain("[2024-04-02] later fact")
    expect(plan.prompt).toContain("prefix only")
    expect(plan.prompt).not.toContain("] prefix only")
    expect(plan.prompt).not.toContain("sixth is cut")
    expect(plan.basePrompt).toContain("(No memories available)")
  })

  it("asks for one event per line only on event-ordering questions", () => {
    const protocol = new BeamProtocol()
    const event = protocol.createAnswerPlan({
      question: question({ questionType: "event_ordering" }),
      sessions,
      results: [],
    })
    const other = protocol.createAnswerPlan({ question: question(), sessions, results: [] })
    expect(event.prompt).toContain("exactly one event per line")
    expect(other.prompt).not.toContain("exactly one event per line")
  })

  it("matches session ids as whole tokens", () => {
    const ids = new Set(["beam-1M-1-batch-2-turn-1"])
    expect(matchEvidenceSession({ tags: "x,beam-1M-1-batch-2-turn-12" }, ids)).toBeUndefined()
    expect(matchEvidenceSession({ metadata: { sessionId: "beam-1M-1-batch-2-turn-1" } }, ids)).toBe(
      "beam-1M-1-batch-2-turn-1"
    )
  })
})

describe("BEAM aggregation", () => {
  function tier(perAbility: number, scoreFor: (ability: string, index: number) => number) {
    const questions: UnifiedQuestion[] = []
    const scores = new Map<string, number>()
    for (const ability of BEAM_QUESTION_TYPE_IDS) {
      for (let index = 0; index < perAbility; index++) {
        const id = `${ability}-${index}`
        questions.push(question({ questionId: id, questionType: ability }))
        scores.set(id, scoreFor(ability, index))
      }
    }
    return { questions, scores }
  }

  it("macro-averages abilities instead of weighting by question count", () => {
    const { questions, scores } = tier(2, (ability) => (ability === "abstention" ? 1 : 0))
    questions.push(question({ questionId: "extra", questionType: "summarization" }))
    scores.set("extra", 0)
    const report = customJudge.aggregate({ questions, scores })
    expect(report.primaryMetric).toEqual({ key: "beamRubricScorePartial", value: 0.1 })
    expect(report.metrics.passAccuracy).toBeCloseTo(2 / 21, 12)
    expect(report.bySlice.abstention).toMatchObject({ averageScore: 1, questionCount: 2 })
  })

  it("reserves beamScore for a complete 700-question paper-judged tier", () => {
    const full = tier(70, (_ability, index) => (index % 2 === 0 ? 1 : 0.5))
    expect(new BeamProtocol().aggregate(full).primaryMetric).toEqual({
      key: "beamScore",
      value: 0.75,
    })
    expect(customJudge.aggregate(full).primaryMetric.key).toBe("beamRubricScore")

    const sampled = tier(1, () => 1)
    expect(new BeamProtocol().aggregate(sampled).primaryMetric.key).toBe("beamScorePartial")
  })
})

import { describe, expect, it } from "bun:test"
import type { QuestionCheckpoint, RunCheckpoint } from "../types/checkpoint"
import type { Provider } from "../types/provider"
import { classifySignetRecallResult } from "../providers/signet"
import { splitDerivedEvidence } from "./phases/answer"
import { summarizeTranscriptReliance } from "./phases/report"
import { emptyUsage } from "../utils/llm"

describe("Signet recall evidence classification", () => {
  it("marks transcript fallbacks as raw evidence and everything else as derived", () => {
    expect(classifySignetRecallResult({ id: "source-chunk:abc" })).toBe("raw-evidence")
    expect(classifySignetRecallResult({ id: "native-artifact:42" })).toBe("raw-evidence")
    expect(classifySignetRecallResult({ id: "transcript:session-1" })).toBe("raw-evidence")
    expect(classifySignetRecallResult({ id: "mem_123", source: "sec" })).toBe("derived")
    expect(classifySignetRecallResult({ id: "entity:atlas", source: "constructed" })).toBe(
      "derived"
    )
    expect(classifySignetRecallResult("plain string")).toBe("derived")
  })

  it("splits only for providers that can classify their results", () => {
    const context = [{ id: "mem_1" }, { id: "native-artifact:1" }, { id: "source-chunk:2" }]
    expect(splitDerivedEvidence(context, undefined)).toBeUndefined()
    const provider = { classifyResult: classifySignetRecallResult } as unknown as Provider
    expect(splitDerivedEvidence(context, provider)).toEqual({
      derived: [{ id: "mem_1" }],
      rawEvidenceCount: 2,
    })
  })
})

function usage(inputTokens: number) {
  return { ...emptyUsage(), requests: 1, inputTokens }
}

function question(
  id: string,
  product: boolean,
  derived: boolean,
  raw: number,
  tokens: { product: number; derived: number }
): QuestionCheckpoint {
  const reused = raw === 0
  return {
    questionId: id,
    containerTag: id,
    question: id,
    groundTruth: "",
    questionType: "t",
    phases: {
      ingest: { status: "completed", completedSessions: [] },
      indexing: { status: "completed" },
      search: { status: "completed" },
      answer: {
        status: "completed",
        hypothesis: "a",
        contextTokens: tokens.product,
        rawEvidenceCount: raw,
        usage: usage(tokens.product + 100),
        derivedOnly: {
          reusedProductAnswer: reused,
          hypothesis: "b",
          promptTokens: tokens.derived + 100,
          contextTokens: tokens.derived,
          evidenceCount: 1,
          ...(reused ? {} : { usage: usage(tokens.derived + 100) }),
        },
      },
      evaluate: {
        status: "completed",
        score: product ? 1 : 0,
        passed: product,
        derivedOnly: { score: derived ? 1 : 0, passed: derived },
      },
    },
  }
}

describe("transcript reliance report", () => {
  it("buckets outcomes and measures the token cost transcripts add", () => {
    const questions = [
      question("both", true, true, 0, { product: 200, derived: 200 }),
      question("rescued", true, false, 3, { product: 2900, derived: 200 }),
      question("hurt", false, true, 2, { product: 1500, derived: 300 }),
      question("neither", false, false, 1, { product: 1000, derived: 100 }),
    ]
    const checkpoint = {
      questions: Object.fromEntries(questions.map((q) => [q.questionId, q])),
    } as unknown as RunCheckpoint

    const reliance = summarizeTranscriptReliance(checkpoint, Object.keys(checkpoint.questions))

    expect(reliance).toEqual({
      questions: 4,
      questionsWithRawEvidence: 3,
      rawEvidenceItems: 6,
      productScore: 0.5,
      derivedOnlyScore: 0.5,
      bothCorrect: 1,
      onlyWithTranscripts: 1,
      onlyWithoutTranscripts: 1,
      bothWrong: 1,
      avgContextTokensProduct: 1400,
      avgContextTokensDerivedOnly: 200,
      answerInputTokensProduct: 6000,
      answerInputTokensDerivedOnly: 1200,
      extraInputTokensPerRescuedAnswer: 4800,
    })
  })

  it("is absent when no question carries a derived-only result", () => {
    const checkpoint = { questions: {} } as unknown as RunCheckpoint
    expect(summarizeTranscriptReliance(checkpoint, [])).toBeUndefined()
  })
})

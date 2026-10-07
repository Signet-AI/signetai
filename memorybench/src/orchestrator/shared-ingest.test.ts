import { afterEach, describe, expect, it } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Benchmark } from "../types/benchmark"
import type { IngestResult, Provider } from "../types/provider"
import type { UnifiedQuestion, UnifiedSession } from "../types/unified"
import { CheckpointManager } from "./checkpoint"
import {
  assertSameIdentity,
  containerTagFor,
  mergeIngestUsage,
  resolveResumeBenchmarkConfig,
} from "./index"
import { runIngestPhase } from "./phases/ingest"
import { runIndexingPhase } from "./phases/indexing"
import { emptyUsage } from "../utils/llm"

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function session(id: string): UnifiedSession {
  return { sessionId: id, messages: [{ role: "user", content: id }] }
}

function benchmark(): Benchmark {
  const groups: Record<string, string> = { q1: "chat-a", q2: "chat-a", q3: "chat-b" }
  const haystacks: Record<string, UnifiedSession[]> = {
    "chat-a": [session("a1"), session("a2"), session("a3")],
    "chat-b": [session("b1")],
  }
  const questions: UnifiedQuestion[] = Object.keys(groups).map((questionId) => ({
    questionId,
    question: questionId,
    questionType: "t",
    groundTruth: "",
    haystackSessionIds: [],
  }))
  return {
    name: "fixture",
    load: async () => {},
    getQuestions: () => questions,
    getHaystackSessions: (questionId) => haystacks[groups[questionId]!]!,
    getGroundTruth: () => "",
    getQuestionTypes: () => ({}),
    getIngestionGroupId: (questionId) => groups[questionId]!,
  }
}

function recordingProvider() {
  const ingested: Array<{ sessionId: string; containerTag: string }> = []
  const awaited: string[] = []
  const provider: Provider = {
    name: "recording",
    initialize: async () => {},
    ingest: async (sessions, options): Promise<IngestResult> => {
      for (const item of sessions) {
        ingested.push({ sessionId: item.sessionId, containerTag: options.containerTag })
      }
      return { documentIds: sessions.map((item) => `${options.containerTag}:${item.sessionId}`) }
    },
    awaitIndexing: async (result, containerTag, onProgress) => {
      awaited.push(containerTag)
      onProgress?.({
        completedIds: result.documentIds,
        failedIds: [],
        total: result.documentIds.length,
      })
    },
    search: async () => [],
    clear: async () => {},
  }
  return { provider, ingested, awaited }
}

describe("shared haystack ingestion", () => {
  it("ingests each shared haystack once and completes every member question", async () => {
    const root = mkdtempSync(join(tmpdir(), "memorybench-shared-ingest-"))
    roots.push(root)
    const manager = new CheckpointManager(root)
    const fixture = benchmark()
    const checkpoint = manager.create("shared", "recording", "fixture", "gpt-4o", "gpt-4o")
    for (const question of fixture.getQuestions()) {
      manager.initQuestion(
        checkpoint,
        question.questionId,
        containerTagFor(fixture, question.questionId, checkpoint.dataSourceRunId),
        { question: question.question, groundTruth: "", questionType: "t" }
      )
    }
    const { provider, ingested, awaited } = recordingProvider()

    await runIngestPhase(provider, fixture, checkpoint, manager)
    await runIndexingPhase(provider, checkpoint, manager)
    await manager.flush("shared")

    expect(ingested).toEqual([
      { sessionId: "a1", containerTag: "chat-a-shared" },
      { sessionId: "a2", containerTag: "chat-a-shared" },
      { sessionId: "a3", containerTag: "chat-a-shared" },
      { sessionId: "b1", containerTag: "chat-b-shared" },
    ])
    expect(awaited.sort()).toEqual(["chat-a-shared", "chat-b-shared"])
    for (const questionId of ["q1", "q2", "q3"]) {
      expect(checkpoint.questions[questionId]!.phases.ingest.status).toBe("completed")
      expect(checkpoint.questions[questionId]!.phases.indexing.status).toBe("completed")
    }
    expect(checkpoint.questions.q1!.phases.ingest.ingestResult?.documentIds).toHaveLength(3)
    expect(checkpoint.questions.q2!.phases.ingest.ingestResult).toBeUndefined()
    expect(checkpoint.questions.q2!.phases.ingest.completedSessions).toEqual([])
  })

  it("keeps per-question containers for benchmarks without ingestion groups", () => {
    expect(containerTagFor({}, "q1", "run")).toBe("q1-run")
    expect(containerTagFor({ getIngestionGroupId: () => "chat" }, "q1", "run")).toBe("chat-run")
  })
})

describe("resume guards", () => {
  it("keeps the stored benchmark config and rejects a conflicting one", () => {
    const stored = { dataPath: "./d", retrievalTopK: 5, evaluationProfile: "custom-judge" }
    expect(resolveResumeBenchmarkConfig(stored, undefined)).toBe(stored)
    expect(resolveResumeBenchmarkConfig(stored, { ...stored })).toBe(stored)
    expect(resolveResumeBenchmarkConfig(stored, { retrievalTopK: 5 })).toBe(stored)
    expect(() => resolveResumeBenchmarkConfig(undefined, { retrievalTopK: 5 })).toThrow()
    expect(() => resolveResumeBenchmarkConfig(stored, { ...stored, retrievalTopK: 10 })).toThrow(
      "cannot change on resume"
    )
  })

  it("rejects a protocol or dataset identity that changed mid-run", () => {
    expect(() => assertSameIdentity("Protocol", { a: 1, b: 2 }, { b: 2, a: 1 })).not.toThrow()
    expect(() => assertSameIdentity("Protocol", { a: 1 }, { a: 2 })).toThrow("Protocol changed")
    expect(() => assertSameIdentity("Protocol", undefined, { a: 2 })).not.toThrow()
  })

  it("adds harness usage and deduplicates dreaming passes across resumed processes", () => {
    const first = {
      harness: { ...emptyUsage(), requests: 2, inputTokens: 10 },
      dreamingPasses: { p1: { inputTokens: 5, outputTokens: 1, cacheReadTokens: 0 } },
    }
    const second = {
      harness: { ...emptyUsage(), requests: 1, inputTokens: 4 },
      dreamingPasses: {
        p1: { inputTokens: 5, outputTokens: 1, cacheReadTokens: 0 },
        p2: { inputTokens: null, outputTokens: null, cacheReadTokens: null },
      },
    }
    const merged = mergeIngestUsage(first, second)
    expect(merged?.harness).toMatchObject({ requests: 3, inputTokens: 14 })
    expect(Object.keys(merged?.dreamingPasses ?? {})).toEqual(["p1", "p2"])
  })
})

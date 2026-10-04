import { describe, expect, it } from "bun:test"
import {
  buildSignetRecallQuery,
  formatSupermemoryParityContent,
  hasUsableMemoryContent,
  resolveSignetSearchLimit,
  SignetDreamingProvider,
  scopeStructuredBenchmarkParticipants,
} from "./index"
import type { UnifiedSession } from "../../types/unified"

describe("Signet benchmark profiles", () => {
  class CapturingDreamingProvider extends SignetDreamingProvider {
    calls: Array<{ path: string; init: RequestInit }> = []
    private statusCalls = 0
    private triggerCalls = 0

    protected override async request<T>(path: string, init: RequestInit): Promise<T> {
      this.calls.push({ path, init })
      if (path.startsWith("/api/agents")) return {} as T
      if (path === "/api/hooks/session-end") return { transcriptCaptureJobId: "capture-1" } as T
      if (path === "/api/hooks/transcript-capture/capture-1?agentId=memorybench-question-1-run") {
        return { status: "completed" } as T
      }
      if (path.replace("&measure=1", "") === "/api/dream/status?agentId=memorybench-question-1-run") {
        return { worker: { running: true }, episodicTokensPending: this.statusCalls >= 3 ? 0 : 1 } as T
      }
      if (path === "/api/dream/trigger") {
        this.triggerCalls += 1
        return { passId: `pass-${this.triggerCalls}` } as T
      }
      if (path.replace("&measure=1", "") === "/api/dream/status?agentId=memorybench") {
        this.statusCalls += 1
        if (this.statusCalls === 1)
          return { worker: { running: true }, episodicTokensPending: 2 } as T
        if (this.statusCalls === 2) {
          return {
            worker: { running: true },
            passes: [
              {
                id: "pass-1",
                status: "completed",
                tokensInput: 1200,
                tokensOutput: 300,
                tokensCacheRead: 50,
              },
              { id: "periodic-pass", status: "running", tokensInput: 999 },
            ],
            episodicTokensPending: 1,
          } as T
        }
        return {
          worker: { running: true },
          passes: [{ id: "pass-2", status: "completed", tokensInput: null }],
          episodicTokensPending: 0,
        } as T
      }
      throw new Error(`Unexpected path ${path}`)
    }
  }

  it("captures benchmark sessions as canonical episodic transcripts and drains Dreaming before retrieval", async () => {
    const provider = new CapturingDreamingProvider()
    const session: UnifiedSession = {
      sessionId: "session-1",
      messages: [{ role: "user", content: "I moved deployment to edge runtime." }],
      metadata: { date: "2023-05-20T10:20:00.000Z" },
    }
    const previousPoll = process.env.SIGNET_BENCH_DREAMING_POLL_SECS
    process.env.SIGNET_BENCH_DREAMING_POLL_SECS = "0"
    try {
      const ingest = await provider.ingest([session], { containerTag: "question-1-run" })
      await provider.awaitIndexing(ingest, "question-1-run")
      await provider.finalizeIngest({ runId: "run", dataSourceRunId: "source" })
    } finally {
      if (previousPoll === undefined) delete process.env.SIGNET_BENCH_DREAMING_POLL_SECS
      else process.env.SIGNET_BENCH_DREAMING_POLL_SECS = previousPoll
    }

    expect(provider.name).toBe("signet-dreaming")
    const isolate = provider.calls.find((call) => call.path.startsWith("/api/agents"))
    expect(isolate?.init.method).toBe("PATCH")
    expect(JSON.parse(String(isolate?.init.body))).toEqual({ read_policy: "isolated" })
    expect(provider.calls.some((call) => call.path === "/api/memory/remember")).toBe(false)
    const capture = provider.calls.find((call) => call.path === "/api/hooks/session-end")
    expect(JSON.parse(String(capture?.init.body))).toMatchObject({
      harness: "memorybench",
      sessionId: "memorybench:question-1-run:session-1",
      sessionKey: "memorybench:question-1-run:session-1",
      agentId: "memorybench-question-1-run",
      reason: "session_shutdown",
      capturedAt: "2023-05-20T10:20:00.000Z",
      transcript: "[2023-05-20T10:20:00.000Z]\nuser: I moved deployment to edge runtime.",
    })
    expect(provider.calls.map((call) => call.path)).toEqual([
      "/api/agents/memorybench-question-1-run",
      "/api/hooks/session-end",
      "/api/hooks/transcript-capture/capture-1?agentId=memorybench-question-1-run",
      "/api/dream/status?agentId=memorybench-question-1-run",
      "/api/dream/status?agentId=memorybench",
      "/api/dream/trigger",
      "/api/dream/status?agentId=memorybench",
      "/api/dream/status?agentId=memorybench-question-1-run&measure=1",
      "/api/dream/trigger",
      "/api/dream/status?agentId=memorybench",
      "/api/dream/status?agentId=memorybench-question-1-run&measure=1",
    ])
    expect(provider.getIngestUsage().dreamingPasses).toEqual({
      "pass-1": { inputTokens: 1200, outputTokens: 300, cacheReadTokens: 50 },
      "pass-2": { inputTokens: null, outputTokens: null, cacheReadTokens: null },
    })
  })

  it("preserves session and recall agent scopes for deterministic Dreaming scenarios", async () => {
    class ScopedDreamingProvider extends SignetDreamingProvider {
      calls: Array<{ path: string; init: RequestInit }> = []

      protected override async request<T>(path: string, init: RequestInit): Promise<T> {
        this.calls.push({ path, init })
        if (path.startsWith("/api/agents")) return {} as T
      if (path === "/api/hooks/session-end") {
          const body = JSON.parse(String(init.body)) as { agentId: string }
          return { transcriptCaptureJobId: `capture-${body.agentId}` } as T
        }
        if (path.startsWith("/api/hooks/transcript-capture/capture-")) {
          return { status: "completed" } as T
        }
        if (path === "/api/memory/recall") return { results: [] } as T
        throw new Error(`Unexpected path ${path}`)
      }
    }

    const provider = new ScopedDreamingProvider()
    const result = await provider.ingest(
      [
        {
          sessionId: "alpha-session",
          messages: [{ role: "user", content: "Alpha owns the blue Harbor release." }],
          metadata: { agentId: "dreaming-gate-alpha" },
        },
        {
          sessionId: "beta-session",
          messages: [{ role: "user", content: "Beta owns the green Harbor release." }],
          metadata: { agentId: "dreaming-gate-beta" },
        },
      ],
      { containerTag: "scope-contract" }
    )
    await provider.awaitIndexing(result, "scope-contract")
    await provider.search("What color is Harbor?", { containerTag: "scope-contract", agentId: "dreaming-gate-alpha" })

    expect(result.taskAgentIds).toEqual({
      "capture-dreaming-gate-alpha": "dreaming-gate-alpha",
      "capture-dreaming-gate-beta": "dreaming-gate-beta",
    })
    const captures = provider.calls.filter((call) => call.path === "/api/hooks/session-end")
    expect(captures.map((call) => JSON.parse(String(call.init.body)).agentId)).toEqual([
      "dreaming-gate-alpha",
      "dreaming-gate-beta",
    ])
    expect(provider.calls.map((call) => call.path)).toContain(
      "/api/hooks/transcript-capture/capture-dreaming-gate-alpha?agentId=dreaming-gate-alpha"
    )
    expect(provider.calls.map((call) => call.path)).toContain(
      "/api/hooks/transcript-capture/capture-dreaming-gate-beta?agentId=dreaming-gate-beta"
    )
    const recall = provider.calls.find((call) => call.path === "/api/memory/recall")
    const recallBody = JSON.parse(String(recall?.init.body))
    expect(recallBody).toMatchObject({ agentId: "dreaming-gate-alpha" })
    expect(recallBody).not.toHaveProperty("project")
    expect(recallBody).not.toHaveProperty("scope")
  })

  it("rejects resumed Dreaming captures whose fixture scopes were not checkpointed", async () => {
    class MissingScopeDreamingProvider extends SignetDreamingProvider {
      calls: string[] = []

      protected override async request<T>(path: string): Promise<T> {
        this.calls.push(path)
        throw new Error(`Unexpected request ${path}`)
      }
    }

    const provider = new MissingScopeDreamingProvider()
    await expect(
      provider.awaitIndexing(
        {
          documentIds: ["memorybench:scope-contract:alpha"],
          taskIds: ["capture-alpha"],
        },
        "scope-contract"
      )
    ).rejects.toThrow("missing its fixture agent scope")
    expect(provider.calls).toEqual([])
  })

  it("drains every ingested fixture scope through one canonical Dreaming pass", async () => {
    class MultiScopeDreamingProvider extends SignetDreamingProvider {
      calls: Array<{ path: string; init: RequestInit }> = []
      private triggered = false

      protected override async request<T>(path: string, init: RequestInit): Promise<T> {
        this.calls.push({ path, init })
        if (path.startsWith("/api/agents")) return {} as T
      if (path === "/api/hooks/session-end") {
          const body = JSON.parse(String(init.body)) as { agentId: string }
          return { transcriptCaptureJobId: `capture-${body.agentId}` } as T
        }
        if (path.startsWith("/api/dream/status?agentId=dreaming-gate-")) {
          return { worker: { running: true }, episodicTokensPending: 0 } as T
        }
        if (path === "/api/dream/trigger") {
          this.triggered = true
          return { passId: "universe-pass" } as T
        }
        if (path.replace("&measure=1", "") === "/api/dream/status?agentId=memorybench") {
          return {
            worker: { running: true },
            passes: this.triggered ? [{ id: "universe-pass", status: "completed" }] : [],
            episodicTokensPending: 0,
          } as T
        }
        throw new Error(`Unexpected path ${path}`)
      }
    }

    const provider = new MultiScopeDreamingProvider()
    const previousPoll = process.env.SIGNET_BENCH_DREAMING_POLL_SECS
    process.env.SIGNET_BENCH_DREAMING_POLL_SECS = "0"
    try {
      await provider.ingest(
        [
          {
            sessionId: "alpha",
            messages: [{ role: "user", content: "Alpha evidence." }],
            metadata: { agentId: "dreaming-gate-alpha" },
          },
          {
            sessionId: "beta",
            messages: [{ role: "user", content: "Beta evidence." }],
            metadata: { agentId: "dreaming-gate-beta" },
          },
        ],
        { containerTag: "multi-scope" }
      )
      await provider.finalizeIngest({ runId: "run", dataSourceRunId: "source" })
    } finally {
      if (previousPoll === undefined) delete process.env.SIGNET_BENCH_DREAMING_POLL_SECS
      else process.env.SIGNET_BENCH_DREAMING_POLL_SECS = previousPoll
    }

    const triggers = provider.calls.filter((call) => call.path === "/api/dream/trigger")
    expect(triggers).toHaveLength(1)
    expect(JSON.parse(String(triggers[0]?.init.body))).toMatchObject({ mode: "incremental", agentId: "memorybench" })
    expect(provider.calls.map((call) => call.path)).toContain("/api/dream/status?agentId=dreaming-gate-alpha")
    expect(provider.calls.map((call) => call.path)).toContain("/api/dream/status?agentId=dreaming-gate-beta")
  })

  it("joins a concurrent periodic Dreaming pass while draining the benchmark cursor", async () => {
    class ConcurrentDreamingProvider extends SignetDreamingProvider {
      private statusCalls = 0

      protected override async request<T>(path: string): Promise<T> {
        if (path === "/api/dream/trigger") {
          throw new Error("/api/dream/trigger failed (409): A dreaming pass is already running")
        }
        if (path.replace("&measure=1", "") === "/api/dream/status?agentId=memorybench") {
          this.statusCalls += 1
          if (this.statusCalls === 1) return { worker: { running: true }, episodicTokensPending: 2 } as T
          if (this.statusCalls === 2) {
            return {
              worker: { running: true },
              passes: [{ id: "periodic-pass", status: "running" }],
              episodicTokensPending: 2,
            } as T
          }
          return {
            worker: { running: true },
            passes: [{ id: "periodic-pass", status: "completed" }],
            episodicTokensPending: 0,
          } as T
        }
        throw new Error(`Unexpected path ${path}`)
      }
    }

    const provider = new ConcurrentDreamingProvider()
    const previousPoll = process.env.SIGNET_BENCH_DREAMING_POLL_SECS
    process.env.SIGNET_BENCH_DREAMING_POLL_SECS = "0"
    try {
      await provider.finalizeIngest({ runId: "run", dataSourceRunId: "source" })
    } finally {
      if (previousPoll === undefined) delete process.env.SIGNET_BENCH_DREAMING_POLL_SECS
      else process.env.SIGNET_BENCH_DREAMING_POLL_SECS = previousPoll
    }
  })

  class DrainingProvider extends SignetDreamingProvider {
    calls: string[] = []
    private triggers = 0

    constructor(
      private readonly drainedAfterPass: number,
      private readonly mutationsPerPass: number,
      private readonly failedPasses: ReadonlySet<number> = new Set()
    ) {
      super()
    }

    protected override async request<T>(path: string, _init: RequestInit): Promise<T> {
      this.calls.push(path)
      if (path === "/api/dream/trigger") {
        this.triggers += 1
        return { passId: `pass-${this.triggers}` } as T
      }
      if (path.startsWith("/api/dream/status")) {
        return {
          worker: { running: true },
          passes: [
            this.failedPasses.has(this.triggers)
              ? { id: `pass-${this.triggers}`, status: "failed", error: "Pi agent length" }
              : { id: `pass-${this.triggers}`, status: "completed", mutationsApplied: this.mutationsPerPass },
          ],
          episodicTokensPending: this.triggers >= this.drainedAfterPass ? 0 : null,
        } as T
      }
      throw new Error(`Unexpected path ${path}`)
    }
  }

  async function finalizeWith(provider: SignetDreamingProvider): Promise<void> {
    const previous = process.env.SIGNET_BENCH_DREAMING_POLL_SECS
    process.env.SIGNET_BENCH_DREAMING_POLL_SECS = "1"
    try {
      await provider.finalizeIngest({ runId: "run", dataSourceRunId: "source" })
    } finally {
      if (previous === undefined) delete process.env.SIGNET_BENCH_DREAMING_POLL_SECS
      else process.env.SIGNET_BENCH_DREAMING_POLL_SECS = previous
    }
  }

  it("keeps triggering passes while the backlog is unmeasured until it measures zero", async () => {
    const provider = new DrainingProvider(3, 5)
    await finalizeWith(provider)
    expect(provider.calls.filter((path) => path === "/api/dream/trigger")).toHaveLength(3)
  })

  it("waits for every concurrent pass in a round before judging it", async () => {
    class ConcurrentRoundProvider extends SignetDreamingProvider {
      calls: string[] = []
      private polls = 0
      private triggered = false

      protected override async request<T>(path: string, _init: RequestInit): Promise<T> {
        this.calls.push(path)
        if (path === "/api/dream/trigger") {
          this.triggered = true
          return { passId: "group-1" } as T
        }
        if (path.startsWith("/api/dream/status")) {
          if (!this.triggered) return { worker: { running: true, activePasses: [] }, passes: [] } as T
          this.polls += 1
          const settled = this.polls > 2
          return {
            worker: { running: true, activePasses: settled ? [] : [{ passId: "group-2" }] },
            passes: [
              { id: "group-1", status: "completed", mutationsApplied: 2 },
              { id: "group-2", status: settled ? "completed" : "running", mutationsApplied: 3 },
            ],
            episodicTokensPending: settled ? 0 : 1,
          } as T
        }
        throw new Error(`Unexpected path ${path}`)
      }
    }
    const provider = new ConcurrentRoundProvider()
    await finalizeWith(provider)
    expect(provider.calls.filter((path) => path === "/api/dream/trigger")).toHaveLength(1)
    expect(Object.keys(provider.getIngestUsage().dreamingPasses ?? {}).sort()).toEqual(["group-1", "group-2"])
  })

  it("drains the checkpointed haystack agents when a resumed run skipped ingest", async () => {
    class ResumedProvider extends SignetDreamingProvider {
      calls: string[] = []
      private triggers = 0

      protected override async request<T>(path: string, _init: RequestInit): Promise<T> {
        this.calls.push(path)
        if (path === "/api/dream/trigger") {
          this.triggers += 1
          return { passId: `pass-${this.triggers}` } as T
        }
        if (path.replace("&measure=1", "") === "/api/dream/status?agentId=memorybench") {
          return {
            worker: { running: true, activePasses: [] },
            passes: Array.from({ length: this.triggers }, (_, index) => ({
              id: `pass-${index + 1}`,
              status: "completed",
              mutationsApplied: 3,
            })),
            episodicTokensPending: 0,
          } as T
        }
        if (path.replace("&measure=1", "") === "/api/dream/status?agentId=memorybench-haystack") {
          return {
            worker: { running: true, activePasses: [] },
            episodicTokensPending: this.triggers >= 2 ? 0 : 500,
          } as T
        }
        throw new Error(`Unexpected path ${path}`)
      }
    }
    const provider = new ResumedProvider()
    const previous = process.env.SIGNET_BENCH_DREAMING_POLL_SECS
    process.env.SIGNET_BENCH_DREAMING_POLL_SECS = "1"
    try {
      await provider.finalizeIngest({
        runId: "run",
        dataSourceRunId: "source",
        agentIds: ["memorybench-haystack"],
      })
    } finally {
      if (previous === undefined) delete process.env.SIGNET_BENCH_DREAMING_POLL_SECS
      else process.env.SIGNET_BENCH_DREAMING_POLL_SECS = previous
    }
    expect(provider.calls.filter((path) => path === "/api/dream/trigger")).toHaveLength(2)
    expect(provider.calls).toContain("/api/dream/status?agentId=memorybench-haystack")
  })

  it("retries a failed pass and keeps draining", async () => {
    const provider = new DrainingProvider(3, 5, new Set([1, 2]))
    await finalizeWith(provider)
    expect(provider.calls.filter((path) => path === "/api/dream/trigger")).toHaveLength(3)
  })

  it("fails after three consecutive failed passes", async () => {
    const provider = new DrainingProvider(Number.POSITIVE_INFINITY, 5, new Set([1, 2, 3]))
    await expect(finalizeWith(provider)).rejects.toThrow("Pi agent length (3 consecutive rounds with failed passes)")
    expect(provider.calls.filter((path) => path === "/api/dream/trigger")).toHaveLength(3)
  })

  it("fails instead of looping when passes stop applying mutations", async () => {
    const provider = new DrainingProvider(Number.POSITIVE_INFINITY, 0)
    await expect(finalizeWith(provider)).rejects.toThrow("applied no mutations in 3 consecutive rounds")
    expect(provider.calls.filter((path) => path === "/api/dream/trigger")).toHaveLength(3)
  })

  it("creates a missing haystack agent as isolated so recall cannot read other haystacks", async () => {
    class NewAgentProvider extends SignetDreamingProvider {
      calls: Array<{ path: string; init: RequestInit }> = []

      protected override async request<T>(path: string, init: RequestInit): Promise<T> {
        this.calls.push({ path, init })
        if (init.method === "PATCH") throw new Error(`${path} failed (404): Agent not found`)
        if (path === "/api/agents") return {} as T
        if (path === "/api/memory/recall") return { results: [] } as T
        throw new Error(`Unexpected path ${path}`)
      }
    }
    const provider = new NewAgentProvider()

    await provider.search("question", { containerTag: "q1-run" })
    await provider.search("question again", { containerTag: "q1-run" })

    const create = provider.calls.find((call) => call.path === "/api/agents")
    expect(JSON.parse(String(create?.init.body))).toEqual({
      name: "memorybench-q1-run",
      read_policy: "isolated",
    })
    expect(provider.calls.filter((call) => call.path.startsWith("/api/agents"))).toHaveLength(2)
  })

  it("formats raw sessions like the Supermemory adapter for parity runs", () => {
    const session: UnifiedSession = {
      sessionId: "session-1",
      messages: [
        { role: "user", content: "I use <Spotify> lately." },
        { role: "assistant", content: "Noted." },
      ],
      metadata: { formattedDate: "10:20 am on 20 May, 2023" },
    }

    const content = formatSupermemoryParityContent(session)

    expect(content).toContain(
      "Here is the date the following session took place: 10:20 am on 20 May, 2023"
    )
    expect(content).toContain("Here is the session as a stringified JSON:")
    expect(content).toContain("&lt;Spotify&gt;")
  })

  it("uses the harness limit for rules runs and Supermemory's hardcoded limit for parity runs", () => {
    expect(resolveSignetSearchLimit("structured", 10)).toBe(10)
    expect(resolveSignetSearchLimit("structured", undefined)).toBe(10)
    expect(resolveSignetSearchLimit("supermemory-parity", 10)).toBe(30)
  })

  it("adds absolute temporal hints for relative LongMemEval search questions", () => {
    const query = buildSignetRecallQuery(
      "I mentioned an investment for a competition four weeks ago? What did I buy?",
      "2023/04/01 (Sat) 08:30"
    )

    expect(query).toContain("Temporal search hints")
    expect(query).toContain("4 March 2023")
    expect(query).toContain("2023-03-04")
  })
})

describe("Signet structured ingestion guards", () => {
  it("rejects empty extracted memory content before calling remember", () => {
    expect(hasUsableMemoryContent("")).toBe(false)
    expect(hasUsableMemoryContent("  \n\t")).toBe(false)
    expect(hasUsableMemoryContent("User likes Paris.")).toBe(true)
  })

  it("scopes benchmark participant entities to the question container", () => {
    const scoped = scopeStructuredBenchmarkParticipants(
      {
        entities: [
          {
            source: "Benchmark User",
            sourceType: "person",
            relationship: "uses",
            target: "Spotify",
            targetType: "service",
            confidence: 0.9,
          },
        ],
        aspects: [
          {
            entityName: "Benchmark User",
            aspect: "music preferences",
            attributes: [{ content: "Benchmark User has been using Spotify lately." }],
          },
        ],
        hints: ["What streaming service has the benchmark user been using?"],
      },
      "question-1-run-1"
    )

    expect(scoped.entities[0]?.source).toBe("MemoryBench User question-1-run-1")
    expect(scoped.entities[0]?.target).toBe("Spotify")
    expect(scoped.aspects[0]?.entityName).toBe("MemoryBench User question-1-run-1")
  })
})

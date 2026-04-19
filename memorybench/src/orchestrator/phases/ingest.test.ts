import { describe, expect, it } from "bun:test"
import { resolveSessionConcurrency } from "./ingest"

describe("resolveSessionConcurrency", () => {
  it("defaults to sequential session ingest", () => {
    expect(resolveSessionConcurrency({} as NodeJS.ProcessEnv)).toBe(1)
  })

  it("uses the generic MemoryBench session concurrency when provided", () => {
    expect(
      resolveSessionConcurrency({ MEMORYBENCH_SESSION_CONCURRENCY: "4" } as NodeJS.ProcessEnv)
    ).toBe(4)
  })

  it("falls back to the Signet wrapper session concurrency", () => {
    expect(
      resolveSessionConcurrency({ SIGNET_BENCH_SESSION_CONCURRENCY: "3" } as NodeJS.ProcessEnv)
    ).toBe(3)
  })

  it("rejects invalid values and clamps very high values", () => {
    expect(
      resolveSessionConcurrency({ MEMORYBENCH_SESSION_CONCURRENCY: "0" } as NodeJS.ProcessEnv)
    ).toBe(1)
    expect(
      resolveSessionConcurrency({ MEMORYBENCH_SESSION_CONCURRENCY: "99" } as NodeJS.ProcessEnv)
    ).toBe(16)
  })
})

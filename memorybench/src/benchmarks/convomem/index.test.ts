import { existsSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, relative } from "node:path"
import { afterEach, describe, expect, test } from "bun:test"
import { ConvoMemBenchmark } from "./index"

const originalFetch = globalThis.fetch
const dirs: string[] = []

afterEach(() => {
  globalThis.fetch = originalFetch
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe("ConvoMem dataset download integrity", () => {
  test("fails instead of persisting a partial dataset when a required slice cannot be fetched", async () => {
    const dir = mkdtempSync(join(tmpdir(), "memorybench-convomem-"))
    dirs.push(dir)
    const dataPath = relative(process.cwd(), dir)

    globalThis.fetch = (async () =>
      new Response("missing", { status: 503 })) as unknown as typeof fetch

    const benchmark = new ConvoMemBenchmark()

    await expect(benchmark.load({ dataPath })).rejects.toThrow(
      "Failed to download required ConvoMem slice"
    )
    expect(existsSync(join(dir, "convomem_data.json"))).toBe(false)
  })
})

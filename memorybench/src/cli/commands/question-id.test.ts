import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, test } from "bun:test"
import { parseIngestArgs } from "./ingest"
import { parseRunArgs } from "./run"

describe("MemoryBench question id CLI filters", () => {
  test("run accepts repeated and comma-separated question ids", () => {
    const parsed = parseRunArgs([
      "-p",
      "signet",
      "-b",
      "longmemeval",
      "-q",
      "32260d93,54026fce",
      "--question-id",
      "gpt4_e072b769",
    ])

    expect(parsed?.questionIds).toEqual(["32260d93", "54026fce", "gpt4_e072b769"])
  })

  test("ingest accepts a question id file with comments", () => {
    const dir = mkdtempSync(join(tmpdir(), "memorybench-qids-"))
    const file = join(dir, "ids.txt")
    writeFileSync(file, "# canary\n32260d93\n\n54026fce # stable\n")

    const parsed = parseIngestArgs([
      "-p",
      "signet",
      "-b",
      "longmemeval",
      "--question-ids-file",
      file,
    ])

    expect(parsed?.questionIds).toEqual(["32260d93", "54026fce"])
  })
})

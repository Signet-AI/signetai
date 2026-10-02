import { afterEach, describe, expect, it } from "bun:test"
import { rmSync } from "fs"
import { join } from "path"
import { CheckpointManager } from "../orchestrator/checkpoint"
import { batchManager, type CompareManifest } from "../orchestrator/batch"
import { handleCompareRoutes } from "./routes/compare"
import { handleRunsRoutes } from "./routes/runs"
import { endRun, requestStop, startRun } from "./runState"
import type { RunCheckpoint } from "../types/checkpoint"

type StatusRow = { runId: string; status: string }

function isStatusRow(value: unknown): value is StatusRow {
  return (
    typeof value === "object" &&
    value !== null &&
    "runId" in value &&
    typeof value.runId === "string" &&
    "status" in value &&
    typeof value.status === "string"
  )
}

function readStatusRows(value: unknown): StatusRow[] {
  if (!Array.isArray(value) || !value.every(isStatusRow)) {
    throw new Error("Route returned an invalid run status collection")
  }
  return value
}

function readComparisonRuns(value: unknown): StatusRow[] {
  if (typeof value !== "object" || value === null || !("runs" in value)) {
    throw new Error("Compare route returned no run collection")
  }
  return readStatusRows(value.runs)
}

describe("run status API projections", () => {
  const checkpointManager = new CheckpointManager()
  const runIds: string[] = []
  let compareId = ""

  afterEach(() => {
    for (const runId of runIds.splice(0)) {
      endRun(runId)
      checkpointManager.delete(runId)
    }
    if (compareId) {
      rmSync(join("./data/compare", compareId), { recursive: true, force: true })
      compareId = ""
    }
  })

  it("keeps durable, phase-derived, and live statuses consistent across run and compare routes", async () => {
    const newRun = (label: string, status: "initializing" | "running" | "completed" | "failed") => {
      const runId = `status-${crypto.randomUUID().replaceAll("-", "")}-${label}`
      runIds.push(runId)
      return checkpointManager.create(runId, "filesystem", "convomem", "gpt-4o", "gpt-4o", {
        status,
      })
    }
    const addQuestion = (checkpoint: RunCheckpoint) => {
      checkpointManager.initQuestion(checkpoint, "question", "container", {
        question: "question",
        groundTruth: "answer",
        questionType: "fact",
      })
      return checkpoint
    }
    const expected: Array<[string, string]> = []
    const record = (runId: string, status: string) => expected.push([runId, status])

    const pending = newRun("pending", "initializing")
    record(pending.runId, "pending")

    const partial = addQuestion(newRun("partial", "initializing"))
    checkpointManager.updatePhase(partial, "question", "ingest", { status: "completed" })
    record(partial.runId, "partial")

    const persistedRunning = newRun("persisted-running", "running")
    record(persistedRunning.runId, "partial")

    const phaseFailed = addQuestion(newRun("phase-failed", "running"))
    checkpointManager.updatePhase(phaseFailed, "question", "answer", { status: "failed" })
    record(phaseFailed.runId, "failed")

    const evaluated = addQuestion(newRun("evaluated", "running"))
    checkpointManager.updatePhase(evaluated, "question", "evaluate", { status: "completed" })
    record(evaluated.runId, "completed")

    const completed = newRun("completed", "completed")
    record(completed.runId, "completed")

    const failed = newRun("failed", "failed")
    record(failed.runId, "failed")

    const active = newRun("active", "completed")
    startRun(active.runId)
    record(active.runId, "running")

    const stopping = newRun("stopping", "failed")
    startRun(stopping.runId)
    requestStop(stopping.runId)
    record(stopping.runId, "stopping")

    await Promise.all(runIds.map((runId) => checkpointManager.flush(runId)))

    compareId = `status-${crypto.randomUUID().replaceAll("-", "")}`
    const manifest: CompareManifest = {
      compareId,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      benchmark: "convomem",
      judge: "gpt-4o",
      answeringModel: "gpt-4o",
      targetQuestionIds: [],
      runs: runIds.map((runId) => ({ provider: "filesystem", runId })),
    }
    batchManager.saveManifest(manifest)

    const events = { broadcast: (_message: object) => {} }
    const runResponse = await handleRunsRoutes(
      new Request("http://localhost/api/runs"),
      new URL("http://localhost/api/runs"),
      events
    )
    if (!runResponse) throw new Error("Run route did not handle the request")
    const runRows = readStatusRows(await runResponse.json()).filter((run) =>
      runIds.includes(run.runId)
    )
    expect(runRows).toHaveLength(expected.length)
    expect(runRows.map((run) => [run.runId, run.status])).toEqual(expect.arrayContaining(expected))

    const compareUrl = new URL(`http://localhost/api/compare/${compareId}`)
    const compareResponse = await handleCompareRoutes(new Request(compareUrl), compareUrl, events)
    if (!compareResponse) throw new Error("Compare route did not handle the request")
    const comparisonRuns = readComparisonRuns(await compareResponse.json())
    expect(comparisonRuns).toHaveLength(expected.length)
    expect(comparisonRuns.map((run) => [run.runId, run.status])).toEqual(
      expect.arrayContaining(expected)
    )
  })
})

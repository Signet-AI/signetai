import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { CheckpointManager } from "./checkpoint"

describe("CheckpointManager question metadata", () => {
  let dir = ""

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "memorybench-checkpoint-"))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  test("rejects run IDs that could escape the runs directory", () => {
    const manager = new CheckpointManager(dir)

    expect(() => manager.getRunPath("../../outside")).toThrow("Invalid run ID")
    expect(() => manager.getRunPath("run/child")).toThrow("Invalid run ID")
    expect(manager.getRunPath("valid-run_1")).toBe(join(dir, "valid-run_1"))
  })

  test("stores question dates for temporal answer prompts", () => {
    const manager = new CheckpointManager(dir)
    const checkpoint = manager.create(
      "question-date-run",
      "signet",
      "longmemeval",
      "judge",
      "answerer"
    )

    manager.initQuestion(checkpoint, "q1", "q1-run", {
      question: "How many weeks ago did I start using Ibotta?",
      groundTruth: "3 weeks ago",
      questionType: "temporal-reasoning",
      questionDate: "2023/05/06 (Sat) 09:18",
    })

    expect(checkpoint.questions.q1?.questionDate).toBe("2023/05/06 (Sat) 09:18")
  })

  test("persists fixture capture agent scopes across resume", async () => {
    const manager = new CheckpointManager(dir)
    const checkpoint = manager.create("dreaming-scope-resume", "signet-dreaming", "dreaming-scenarios", "judge", "answerer")
    manager.initQuestion(checkpoint, "scope-question", "scope-question-run", {
      question: "Which scope owns this fixture?",
      groundTruth: "The fixture scope is preserved.",
      questionType: "dreaming",
    })
    manager.updatePhase(checkpoint, "scope-question", "ingest", {
      status: "completed",
      ingestResult: {
        documentIds: ["memorybench:scope-question-run:alpha"],
        taskIds: ["capture-alpha"],
        taskAgentIds: { "capture-alpha": "dreaming-gate-alpha" },
      },
    })
    await manager.flush("dreaming-scope-resume")

    expect(manager.load("dreaming-scope-resume")?.questions["scope-question"]?.phases.ingest.ingestResult).toMatchObject({
      taskAgentIds: { "capture-alpha": "dreaming-gate-alpha" },
    })
  })

  test("backfills missing question dates when resuming older checkpoints", () => {
    const manager = new CheckpointManager(dir)
    const checkpoint = manager.create(
      "question-date-backfill-run",
      "signet",
      "longmemeval",
      "judge",
      "answerer"
    )

    manager.initQuestion(checkpoint, "q1", "q1-run", {
      question: "How many weeks ago did I start using Ibotta?",
      groundTruth: "3 weeks ago",
      questionType: "temporal-reasoning",
    })
    manager.initQuestion(checkpoint, "q1", "q1-run", {
      question: "How many weeks ago did I start using Ibotta?",
      groundTruth: "3 weeks ago",
      questionType: "temporal-reasoning",
      questionDate: "2023/05/06 (Sat) 09:18",
    })

    expect(checkpoint.questions.q1?.questionDate).toBe("2023/05/06 (Sat) 09:18")
  })
})

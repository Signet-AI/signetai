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

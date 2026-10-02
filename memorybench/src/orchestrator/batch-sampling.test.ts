import { describe, expect, it } from "bun:test"
import { CheckpointManager } from "./checkpoint"
import { BatchManager, type CompareManifest } from "./batch"
import { Orchestrator } from "./index"
import { config } from "../utils/config"

class NonPersistingBatchManager extends BatchManager {
  override saveManifest(_manifest: CompareManifest): void {}
}

const selectedQuestions = ["joined-source-promotion", "correction-and-contradiction"]
const sampling = { mode: "limit", limit: 2 } as const

describe("question sampling production callers", () => {
  it("applies sampling when creating a compare manifest", async () => {
    const manifest = await new NonPersistingBatchManager().createManifest({
      providers: ["filesystem"],
      benchmark: "dreaming-scenarios",
      judgeModel: "gpt-4o",
      answeringModel: "gpt-4o",
      sampling,
    })

    expect(manifest.targetQuestionIds).toEqual(selectedQuestions)
    expect(manifest.sampling).toEqual(sampling)
  })

  it("persists the selected IDs when starting a sampled run", async () => {
    const runId = `sampling-${crypto.randomUUID().replaceAll("-", "")}`
    const checkpointManager = new CheckpointManager()
    const previousApiKey = config.openaiApiKey
    config.openaiApiKey = ""

    try {
      await expect(
        new Orchestrator().run({
          provider: "filesystem",
          benchmark: "dreaming-scenarios",
          judgeModel: "gpt-4o",
          runId,
          sampling,
          phases: [],
        })
      ).rejects.toThrow("Filesystem provider requires OPENAI_API_KEY for memory extraction")

      const checkpoint = checkpointManager.load(runId)
      if (!checkpoint) throw new Error("Sampled run checkpoint was not persisted")
      expect(checkpoint.sampling).toEqual(sampling)
      expect(checkpoint.targetQuestionIds).toEqual(selectedQuestions)
      expect(Object.keys(checkpoint.questions)).toEqual(selectedQuestions)
    } finally {
      config.openaiApiKey = previousApiKey
      checkpointManager.delete(runId)
    }
  })
})

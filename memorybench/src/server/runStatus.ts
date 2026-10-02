import type { QuestionCheckpoint, RunCheckpoint } from "../types/checkpoint"
import { getRunState } from "./runState"

type RunSummary = { evaluated: number; total: number; ingested: number }
export type RunStatusView = "running" | "stopping" | "completed" | "failed" | "partial" | "pending"

export function getRunStatus(checkpoint: RunCheckpoint, summary: RunSummary): RunStatusView {
  const runState = getRunState(checkpoint.runId)
  if (runState) return runState.status

  if (checkpoint.status === "completed") return "completed"
  if (checkpoint.status === "failed") return "failed"

  const questions = Object.values(checkpoint.questions || {})
  const hasFailed = questions.some((question) => {
    const phases: Partial<QuestionCheckpoint["phases"]> = question.phases || {}
    return (
      phases.ingest?.status === "failed" ||
      phases.indexing?.status === "failed" ||
      phases.search?.status === "failed" ||
      phases.answer?.status === "failed" ||
      phases.evaluate?.status === "failed"
    )
  })
  if (hasFailed) return "failed"

  if (summary.evaluated === summary.total && summary.total > 0) return "completed"
  if (checkpoint.status === "running") return "partial"
  if (checkpoint.status === "initializing") {
    return summary.ingested > 0 ? "partial" : "pending"
  }
  return summary.ingested === 0 ? "pending" : "partial"
}

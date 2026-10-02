import { readFileSync } from "node:fs"
import { logger } from "../utils/logger"

export function parseCommaSeparated(value: string | undefined): string[] {
  if (!value) return []
  return value
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0)
}

export function appendCsvValues(
  current: string[] | undefined,
  value: string | undefined
): string[] {
  return [...(current || []), ...parseCommaSeparated(value)]
}

export function readIdListFile(path: string): string[] {
  return readFileSync(path, "utf8")
    .split(/\r?\n/)
    .map((line) => line.replace(/#.*/, "").trim())
    .filter((line) => line.length > 0)
}

export function generateRunId(): string {
  const now = new Date()
  const date = now.toISOString().slice(0, 10).replace(/-/g, "")
  const time = now.toISOString().slice(11, 19).replace(/:/g, "")
  return `run-${date}-${time}`
}

export function appendQuestionIds(
  flag: string,
  value: string | undefined,
  current: string[] | undefined
): string[] | null {
  const existing = current ?? []
  if (!value) {
    logger.error(
      flag === "--question-ids-file" ? `${flag} requires a path` : `${flag} requires a question id`
    )
    return null
  }

  const questionIds =
    flag === "--question-ids-file"
      ? [...existing, ...readIdListFile(value)]
      : appendCsvValues(existing, value)
  if (questionIds.length === existing.length) {
    logger.error(
      flag === "--question-ids-file"
        ? "Question ids file cannot be empty"
        : "Question id filter cannot be empty"
    )
    return null
  }
  return questionIds
}

import { readFileSync } from "node:fs"

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

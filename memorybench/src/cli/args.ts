import { readFileSync } from "node:fs"
import type { BenchmarkConfig } from "../types/benchmark"

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

export const BENCHMARK_CONFIG_FLAGS = [
  "--data-path",
  "--dataset-revision",
  "--retrieval-top-k",
  "--evaluation-profile",
] as const

export function isBenchmarkConfigFlag(arg: string): boolean {
  return (BENCHMARK_CONFIG_FLAGS as readonly string[]).includes(arg)
}

export function applyBenchmarkConfigArg(
  config: BenchmarkConfig,
  flag: string,
  value: string | undefined
): string | undefined {
  if (!value || value.startsWith("-")) return `${flag} requires a value`
  if (flag === "--data-path") config.dataPath = value
  if (flag === "--dataset-revision") config.datasetRevision = value
  if (flag === "--evaluation-profile") config.evaluationProfile = value
  if (flag === "--retrieval-top-k") {
    const topK = Number(value)
    if (!Number.isInteger(topK) || topK < 1) return `${flag} must be a positive integer`
    config.retrievalTopK = topK
  }
  return undefined
}

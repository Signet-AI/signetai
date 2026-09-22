export interface ConcurrencyConfig {
  default?: number
  ingest?: number
  indexing?: number
  search?: number
  answer?: number
  evaluate?: number
}

export type PhaseId = "ingest" | "indexing" | "search" | "answer" | "evaluate"

export type PhaseConcurrencyMap = {
  [K in PhaseId]: number
}

export function resolveConcurrency(
  phase: PhaseId,
  cliConfig?: ConcurrencyConfig,
  providerDefault?: ConcurrencyConfig
): number {
  if (cliConfig && cliConfig[phase] !== undefined) {
    return cliConfig[phase]!
  }
  if (cliConfig?.default !== undefined) {
    return cliConfig.default
  }
  if (providerDefault && providerDefault[phase] !== undefined) {
    return providerDefault[phase]!
  }
  if (providerDefault?.default !== undefined) {
    return providerDefault.default
  }
  return 1
}

export type RunState = {
  status: "running" | "stopping"
  startedAt: string
  benchmark?: string
}
export const activeRuns = new Map<string, RunState>()
export function shouldStop(runId: string): boolean {
  const state = activeRuns.get(runId)
  return state?.status === "stopping"
}
export function requestStop(runId: string): boolean {
  const state = activeRuns.get(runId)
  if (!state) return false
  state.status = "stopping"
  return true
}
export function startRun(runId: string, benchmark?: string): void {
  activeRuns.set(runId, {
    status: "running",
    startedAt: new Date().toISOString(),
    benchmark,
  })
}
export function endRun(runId: string): void {
  activeRuns.delete(runId)
}
export function isRunActive(runId: string): boolean {
  return activeRuns.has(runId)
}
export function getRunState(runId: string): RunState | undefined {
  return activeRuns.get(runId)
}
export function getActiveRunsWithBenchmarks(): Array<{ runId: string; benchmark: string }> {
  const result: Array<{ runId: string; benchmark: string }> = []
  for (const [runId, state] of activeRuns) {
    if (state.benchmark) {
      result.push({ runId, benchmark: state.benchmark })
    }
  }
  return result
}

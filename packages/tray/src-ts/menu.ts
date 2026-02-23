import type { DaemonState } from "./state";

export interface TrayUpdate {
  readonly kind: "running" | "stopped" | "error";
  readonly version?: string;
  readonly health_score?: number | null;
  readonly health_status?: string | null;
  readonly message?: string;
}

export function buildTrayUpdate(state: DaemonState): TrayUpdate {
  switch (state.kind) {
    case "running":
      return {
        kind: "running",
        version: state.version,
        health_score: state.healthScore,
        health_status: state.healthStatus,
      };

    case "stopped":
      return { kind: "stopped" };

    case "error":
      return { kind: "error", message: state.message };

    case "unknown":
      return { kind: "stopped" };
  }
}

import type { HealthResponse, StatusResponse } from "@signet/sdk";

export type DaemonState =
  | { readonly kind: "unknown" }
  | {
      readonly kind: "running";
      readonly version: string;
      readonly pid: number;
      readonly uptime: number;
      readonly healthScore: number | null;
      readonly healthStatus: string | null;
    }
  | { readonly kind: "stopped" }
  | { readonly kind: "error"; readonly message: string };

export async function deriveState(
  baseUrl: string,
): Promise<DaemonState> {
  try {
    const healthRes = await fetch(`${baseUrl}/health`, {
      signal: AbortSignal.timeout(3000),
    });

    if (!healthRes.ok) {
      return { kind: "error", message: `HTTP ${healthRes.status}` };
    }

    const health: HealthResponse = await healthRes.json();

    // Fetch full status for extra details
    let healthScore: number | null = null;
    let healthStatus: string | null = null;

    try {
      const statusRes = await fetch(`${baseUrl}/api/status`, {
        signal: AbortSignal.timeout(3000),
      });

      if (statusRes.ok) {
        const status: StatusResponse = await statusRes.json();
        healthScore = status.health?.score ?? null;
        healthStatus = status.health?.status ?? null;
      }
    } catch {
      // Non-critical — health endpoint succeeded so daemon is running
    }

    return {
      kind: "running",
      version: health.version,
      pid: health.pid,
      uptime: health.uptime,
      healthScore,
      healthStatus,
    };
  } catch (err: unknown) {
    if (
      err instanceof TypeError ||
      (err instanceof DOMException && err.name === "AbortError")
    ) {
      return { kind: "stopped" };
    }

    const message =
      err instanceof Error ? err.message : "Unknown error";
    return { kind: "error", message };
  }
}

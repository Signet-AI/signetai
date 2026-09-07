---
title: "Diagnostics"
description: "Inspect daemon health and run bounded repair actions with evidence."
---

Diagnostics are the operator surface for queue, storage, index, provider, mutation, connector, and update health. Treat them as evidence, not a license to reset state.

## Start with status and readiness

```bash
signet daemon status --json
curl -fsS http://127.0.0.1:3850/health/live
curl -fsS http://127.0.0.1:3850/health/ready
curl -fsS http://127.0.0.1:3850/api/diagnostics
```

`/health/live` answers whether the process is up. `/health/ready` includes readiness gates. `/api/diagnostics` returns the detailed report. Its `workloads` block is scoped to the requested agent and includes active inference/Pi and MCP requests, provider semaphore running and pending counts, oldest ages, and Dreaming pass and attention backlog counts and ages. The focused `/api/diagnostics/workloads` endpoint returns the same bounded workload snapshot. In authenticated deployments, diagnostics require the appropriate operator or admin permission.

Use the report to identify the failing domain before taking action. Do not treat a low composite score as a diagnosis by itself.

## Useful investigations

| Symptom                            | First evidence                                                                |
| ---------------------------------- | ----------------------------------------------------------------------------- |
| Daemon unreachable                 | `signet daemon status --json`, `/health/live`, bind address and service logs. |
| Daemon up but not usable           | `/health/ready`, `/api/status`, and the exact readiness reasons.              |
| Work backlog or repeated failures  | `/api/diagnostics`, then the queue and pipeline status.                       |
| Search looks incomplete            | diagnostics plus the embedding/index status before changing models.           |
| Recent deployment changed behavior | `/api/status`, update status, and daemon logs.                                |
| Provider trouble                   | provider diagnostics, configured routing target, and provider reachability.   |

## Repair actions

Repair endpoints are privileged. They are for a diagnosed condition, not first-line recovery. Back up private workspace state before a destructive or broad action.

Current repair routes include:

```text
GET  /api/repair/integrity-check
POST /api/repair/requeue-dead
POST /api/repair/release-leases
POST /api/repair/check-fts
POST /api/repair/retention-sweep
```

The daemon's full-database integrity scan runs on the process database
owner's verification lane, outside the HTTP/event-loop process. The route
awaits both `quick_check` and `integrity_check` and returns an explicit
`passed`, `failed`, `timed_out`, `cancelled`, or `unavailable` outcome. A
completed verification (including a confirmed failed check) returns `200`;
transport/deadline failures return `503`/`504`. The owner boundary has a bounded deadline; an uninterruptible native scan retires
that owner child when the deadline or cancellation is reached rather than
continuing as detached work. The same integrity progress/status model used by
incremental maintenance is updated while the operator scan runs. A confirmed
failure is reported by `/health` and `/health/ready`, with actionable offline
repair guidance.

Examples:

```bash
# Read-only integrity evidence
curl -fsS http://127.0.0.1:3850/api/repair/integrity-check

# Requeue dead work only after identifying why it died
curl -fsS -X POST http://127.0.0.1:3850/api/repair/requeue-dead

# Release stale leases only after checking the worker is not still active
curl -fsS -X POST http://127.0.0.1:3850/api/repair/release-leases
```

Rate limits and maintenance policy protect repairs from repeated automated retries. A rejected repair is a signal to inspect the root cause, not a reason to loop the request.

The retired transcript backfill route is not a recovery path. Current transcript delivery goes directly to Dreaming; do not build automation around an older backfill endpoint.

## Maintenance configuration

Autonomous maintenance is configured under `memory.pipelineV2.autonomous`:

```yaml
memory:
  pipelineV2:
    autonomous:
      enabled: true
      frozen: false
      maintenanceIntervalMs: 1800000
      maintenanceMode: observe
```

Use `observe` when introducing a deployment or investigating an incident. Set `frozen: true` to stop autonomous writes while preserving the configuration. The `repair` subobject sets cooldowns and hourly budgets for re-embed, requeue, and deduplication work.

Restart after changing these values because pipeline workers are long-running.

## Escalation order

1. Capture status, readiness, diagnostics, and relevant daemon logs.
2. Correct an unavailable provider, invalid config, network bind, or permission issue.
3. Restart only when the evidence supports it.
4. Use one narrow repair action if its precondition is satisfied.
5. Re-run the same health checks and record the result.

Never delete the database, auth secret, or workspace to make a health check go green. Preserve evidence and restore from a verified backup when integrity is actually compromised.

Related: [Daemon](/daemon/), [Analytics](/analytics/), [Self-Hosting](/self-hosting/).

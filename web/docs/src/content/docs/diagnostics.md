---
title: "Diagnostics"
description: "Follow a short evidence-based path from health checks to repair."
---

Use diagnostics to identify the failing boundary before changing state.

## Decision path

1. Check the process and readiness:

   ```bash
   signet daemon status --json
   curl -fsS http://127.0.0.1:3850/health/live
   curl -fsS http://127.0.0.1:3850/health/ready
   ```

2. If the process is reachable but work is unhealthy, read the bounded report:

   ```bash
   curl -fsS http://127.0.0.1:3850/api/diagnostics
   curl -fsS http://127.0.0.1:3850/api/diagnostics/workloads
   ```

3. Follow the report to the relevant queue, pipeline, index, provider, connector, or permission surface. Check daemon logs and the configured route before changing configuration.

4. Re-run the same checks after the change. Restart only when the changed setting or deployment requires it.

In authenticated deployments, diagnostics require the operator or admin permission required by the route. `/health/live` reports process liveness; `/health/ready` reports readiness gates. The diagnostics workload view is scoped to the requested agent and includes active inference/MCP work, provider semaphore counts, and Dreaming backlog ages.

## Privileged repair

Use a repair route only after identifying its precondition:

```text
GET  /api/repair/integrity-check
POST /api/repair/requeue-dead
POST /api/repair/release-leases
POST /api/repair/check-fts
POST /api/repair/retention-sweep
```

Repairs are permission-protected and bounded. The integrity scan is single-flight and has a 30-second wall-clock budget. Record the result and repeat the health checks. The old transcript backfill route is legacy; current transcript delivery goes directly to Dreaming.

Keep private workspace state and logs available for investigation. Do not reset a database, auth secret, or workspace as a diagnostic step.

For autonomous maintenance, use `memory.pipelineV2.autonomous` and verify with the pipeline status surface. See [Pipeline configuration](/configuration/pipeline/) and [Analytics](/analytics/).

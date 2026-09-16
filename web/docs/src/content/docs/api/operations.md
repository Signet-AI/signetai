---
title: "Operations API"
description: "Pipeline, diagnostics, synchronization, repair, and maintenance operations."
---

[Back to HTTP API](/api/).

## Pipeline and diagnostics

- `GET /api/pipeline/status` reports pipeline state; pause/resume are
  `POST /api/pipeline/pause` and `/api/pipeline/resume` (admin).
- `GET /api/pipeline/models` and `/by-provider` read model state;
  `POST /api/pipeline/models/refresh` refreshes it (admin).
- Diagnostic families include `/api/diagnostics`, `/transcripts`, `/workloads`,
  `/database/schema`, and `/database/tables/:table/sample`. Diagnostic reads
  require diagnostics permission; mutations require admin or the route-specific
  permission. Workload diagnostics are scoped and expose active inference/MCP
  work, provider semaphore use, and Dreaming backlog ages.

Use [Diagnostics](/diagnostics/) for the operator workflow and the returned
report schema. Do not treat a diagnostic snapshot as an independent source of
truth.

## Sync, updates, and repair

- `GET /api/git/status` inspects synchronization state; `POST /api/git/sync`
  performs the guarded sync operation. Full connector resync requires the
  explicit `?confirm=true` query parameter. Conflicts are reported rather than
  overwritten; resolve them and retry.
- Update status/check/run routes report queued, running, completed, failed, or
  cancelled state. Keep update intervals within the configured bounded range;
  inspect status after a run rather than assuming dispatch means completion.
- `/api/repair/*` is the explicit operator repair surface. Repair and database
  integrity recovery require the relevant admin/repair permission, a backup
  before destructive work, and the confirmation requested by the route. Stop
  the daemon before offline integrity repair when diagnostics says to do so.
  Repair results and conflicts remain explicit and are audited.
- `POST /api/repair/re-embed` backfills missing memory embeddings in the resolved
  agent scope. Its JSON body accepts `agentId` (or `agent_id`), `batchSize`,
  `dryRun`, and `fullSweep`; defaults are `batchSize: 50`, `dryRun: false`, and
  `fullSweep: false`. `batchSize` is capped at 500; positive finite values are floored and clamped
  to that cap, while invalid or non-positive values fall back to 50. A normal request processes one
  batch. `fullSweep: true` continues batch-by-batch until no progress or no rows
  remain, with the operator cooldown bypass. The route requires `admin`, rejects
  overlapping runs, and returns a structured repair result.
- Harness recovery routes (including connector reinitialization) require a
  request body with `confirm: true` because they may update connector-owned
  configuration. Missing or malformed confirmation is rejected; do not use
  reinitialization as a silent repair fallback.

Dream routes expose bounded work and explicit `queued`, `running`, `completed`,
`failed`, and `cancelled` pass states:

- Observation and administration: `GET /api/dream/status`, `GET
  /api/dream/passes/active`, `GET /api/dream/passes/:passId/events`, `GET
  /api/dream/passes/:passId/tools`, and `GET /api/dream/quality`.
- External Dreaming operations: `POST /api/dream/operations`, `GET
  /api/dream/tools`, and `POST /api/dream/tools/:capability`. These use the
  `modify` permission and remain scoped to the caller's agent.
- Administrative controls: `POST /api/dream/trigger` and `POST
  /api/dream/exclusions/requeue`, which use the `admin` permission. Trigger
  accepts `mode: "incremental"` or `"compact"`; exclusion requeue accepts
  `sourceKind` and `sourceId`. Summary requeue returns `410` because it is
  retired; requeue the completed transcript instead.

The events stream resumes from `after` or `Last-Event-ID` (the query takes
precedence), using non-negative integer event cursors. Snapshot and gap frames
are not cursor checkpoints. `verbose=1` or `true` opts into verbose events.
`POST /api/repair/backfill-skipped` is retired and returns `410`; completed
transcripts are consumed by Dreaming and must not be backfilled through that
route.
See [upgrading](/upgrading/), [self-hosting](/self-hosting/), and the
[platform services architecture](https://github.com/Signet-AI/signetai/blob/main/web/docs/src/content/docs/architecture/platform-services.md)
for recovery context and larger operational references.

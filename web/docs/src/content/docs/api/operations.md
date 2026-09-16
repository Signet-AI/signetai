---
title: "Operations API"
description: "Pipeline, diagnostics, synchronization, repair, and maintenance operations."
---

[Back to HTTP API](/api/).

## Pipeline

| Route | Status | Permission |
|---|---|---|
| GET `/api/pipeline/status` | canonical | diagnostics |
| POST `/api/pipeline/pause` | canonical | admin |
| POST `/api/pipeline/resume` | canonical | admin |
| GET `/api/pipeline/models` | canonical | inference read |
| GET `/api/pipeline/models/by-provider` | canonical | inference read |
| POST `/api/pipeline/models/refresh` | canonical | admin |

## Diagnostics and synchronization

Canonical route families include `/api/diagnostics`,
`/api/diagnostics/transcripts`, `/api/diagnostics/workloads`,
`/api/diagnostics/database/schema`, `/api/diagnostics/database/tables/:table/sample`,
`/api/git/status`, `/api/git/sync`, and `/api/repair/*`. Diagnostic reads require
the diagnostics permission; mutations and repair operations require admin or the
specific repair permission.

`/api/dream/status`, `/api/dream/passes/active`,
`/api/dream/passes/:passId/events`, `/api/dream/passes/:passId/tools`,
`/api/dream/quality`, `/api/dream/operations`, `/api/dream/tools`, and
`/api/dream/trigger` are canonical dreaming operations. They are bounded and
report queued, running, completed, failed, or cancelled state explicitly.

`POST /api/repair/backfill-skipped` is **retired** and returns `410`; direct
completed transcripts are consumed by Dreaming. It is not a fallback.

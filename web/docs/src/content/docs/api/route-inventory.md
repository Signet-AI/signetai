---
title: "Additional route inventory"
description: "Support, dashboard, repair, marketplace, and runtime routes not expanded in the main API reference."
---

Support, dashboard, repair, marketplace, and runtime routes not expanded in the main API reference.

[Back to HTTP API overview](/api/).

## Additional Route Inventory

The sections above document the primary public contracts. The daemon also
exposes these support, dashboard, repair, marketplace, and runtime routes.
This inventory records additional registered route paths. Dynamic handlers are
expanded only when their finite actions are explicit in source; this is not a
generated runtime route dump.

| Method | Path | Source |
|--------|------|--------|
| GET | `/api/changelog` | platform/daemon/src/http/routes/changelog.ts |
| GET | `/api/roadmap` | platform/daemon/src/http/routes/changelog.ts |
| GET | `/api/readme` | platform/daemon/src/http/routes/changelog.ts |
| GET | `/health/live` | platform/daemon/src/http/routes/health.ts |
| GET | `/health/ready` | platform/daemon/src/http/routes/health.ts |
| GET | `/api/mode` | platform/daemon/src/http/routes/health.ts |
| POST | `/api/connectors/resync` | platform/daemon/src/http/routes/connectors-routes.ts |
| GET | `/api/graphiq/status` | platform/daemon/src/http/routes/graphiq-routes.ts |
| POST | `/api/graphiq/install` | platform/daemon/src/http/routes/graphiq-routes.ts |
| POST | `/api/graphiq/update` | platform/daemon/src/http/routes/graphiq-routes.ts |
| POST | `/api/graphiq/uninstall` | platform/daemon/src/http/routes/graphiq-routes.ts |
| POST | `/api/graphiq/index` | platform/daemon/src/http/routes/graphiq-routes.ts |
| POST | `/api/hooks/notifications` | platform/daemon/src/http/routes/hooks-routes.ts |
| GET | `/api/cross-agent/presence` | platform/daemon/src/http/routes/hooks-routes.ts |
| POST | `/api/cross-agent/presence` | platform/daemon/src/http/routes/hooks-routes.ts |
| DELETE | `/api/cross-agent/presence/:sessionKey` | platform/daemon/src/http/routes/hooks-routes.ts |
| GET | `/api/cross-agent/sessions/:sessionKey/context` | platform/daemon/src/http/routes/hooks-routes.ts |
| GET | `/api/cross-agent/messages` | platform/daemon/src/http/routes/hooks-routes.ts |
| POST | `/api/cross-agent/messages` | platform/daemon/src/http/routes/hooks-routes.ts |
| POST | `/api/cross-agent/messages/:messageId/ack` | platform/daemon/src/http/routes/hooks-routes.ts |
| POST | `/api/cross-agent/messages/:messageId/retry` | platform/daemon/src/http/routes/hooks-routes.ts |
| GET | `/api/cross-agent/stream` | platform/daemon/src/http/routes/hooks-routes.ts |
| POST | `/api/cross-agent/wake` | platform/daemon/src/http/routes/hooks-routes.ts |
| POST | `/api/cross-agent/wake/release` | platform/daemon/src/http/routes/hooks-routes.ts |
| GET | `/api/board/topics` | platform/daemon/src/http/routes/board-routes.ts |
| POST | `/api/board/topics` | platform/daemon/src/http/routes/board-routes.ts |
| GET | `/api/board/threads` | platform/daemon/src/http/routes/board-routes.ts |
| POST | `/api/board/threads` | platform/daemon/src/http/routes/board-routes.ts |
| GET | `/api/board/threads/:threadId` | platform/daemon/src/http/routes/board-routes.ts |
| PATCH | `/api/board/threads/:threadId` | platform/daemon/src/http/routes/board-routes.ts |
| DELETE | `/api/board/threads/:threadId` | platform/daemon/src/http/routes/board-routes.ts |
| POST | `/api/board/threads/:threadId/posts` | platform/daemon/src/http/routes/board-routes.ts |
| POST | `/api/board/threads/:threadId/read` | platform/daemon/src/http/routes/board-routes.ts |
| GET | `/api/board/stream` | platform/daemon/src/http/routes/board-routes.ts |
| POST | `/api/synthesis/trigger` | platform/daemon/src/http/routes/hooks-routes.ts |
| GET | `/api/synthesis/status` | platform/daemon/src/http/routes/hooks-routes.ts |
| GET | `/api/sources` | platform/daemon/src/http/routes/sources-routes.ts |
| POST | `/api/sources/pick-directory` | platform/daemon/src/http/routes/sources-routes.ts |
| POST | `/api/sources/pick-files` | platform/daemon/src/http/routes/sources-routes.ts (loopback-only; returns local paths for a subsequent paths-based import) |
| POST | `/api/sources/obsidian` | platform/daemon/src/http/routes/sources-routes.ts |
| POST | `/api/sources/discord` | platform/daemon/src/http/routes/sources-routes.ts |
| POST | `/api/sources/import` | platform/daemon/src/http/routes/import-routes.ts |
| POST | `/api/sources/web` | platform/daemon/src/http/routes/sources-routes.ts |
| GET | `/api/sources/:sourceId/health` | platform/daemon/src/http/routes/sources-routes.ts |
| GET | `/api/sources/:sourceId/snapshot` | platform/daemon/src/http/routes/sources-routes.ts |
| POST | `/api/sources/:sourceId/snapshot/import` | platform/daemon/src/http/routes/sources-routes.ts |
| DELETE | `/api/sources/:sourceId` | platform/daemon/src/http/routes/sources-routes.ts |
| GET | `/api/knowledge/entities` | platform/daemon/src/http/routes/knowledge-routes.ts |
| POST | `/api/knowledge/entities/:id/pin` | platform/daemon/src/http/routes/knowledge-routes.ts |
| DELETE | `/api/knowledge/entities/:id/pin` | platform/daemon/src/http/routes/knowledge-routes.ts |
| GET | `/api/knowledge/entities/pinned` | platform/daemon/src/http/routes/knowledge-routes.ts |
| GET | `/api/knowledge/entities/health` | platform/daemon/src/http/routes/knowledge-routes.ts |
| GET | `/api/knowledge/entities/:id` | platform/daemon/src/http/routes/knowledge-routes.ts |
| GET | `/api/knowledge/entities/:id/aspects` | platform/daemon/src/http/routes/knowledge-routes.ts |
| GET | `/api/knowledge/entities/:id/aspects/:aspectId/attributes` | platform/daemon/src/http/routes/knowledge-routes.ts |
| GET | `/api/knowledge/entities/:id/dependencies` | platform/daemon/src/http/routes/knowledge-routes.ts |
| GET | `/api/knowledge/stats` | platform/daemon/src/http/routes/knowledge-routes.ts |
| GET | `/api/knowledge/communities` | platform/daemon/src/http/routes/knowledge-routes.ts |
| GET | `/api/knowledge/traversal/status` | platform/daemon/src/http/routes/knowledge-routes.ts |
| GET | `/api/knowledge/constellation` | platform/daemon/src/http/routes/knowledge-routes.ts |
| POST | `/api/knowledge/expand` | platform/daemon/src/http/routes/knowledge-routes.ts |
| POST | `/api/knowledge/expand/session` | platform/daemon/src/http/routes/knowledge-routes.ts |
| POST | `/api/graph/impact` | platform/daemon/src/http/routes/knowledge-routes.ts |
| GET | `/api/ontology/claims/versions` | platform/daemon/src/http/routes/ontology-routes.ts |
| GET | `/api/ontology/claims/explain` | platform/daemon/src/http/routes/ontology-routes.ts |
| GET | `/api/ontology/claims/version` | platform/daemon/src/http/routes/ontology-routes.ts |
| POST | `/api/ontology/operations/apply` | platform/daemon/src/http/routes/ontology-routes.ts |
| POST | `/api/ontology/operations/batch` | platform/daemon/src/http/routes/ontology-routes.ts |
| POST | `/api/ontology/proposals/repair/merge-plan` | platform/daemon/src/http/routes/ontology-routes.ts |
| GET | `/api/marketplace/reviews` | platform/daemon/src/http/routes/marketplace-reviews.ts |
| POST | `/api/marketplace/reviews` | platform/daemon/src/http/routes/marketplace-reviews.ts |
| PATCH | `/api/marketplace/reviews/config` | platform/daemon/src/http/routes/marketplace-reviews.ts |
| PATCH | `/api/marketplace/reviews/:id` | platform/daemon/src/http/routes/marketplace-reviews.ts |
| DELETE | `/api/marketplace/reviews/:id` | platform/daemon/src/http/routes/marketplace-reviews.ts |
| GET | `/api/marketplace/reviews/config` | platform/daemon/src/http/routes/marketplace-reviews.ts |
| POST | `/api/marketplace/reviews/sync` | platform/daemon/src/http/routes/marketplace-reviews.ts |
| GET | `/api/memories/most-used` | platform/daemon/src/http/routes/memory-routes.ts |
| GET | `/api/memory/timeline` | platform/daemon/src/http/routes/memory-routes.ts |
| GET | `/api/memory/review-queue` | platform/daemon/src/http/routes/memory-routes.ts |
| GET | `/api/memory/jobs/:id` | platform/daemon/src/http/routes/memory-routes.ts |
| POST | `/api/memory/feedback` | platform/daemon/src/http/routes/memory-routes.ts |
| GET | `/api/home/greeting` | platform/daemon/src/http/routes/pipeline-routes.ts |
| GET | `/api/reflections/today` | platform/daemon/src/http/routes/reflection-routes.ts |
| GET | `/api/reflections` | platform/daemon/src/http/routes/reflection-routes.ts |
| POST | `/api/reflections/generate` | platform/daemon/src/http/routes/reflection-routes.ts |
| POST | `/api/reflections/:id/answer` | platform/daemon/src/http/routes/reflection-routes.ts |
| GET | `/api/diagnostics/database/schema` | platform/daemon/src/http/routes/database-diagnostics.ts |
| GET | `/api/diagnostics/database/tables/:table/sample` | platform/daemon/src/http/routes/database-diagnostics.ts |
| POST | `/api/diagnostics/openclaw/heartbeat` | platform/daemon/src/http/routes/pipeline-routes.ts |
| GET | `/api/diagnostics/openclaw` | platform/daemon/src/http/routes/pipeline-routes.ts |
| GET | `/api/diagnostics/transcripts` | platform/daemon/src/http/routes/pipeline-routes.ts |
| GET | `/api/diagnostics/workloads` | platform/daemon/src/http/routes/pipeline-routes.ts |
| GET | `/api/pipeline/models` | platform/daemon/src/http/routes/pipeline-routes.ts |
| GET | `/api/pipeline/models/by-provider` | platform/daemon/src/http/routes/pipeline-routes.ts |
| POST | `/api/pipeline/models/refresh` | platform/daemon/src/http/routes/pipeline-routes.ts |
| POST | `/api/repair/resync-vec` | platform/daemon/src/http/routes/repair-routes.ts |
| POST | `/api/repair/clean-orphans` | platform/daemon/src/http/routes/repair-routes.ts |
| POST | `/api/repair/backfill-skipped` | platform/daemon/src/http/routes/repair-routes.ts (retired; returns HTTP 410; direct completed transcripts are consumed by Dreaming) |
| POST | `/api/repair/prune-chunk-groups` | platform/daemon/src/http/routes/repair-routes.ts |
| POST | `/api/repair/prune-singleton-entities` | platform/daemon/src/http/routes/repair-routes.ts |
| POST | `/api/repair/prune-generic-entities` | platform/daemon/src/http/routes/repair-routes.ts |
| GET | `/api/repair/cold-stats` | platform/daemon/src/http/routes/repair-routes.ts |
| POST | `/api/repair/cluster-entities` | platform/daemon/src/http/routes/repair-routes.ts |
| POST | `/api/repair/relink-entities` | platform/daemon/src/http/routes/repair-routes.ts |
| GET | `/api/repair/integrity-check` | platform/daemon/src/http/routes/repair-routes.ts |
| POST | `/api/repair/rebuild-indexes` | platform/daemon/src/http/routes/repair-routes.ts |
| POST | `/api/repair/backfill-hints` | platform/daemon/src/http/routes/repair-routes.ts |
| GET | `/api/repair/dead-memories` | platform/daemon/src/http/routes/repair-routes.ts |
| POST | `/api/repair/dead-memories/forget` | platform/daemon/src/http/routes/repair-routes.ts |
| GET | `/api/troubleshoot/commands` | platform/daemon/src/http/routes/repair-routes.ts |
| POST | `/api/troubleshoot/exec` | platform/daemon/src/http/routes/repair-routes.ts |
| POST | `/api/sessions/:key/renew` | platform/daemon/src/http/routes/session-routes.ts |
| GET | `/api/skills/browse` | platform/daemon/src/http/routes/skills.ts |
| GET | `/api/telemetry/memory-search` | platform/daemon/src/http/routes/telemetry-routes.ts |
| GET | `/api/telemetry/health` | platform/daemon/src/http/routes/telemetry-routes.ts |
| GET | `/api/telemetry/memory-search/export` | platform/daemon/src/http/routes/telemetry-routes.ts |

## Workspace and harness lifecycle

| Method | Path | Source |
|--------|------|--------|
| GET | `/api/harnesses/:id/health` | platform/daemon/src/http/routes/connectors-routes.ts |
| GET | `/api/hooks/transcript-capture/:jobId` | platform/daemon/src/http/routes/hooks-routes.ts |
| POST | `/api/hooks/stop` | platform/daemon/src/http/routes/hooks-routes.ts |
| POST | `/api/hooks/skill-invocation` | platform/daemon/src/http/routes/hooks-routes.ts |
| GET | `/api/memories/curator-slices` | platform/daemon/src/http/routes/memory-routes.ts |
| POST | `/api/memories/:id/tombstone` | platform/daemon/src/http/routes/memory-routes.ts |
| POST | `/api/memories/:id/supersede` | platform/daemon/src/http/routes/memory-routes.ts |
| PATCH | `/api/agents/:name` | platform/daemon/src/http/routes/misc-routes.ts |
| POST | `/api/harnesses/:id/connect` | platform/daemon/src/http/routes/harness-install.ts |
| POST | `/api/harnesses/:id/disconnect` | platform/daemon/src/http/routes/harness-install.ts |

`POST /api/sources/web` adds a public web source and queues indexing.

## Transcript import upload routes

Transcript import jobs are agent-scoped and require `modify` permission. Create
a job with `POST /api/sources/imports`, then upload each listed file. A direct
`PUT` sends the raw JSONL body and requires `upload-length` or `content-length`.
Resumable `PATCH` requires `upload-length`, `upload-offset`, and
`upload-checksum`; finalize seals a completed upload. The job status is available
from `GET /api/sources/imports/:jobId`. Up to 25 files are admitted per job;
duplicate mode is `skip` (default), `replace`, or `reimport`.

| Method | Path | Source |
|--------|------|--------|
| PUT | `/api/sources/imports/:jobId/files/:fileId` | platform/daemon/src/http/routes/transcript-import-routes.ts |
| PATCH | `/api/sources/imports/:jobId/files/:fileId` | platform/daemon/src/http/routes/transcript-import-routes.ts |
| POST | `/api/sources/imports/:jobId/files/:fileId/finalize` | platform/daemon/src/http/routes/transcript-import-routes.ts |
| POST | `/api/sources/imports/:jobId/files/:fileId/reset` | platform/daemon/src/http/routes/transcript-import-routes.ts |
| GET | `/api/sources/imports/:jobId/files/:fileId/content` | platform/daemon/src/http/routes/transcript-import-routes.ts |


## Dashboard

### GET /

Serves the React/Vite dashboard as a generic single-page application. Static
assets are served from the built dashboard directory or, when available, the
packaged embedded dashboard assets. The dashboard handler passes `/api/*`,
`/health`, and `/sse` through; remaining paths without a file extension fall
back to `index.html` for client-side routing.

If the dashboard build is not found, a minimal HTML fallback page is served
with links to key API endpoints.

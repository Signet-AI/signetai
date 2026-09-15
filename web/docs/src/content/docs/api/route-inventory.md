---
title: "Additional route inventory"
description: "Support, dashboard, repair, marketplace, and runtime routes not expanded in the main API reference."
---

Support, dashboard, repair, marketplace, and runtime routes not expanded in the main API reference.

[Back to HTTP API overview](/api/).

## Additional Route Inventory

The sections above document the primary public contracts. The daemon also
exposes these support, dashboard, repair, marketplace, and runtime routes.
This inventory is generated from route registrations so additions do not
silently disappear from the API reference.

| Method | Path | Source |
|--------|------|--------|
| GET | `/api/changelog` | platform/daemon/src/routes/changelog.ts |
| GET | `/api/roadmap` | platform/daemon/src/routes/changelog.ts |
| GET | `/api/readme` | platform/daemon/src/routes/changelog.ts |
| GET | `/health/live` | platform/daemon/src/routes/health.ts |
| GET | `/health/ready` | platform/daemon/src/routes/health.ts |
| GET | `/api/mode` | platform/daemon/src/routes/health.ts |
| POST | `/api/connectors/resync` | platform/daemon/src/routes/connectors-routes.ts |
| GET | `/api/graphiq/status` | platform/daemon/src/routes/graphiq-routes.ts |
| POST | `/api/graphiq/install` | platform/daemon/src/routes/graphiq-routes.ts |
| POST | `/api/graphiq/update` | platform/daemon/src/routes/graphiq-routes.ts |
| POST | `/api/graphiq/uninstall` | platform/daemon/src/routes/graphiq-routes.ts |
| POST | `/api/graphiq/index` | platform/daemon/src/routes/graphiq-routes.ts |
| POST | `/api/hooks/notifications` | platform/daemon/src/routes/hooks-routes.ts |
| GET | `/api/cross-agent/presence` | platform/daemon/src/routes/hooks-routes.ts |
| POST | `/api/cross-agent/presence` | platform/daemon/src/routes/hooks-routes.ts |
| DELETE | `/api/cross-agent/presence/:sessionKey` | platform/daemon/src/routes/hooks-routes.ts |
| GET | `/api/cross-agent/messages` | platform/daemon/src/routes/hooks-routes.ts |
| POST | `/api/cross-agent/messages` | platform/daemon/src/routes/hooks-routes.ts |
| POST | `/api/cross-agent/messages/:messageId/ack` | platform/daemon/src/routes/hooks-routes.ts |
| POST | `/api/cross-agent/messages/:messageId/retry` | platform/daemon/src/routes/hooks-routes.ts |
| GET | `/api/cross-agent/stream` | platform/daemon/src/routes/hooks-routes.ts |
| POST | `/api/synthesis/trigger` | platform/daemon/src/routes/hooks-routes.ts |
| GET | `/api/synthesis/status` | platform/daemon/src/routes/hooks-routes.ts |
| GET | `/api/sources` | platform/daemon/src/routes/sources-routes.ts |
| POST | `/api/sources/pick-directory` | platform/daemon/src/routes/sources-routes.ts |
| POST | `/api/sources/pick-files` | platform/daemon/src/routes/sources-routes.ts (loopback-only; returns local paths for a subsequent paths-based import) |
| POST | `/api/sources/obsidian` | platform/daemon/src/routes/sources-routes.ts |
| POST | `/api/sources/discord` | platform/daemon/src/routes/sources-routes.ts |
| POST | `/api/sources/import` | platform/daemon/src/routes/import-routes.ts |
| GET | `/api/sources/:sourceId/health` | platform/daemon/src/routes/sources-routes.ts |
| GET | `/api/sources/:sourceId/snapshot` | platform/daemon/src/routes/sources-routes.ts |
| POST | `/api/sources/:sourceId/snapshot/import` | platform/daemon/src/routes/sources-routes.ts |
| DELETE | `/api/sources/:sourceId` | platform/daemon/src/routes/sources-routes.ts |
| GET | `/api/knowledge/entities` | platform/daemon/src/routes/knowledge-routes.ts |
| POST | `/api/knowledge/entities/:id/pin` | platform/daemon/src/routes/knowledge-routes.ts |
| DELETE | `/api/knowledge/entities/:id/pin` | platform/daemon/src/routes/knowledge-routes.ts |
| GET | `/api/knowledge/entities/pinned` | platform/daemon/src/routes/knowledge-routes.ts |
| GET | `/api/knowledge/entities/health` | platform/daemon/src/routes/knowledge-routes.ts |
| GET | `/api/knowledge/entities/:id` | platform/daemon/src/routes/knowledge-routes.ts |
| GET | `/api/knowledge/entities/:id/aspects` | platform/daemon/src/routes/knowledge-routes.ts |
| GET | `/api/knowledge/entities/:id/aspects/:aspectId/attributes` | platform/daemon/src/routes/knowledge-routes.ts |
| GET | `/api/knowledge/entities/:id/dependencies` | platform/daemon/src/routes/knowledge-routes.ts |
| GET | `/api/knowledge/stats` | platform/daemon/src/routes/knowledge-routes.ts |
| GET | `/api/knowledge/communities` | platform/daemon/src/routes/knowledge-routes.ts |
| GET | `/api/knowledge/traversal/status` | platform/daemon/src/routes/knowledge-routes.ts |
| GET | `/api/knowledge/constellation` | platform/daemon/src/routes/knowledge-routes.ts |
| POST | `/api/knowledge/expand` | platform/daemon/src/routes/knowledge-routes.ts |
| POST | `/api/knowledge/expand/session` | platform/daemon/src/routes/knowledge-routes.ts |
| POST | `/api/graph/impact` | platform/daemon/src/routes/knowledge-routes.ts |
| GET | `/api/ontology/claims/versions` | platform/daemon/src/routes/ontology-routes.ts |
| GET | `/api/ontology/claims/explain` | platform/daemon/src/routes/ontology-routes.ts |
| GET | `/api/ontology/claims/version` | platform/daemon/src/routes/ontology-routes.ts |
| POST | `/api/ontology/operations/apply` | platform/daemon/src/routes/ontology-routes.ts |
| POST | `/api/ontology/operations/batch` | platform/daemon/src/routes/ontology-routes.ts |
| POST | `/api/ontology/proposals/repair/merge-plan` | platform/daemon/src/routes/ontology-routes.ts |
| GET | `/api/marketplace/reviews` | platform/daemon/src/routes/marketplace-reviews.ts |
| POST | `/api/marketplace/reviews` | platform/daemon/src/routes/marketplace-reviews.ts |
| PATCH | `/api/marketplace/reviews/config` | platform/daemon/src/routes/marketplace-reviews.ts |
| PATCH | `/api/marketplace/reviews/:id` | platform/daemon/src/routes/marketplace-reviews.ts |
| DELETE | `/api/marketplace/reviews/:id` | platform/daemon/src/routes/marketplace-reviews.ts |
| GET | `/api/marketplace/reviews/config` | platform/daemon/src/routes/marketplace-reviews.ts |
| POST | `/api/marketplace/reviews/sync` | platform/daemon/src/routes/marketplace-reviews.ts |
| GET | `/api/memories/most-used` | platform/daemon/src/routes/memory-routes.ts |
| GET | `/api/memory/timeline` | platform/daemon/src/routes/memory-routes.ts |
| GET | `/api/memory/review-queue` | platform/daemon/src/routes/memory-routes.ts |
| GET | `/api/memory/jobs/:id` | platform/daemon/src/routes/memory-routes.ts |
| POST | `/api/memory/feedback` | platform/daemon/src/routes/memory-routes.ts |
| GET | `/api/home/greeting` | platform/daemon/src/routes/pipeline-routes.ts |
| GET | `/api/reflections/today` | platform/daemon/src/routes/reflection-routes.ts |
| GET | `/api/reflections` | platform/daemon/src/routes/reflection-routes.ts |
| POST | `/api/reflections/generate` | platform/daemon/src/routes/reflection-routes.ts |
| POST | `/api/reflections/:id/answer` | platform/daemon/src/routes/reflection-routes.ts |
| GET | `/api/diagnostics/database/schema` | platform/daemon/src/routes/database-diagnostics.ts |
| GET | `/api/diagnostics/database/tables/:table/sample` | platform/daemon/src/routes/database-diagnostics.ts |
| POST | `/api/diagnostics/openclaw/heartbeat` | platform/daemon/src/routes/pipeline-routes.ts |
| GET | `/api/diagnostics/openclaw` | platform/daemon/src/routes/pipeline-routes.ts |
| GET | `/api/diagnostics/transcripts` | platform/daemon/src/routes/pipeline-routes.ts |
| GET | `/api/diagnostics/memory-content-safety` | platform/daemon/src/routes/pipeline-routes.ts |
| GET | `/api/diagnostics/workloads` | platform/daemon/src/routes/pipeline-routes.ts |
| GET | `/api/pipeline/models` | platform/daemon/src/routes/pipeline-routes.ts |
| GET | `/api/pipeline/models/by-provider` | platform/daemon/src/routes/pipeline-routes.ts |
| POST | `/api/pipeline/models/refresh` | platform/daemon/src/routes/pipeline-routes.ts |
| POST | `/api/repair/resync-vec` | platform/daemon/src/routes/repair-routes.ts |
| POST | `/api/repair/backfill-skipped` | platform/daemon/src/routes/repair-routes.ts (retired; returns HTTP 410; direct completed transcripts are consumed by Dreaming) |
| POST | `/api/repair/prune-chunk-groups` | platform/daemon/src/routes/repair-routes.ts |
| POST | `/api/repair/prune-singleton-entities` | platform/daemon/src/routes/repair-routes.ts |
| POST | `/api/repair/prune-generic-entities` | platform/daemon/src/routes/repair-routes.ts |
| GET | `/api/repair/cold-stats` | platform/daemon/src/routes/repair-routes.ts |
| POST | `/api/repair/cluster-entities` | platform/daemon/src/routes/repair-routes.ts |
| POST | `/api/repair/relink-entities` | platform/daemon/src/routes/repair-routes.ts |
| POST | `/api/repair/backfill-hints` | platform/daemon/src/routes/repair-routes.ts |
| GET | `/api/repair/dead-memories` | platform/daemon/src/routes/repair-routes.ts |
| POST | `/api/repair/dead-memories/forget` | platform/daemon/src/routes/repair-routes.ts |
| GET | `/api/troubleshoot/commands` | platform/daemon/src/routes/repair-routes.ts |
| POST | `/api/troubleshoot/exec` | platform/daemon/src/routes/repair-routes.ts |
| POST | `/api/sessions/:key/renew` | platform/daemon/src/routes/session-routes.ts |
| GET | `/api/skills/browse` | platform/daemon/src/routes/skills.ts |
| GET | `/api/telemetry/memory-search` | platform/daemon/src/routes/telemetry-routes.ts |
| GET | `/api/telemetry/health` | platform/daemon/src/routes/telemetry-routes.ts |
| GET | `/api/telemetry/memory-search/export` | platform/daemon/src/routes/telemetry-routes.ts |

## Dashboard

### GET /

Serves the React/Vite dashboard as a generic single-page application. Static
assets are served from the built dashboard directory or, when available, the
packaged embedded dashboard assets. The dashboard handler passes `/api/*`,
`/health`, and `/sse` through; remaining paths without a file extension fall
back to `index.html` for client-side routing.

If the dashboard build is not found, a minimal HTML fallback page is served
with links to key API endpoints.

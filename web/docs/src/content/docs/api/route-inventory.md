---
title: "Route inventory"
description: "Indexed daemon HTTP routes for clients and operators."
---

Indexed view of routes mounted by the daemon in `platform/daemon/src/daemon.ts`. The inventory records the literal registrations and route expansions covered by the documented extraction; it is not a guarantee that factory- or runtime-composed routes are exhaustive. It excludes test-only registrations and dashboard/static fallbacks. Authentication is applied by the daemon's global middleware unless a row names a route-specific guard. `:param` segments are parameterized action families: callers substitute the segment value as documented by the owning handler.

[Back to HTTP API overview](/api/).

## Route Inventory

| Method | Path | Owning family | Auth / permission | Classification |
|--------|------|---------------|-------------------|----------------|
| GET | `/api/agents` | runtime/configuration | global auth middleware; route-specific guard where applicable | canonical |
| POST | `/api/agents` | runtime/configuration | global auth middleware; route-specific guard where applicable | canonical |
| DELETE | `/api/agents/:name` | runtime/configuration | global auth middleware; route-specific guard where applicable | canonical |
| GET | `/api/agents/:name` | runtime/configuration | global auth middleware; route-specific guard where applicable | canonical |
| PATCH | `/api/agents/:name` | runtime/configuration | global auth middleware; route-specific guard where applicable | canonical |
| GET | `/api/analytics/continuity` | telemetry routes | global auth middleware; route-specific guard where applicable | canonical |
| GET | `/api/analytics/continuity/latest` | telemetry routes | global auth middleware; route-specific guard where applicable | canonical |
| GET | `/api/analytics/errors` | telemetry routes | global auth middleware; route-specific guard where applicable | canonical |
| GET | `/api/analytics/latency` | telemetry routes | global auth middleware; route-specific guard where applicable | canonical |
| GET | `/api/analytics/logs` | telemetry routes | global auth middleware; route-specific guard where applicable | canonical |
| GET | `/api/analytics/memory-safety` | telemetry routes | global auth middleware; route-specific guard where applicable | canonical |
| GET | `/api/analytics/usage` | telemetry routes | global auth middleware; route-specific guard where applicable | canonical |
| GET | `/api/auth/api-keys` | auth routes | global auth middleware; route-specific guard where applicable | canonical |
| POST | `/api/auth/api-keys` | auth routes | global auth middleware; route-specific guard where applicable | canonical |
| DELETE | `/api/auth/api-keys/:id` | auth routes | global auth middleware; route-specific guard where applicable | canonical |
| POST | `/api/auth/login` | auth routes | global auth middleware; route-specific guard where applicable | canonical |
| GET | `/api/auth/methods` | auth routes | global auth middleware; route-specific guard where applicable | canonical |
| POST | `/api/auth/saml/acs` | auth routes | global auth middleware; route-specific guard where applicable | canonical |
| GET | `/api/auth/saml/start` | auth routes | global auth middleware; route-specific guard where applicable | canonical |
| GET | `/api/auth/sso/callback` | auth routes | global auth middleware; route-specific guard where applicable | canonical |
| GET | `/api/auth/sso/start` | auth routes | global auth middleware; route-specific guard where applicable | canonical |
| POST | `/api/auth/token` | auth routes | global auth middleware; route-specific guard where applicable | canonical |
| GET | `/api/auth/whoami` | auth routes | global auth middleware; route-specific guard where applicable | canonical |
| GET | `/api/changelog` | changelog | global auth middleware; route-specific guard where applicable | canonical |
| GET | `/api/checkpoints` | telemetry routes | global auth middleware; route-specific guard where applicable | canonical |
| GET | `/api/checkpoints/:sessionKey` | telemetry routes | global auth middleware; route-specific guard where applicable | canonical |
| GET | `/api/config` | runtime/configuration | global auth middleware; route-specific guard where applicable | canonical |
| POST | `/api/config` | runtime/configuration | global auth middleware; route-specific guard where applicable | canonical |
| GET | `/api/connectors` | connectors routes | global auth middleware; route-specific guard where applicable | canonical |
| POST | `/api/connectors` | connectors routes | global auth middleware; route-specific guard where applicable | canonical |
| DELETE | `/api/connectors/:id` | connectors routes | global auth middleware; route-specific guard where applicable | canonical |
| GET | `/api/connectors/:id` | connectors routes | global auth middleware; route-specific guard where applicable | canonical |
| GET | `/api/connectors/:id/health` | connectors routes | global auth middleware; route-specific guard where applicable | canonical |
| POST | `/api/connectors/:id/sync` | connectors routes | global auth middleware; route-specific guard where applicable | canonical |
| POST | `/api/connectors/:id/sync/full` | connectors routes | global auth middleware; route-specific guard where applicable | canonical |
| POST | `/api/connectors/resync` | connectors routes | global auth middleware; route-specific guard where applicable | canonical |
| GET | `/api/cross-agent/messages` | hooks routes | global auth middleware; route-specific guard where applicable | canonical |
| POST | `/api/cross-agent/messages` | hooks routes | global auth middleware; route-specific guard where applicable | canonical |
| POST | `/api/cross-agent/messages/:messageId/ack` | hooks routes | global auth middleware; route-specific guard where applicable | canonical |
| POST | `/api/cross-agent/messages/:messageId/retry` | hooks routes | global auth middleware; route-specific guard where applicable | canonical |
| GET | `/api/cross-agent/presence` | hooks routes | global auth middleware; route-specific guard where applicable | canonical |
| POST | `/api/cross-agent/presence` | hooks routes | global auth middleware; route-specific guard where applicable | canonical |
| DELETE | `/api/cross-agent/presence/:sessionKey` | hooks routes | global auth middleware; route-specific guard where applicable | canonical |
| GET | `/api/cross-agent/stream` | hooks routes | global auth middleware; route-specific guard where applicable | canonical |
| GET | `/api/diagnostics` | pipeline routes | operator/admin (handler guard) | canonical |
| GET | `/api/diagnostics/:domain` | pipeline routes | operator/admin (handler guard) | canonical |
| GET | `/api/diagnostics/database/schema` | database diagnostics | operator/admin (handler guard) | canonical |
| GET | `/api/diagnostics/database/tables/:table/sample` | database diagnostics | operator/admin (handler guard) | canonical |
| GET | `/api/diagnostics/memory-content-safety` | pipeline routes | operator/admin (handler guard) | canonical |
| GET | `/api/diagnostics/openclaw` | pipeline routes | operator/admin (handler guard) | canonical |
| POST | `/api/diagnostics/openclaw/heartbeat` | pipeline routes | operator/admin (handler guard) | canonical |
| GET | `/api/diagnostics/queue` | queue diagnostics | admin | canonical |
| POST | `/api/diagnostics/queue/repair` | queue diagnostics | admin | canonical |
| GET | `/api/diagnostics/transcripts` | pipeline routes | operator/admin (handler guard) | canonical |
| GET | `/api/diagnostics/workloads` | pipeline routes | operator/admin (handler guard) | canonical |
| GET | `/api/documents` | memory routes | global auth middleware; route-specific guard where applicable | canonical |
| POST | `/api/documents` | memory routes | global auth middleware; route-specific guard where applicable | canonical |
| DELETE | `/api/documents/:id` | memory routes | global auth middleware; route-specific guard where applicable | canonical |
| GET | `/api/documents/:id` | memory routes | global auth middleware; route-specific guard where applicable | canonical |
| GET | `/api/documents/:id/chunks` | memory routes | global auth middleware; route-specific guard where applicable | canonical |
| POST | `/api/dream/exclusions/requeue` | pipeline routes | admin | canonical |
| POST | `/api/dream/operations` | pipeline routes | modify | canonical |
| GET | `/api/dream/passes/:passId/events` | pipeline routes | admin | canonical |
| GET | `/api/dream/passes/:passId/tools` | pipeline routes | admin | canonical |
| GET | `/api/dream/passes/active` | pipeline routes | admin | canonical |
| GET | `/api/dream/quality` | pipeline routes | admin | canonical |
| GET | `/api/dream/status` | pipeline routes | admin | canonical |
| GET | `/api/dream/tools` | pipeline routes | modify | canonical |
| POST | `/api/dream/tools/:capability` | pipeline routes | modify | canonical |
| POST | `/api/dream/trigger` | pipeline routes | admin | canonical |
| GET | `/api/embeddings` | memory routes | global auth middleware; route-specific guard where applicable | canonical |
| GET | `/api/embeddings/health` | memory routes | global auth middleware; route-specific guard where applicable | canonical |
| GET | `/api/embeddings/projection` | memory routes | global auth middleware; route-specific guard where applicable | canonical |
| GET | `/api/embeddings/status` | memory routes | global auth middleware; route-specific guard where applicable | canonical |
| GET | `/api/features` | health/capabilities | global auth middleware; route-specific guard where applicable | canonical |
| GET | `/api/git/config` | session routes | global auth middleware; route-specific guard where applicable | canonical |
| POST | `/api/git/config` | session routes | global auth middleware; route-specific guard where applicable | canonical |
| POST | `/api/git/pull` | session routes | global auth middleware; route-specific guard where applicable | canonical |
| POST | `/api/git/push` | session routes | global auth middleware; route-specific guard where applicable | canonical |
| GET | `/api/git/status` | session routes | global auth middleware; route-specific guard where applicable | canonical |
| POST | `/api/git/sync` | session routes | global auth middleware; route-specific guard where applicable | canonical |
| POST | `/api/graph/impact` | knowledge routes | global auth middleware; route-specific guard where applicable | canonical |
| POST | `/api/graphiq/index` | graphiq routes | global auth middleware; route-specific guard where applicable | canonical |
| POST | `/api/graphiq/install` | graphiq routes | global auth middleware; route-specific guard where applicable | canonical |
| GET | `/api/graphiq/status` | graphiq routes | global auth middleware; route-specific guard where applicable | canonical |
| POST | `/api/graphiq/uninstall` | graphiq routes | global auth middleware; route-specific guard where applicable | canonical |
| POST | `/api/graphiq/update` | graphiq routes | global auth middleware; route-specific guard where applicable | canonical |
| GET | `/api/harnesses` | connectors routes | global auth middleware; route-specific guard where applicable | canonical |
| POST | `/api/harnesses/:id/connect` | harness install | global auth middleware; route-specific guard where applicable | canonical |
| POST | `/api/harnesses/:id/repair` | harness install | admin; returns `200` with success JSON, `400` for unsupported agents or recovery, `409` when another action is running, `503` when unavailable, or `500` on failure | canonical |
| GET | `/api/harnesses/:id/health` | connectors routes | global auth middleware; route-specific guard where applicable | canonical |
| POST | `/api/harnesses/:id/reinitialize` | harness install | admin; requires `{ "confirm": true }`; returns `200` with success JSON, `400` for unsupported agents/recovery or missing confirmation, `409` when another action is running, `503` when unavailable, or `500` on failure | canonical |
| POST | `/api/harnesses/regenerate` | connectors routes | global auth middleware; route-specific guard where applicable | canonical |
| GET | `/api/home/greeting` | pipeline routes | global auth middleware; route-specific guard where applicable | canonical |
| POST | `/api/hook/remember` | memory routes | global auth middleware; route-specific guard where applicable | compatibility alias |
| POST | `/api/hooks/compaction-complete` | hooks routes | internal integration | canonical |
| POST | `/api/hooks/notifications` | hooks routes | `recall` permission | canonical |
| POST | `/api/hooks/pre-compaction` | hooks routes | `remember` permission when a transcript is supplied; see [canonical sessions and hooks reference](./sessions-hooks/) for detailed permission behavior | canonical |
| POST | `/api/hooks/recall` | hooks routes | Permissioned recall; aggregate save additionally requires `remember`; see [canonical sessions and hooks reference](./sessions-hooks/) | canonical |
| POST | `/api/hooks/remember` | hooks routes | Permissioned memory write; see [canonical sessions and hooks reference](./sessions-hooks/) | canonical |
| POST | `/api/hooks/session-checkpoint-extract` | hooks routes | `remember` permission | canonical |
| POST | `/api/hooks/session-end` | hooks routes | `remember` permission when a transcript is supplied; see [canonical sessions and hooks reference](./sessions-hooks/) | canonical |
| POST | `/api/hooks/session-start` | hooks routes | Session context hook; detailed permission behavior is in the [canonical sessions and hooks reference](./sessions-hooks/) | canonical |
| POST | `/api/hooks/skill-invocation` | hooks routes | `remember` permission | canonical |
| POST | `/api/hooks/synthesis` | hooks routes | Agent-scoped compatibility boundary; see [canonical sessions and hooks reference](./sessions-hooks/) | canonical |
| POST | `/api/hooks/synthesis/complete` | hooks routes | Retired endpoint returns structured `410` JSON; use `/api/synthesis/trigger` | retired / 410 |
| GET | `/api/hooks/synthesis/config` | hooks routes | Legacy synthesis configuration; see [canonical sessions and hooks reference](./sessions-hooks/) | canonical |
| GET | `/api/hooks/transcript-capture/:jobId` | hooks routes | Requires `remember` permission; returns `404` when the capture job is not found | canonical |
| POST | `/api/hooks/user-prompt-submit` | hooks routes | Bounded concurrency; returns `503` when the prompt-admission limit is saturated | canonical |
| GET | `/api/identity` | runtime/configuration | global auth middleware; route-specific guard where applicable | canonical |
| GET | `/api/inference/catalog` | inference | global auth middleware; route-specific guard where applicable | canonical |
| POST | `/api/inference/execute` | inference | global auth middleware; route-specific guard where applicable | canonical |
| POST | `/api/inference/explain` | inference | global auth middleware; route-specific guard where applicable | canonical |
| GET | `/api/inference/history` | inference | global auth middleware; route-specific guard where applicable | canonical |
| POST | `/api/inference/oauth/complete` | inference | global auth middleware; route-specific guard where applicable | canonical |
| POST | `/api/inference/oauth/disconnect/:id` | inference | global auth middleware; route-specific guard where applicable | canonical |
| POST | `/api/inference/oauth/login/:id` | inference | global auth middleware; route-specific guard where applicable | canonical |
| GET | `/api/inference/oauth/providers` | inference | global auth middleware; route-specific guard where applicable | canonical |
| DELETE | `/api/inference/requests/:id` | inference | global auth middleware; route-specific guard where applicable | canonical |
| GET | `/api/inference/status` | inference | global auth middleware; route-specific guard where applicable | canonical |
| POST | `/api/inference/stream` | inference | global auth middleware; route-specific guard where applicable | canonical |
| GET | `/api/knowledge/communities` | knowledge routes | global auth middleware; route-specific guard where applicable | canonical |
| GET | `/api/knowledge/constellation` | knowledge routes | global auth middleware; route-specific guard where applicable | canonical |
| GET | `/api/knowledge/entities` | knowledge routes | global auth middleware; route-specific guard where applicable | canonical |
| GET | `/api/knowledge/entities/:id` | knowledge routes | global auth middleware; route-specific guard where applicable | canonical |
| GET | `/api/knowledge/entities/:id/aspects` | knowledge routes | global auth middleware; route-specific guard where applicable | canonical |
| GET | `/api/knowledge/entities/:id/aspects/:aspectId/attributes` | knowledge routes | global auth middleware; route-specific guard where applicable | canonical |
| GET | `/api/knowledge/entities/:id/dependencies` | knowledge routes | global auth middleware; route-specific guard where applicable | canonical |
| DELETE | `/api/knowledge/entities/:id/pin` | knowledge routes | global auth middleware; route-specific guard where applicable | canonical |
| POST | `/api/knowledge/entities/:id/pin` | knowledge routes | global auth middleware; route-specific guard where applicable | canonical |
| GET | `/api/knowledge/entities/health` | knowledge routes | global auth middleware; route-specific guard where applicable | canonical |
| GET | `/api/knowledge/entities/pinned` | knowledge routes | global auth middleware; route-specific guard where applicable | canonical |
| POST | `/api/knowledge/expand` | knowledge routes | global auth middleware; route-specific guard where applicable | canonical |
| POST | `/api/knowledge/expand/session` | knowledge routes | global auth middleware; route-specific guard where applicable | canonical |
| GET | `/api/knowledge/hygiene` | knowledge routes | global auth middleware; route-specific guard where applicable | canonical |
| GET | `/api/knowledge/navigation/aspects` | knowledge routes | global auth middleware; route-specific guard where applicable | canonical |
| GET | `/api/knowledge/navigation/attributes` | knowledge routes | global auth middleware; route-specific guard where applicable | canonical |
| GET | `/api/knowledge/navigation/claims` | knowledge routes | global auth middleware; route-specific guard where applicable | canonical |
| GET | `/api/knowledge/navigation/entities` | knowledge routes | global auth middleware; route-specific guard where applicable | canonical |
| GET | `/api/knowledge/navigation/entity` | knowledge routes | global auth middleware; route-specific guard where applicable | canonical |
| GET | `/api/knowledge/navigation/groups` | knowledge routes | global auth middleware; route-specific guard where applicable | canonical |
| GET | `/api/knowledge/navigation/tree` | knowledge routes | global auth middleware; route-specific guard where applicable | canonical |
| GET | `/api/knowledge/stats` | knowledge routes | global auth middleware; route-specific guard where applicable | canonical |
| GET | `/api/knowledge/traversal/status` | knowledge routes | global auth middleware; route-specific guard where applicable | canonical |
| GET | `/api/logs` | runtime/configuration | global auth middleware; route-specific guard where applicable | canonical |
| GET | `/api/logs/stream` | runtime/configuration | global auth middleware; route-specific guard where applicable | canonical |
| GET | `/api/marketplace/reviews` | marketplace reviews | global auth middleware; route-specific guard where applicable | canonical |
| POST | `/api/marketplace/reviews` | marketplace reviews | global auth middleware; route-specific guard where applicable | canonical |
| DELETE | `/api/marketplace/reviews/:id` | marketplace reviews | global auth middleware; route-specific guard where applicable | canonical |
| PATCH | `/api/marketplace/reviews/:id` | marketplace reviews | global auth middleware; route-specific guard where applicable | canonical |
| GET | `/api/marketplace/reviews/config` | marketplace reviews | global auth middleware; route-specific guard where applicable | canonical |
| PATCH | `/api/marketplace/reviews/config` | marketplace reviews | global auth middleware; route-specific guard where applicable | canonical |
| POST | `/api/marketplace/reviews/sync` | marketplace reviews | global auth middleware; route-specific guard where applicable | canonical |
| GET | `/api/mcp/analytics` | mcp analytics | global auth middleware; route-specific guard where applicable | canonical |
| GET | `/api/mcp/analytics/:server` | mcp analytics | global auth middleware; route-specific guard where applicable | canonical |
| GET | `/api/memories` | memory routes | global auth middleware; route-specific guard where applicable | canonical |
| POST | `/api/memories/:id/supersede` | memory routes | global auth middleware; route-specific guard where applicable | canonical |
| POST | `/api/memories/:id/tombstone` | memory routes | global auth middleware; route-specific guard where applicable | canonical |
| GET | `/api/memories/curator-slices` | memory routes | global auth middleware; route-specific guard where applicable | canonical |
| GET | `/api/memories/most-used` | memory routes | global auth middleware; route-specific guard where applicable | canonical |
| DELETE | `/api/memory/:id` | memory routes | global auth middleware; route-specific guard where applicable | canonical |
| GET | `/api/memory/:id` | memory routes | global auth middleware; route-specific guard where applicable | canonical |
| PATCH | `/api/memory/:id` | memory routes | global auth middleware; route-specific guard where applicable | canonical |
| GET | `/api/memory/:id/history` | memory routes | global auth middleware; route-specific guard where applicable | canonical |
| GET | `/api/memory/:id/lineage` | memory routes | global auth middleware; route-specific guard where applicable | canonical |
| POST | `/api/memory/:id/recover` | memory routes | global auth middleware; route-specific guard where applicable | canonical |
| POST | `/api/memory/codex-native-note` | memory routes | global auth middleware; route-specific guard where applicable | canonical |
| POST | `/api/memory/feedback` | memory routes | global auth middleware; route-specific guard where applicable | canonical |
| POST | `/api/memory/forget` | memory routes | global auth middleware; route-specific guard where applicable | canonical |
| GET | `/api/memory/jobs/:id` | memory routes | global auth middleware; route-specific guard where applicable | canonical |
| POST | `/api/memory/modify` | memory routes | global auth middleware; route-specific guard where applicable | canonical |
| POST | `/api/memory/recall` | memory routes | global auth middleware; route-specific guard where applicable | canonical |
| POST | `/api/memory/remember` | memory routes | global auth middleware; route-specific guard where applicable | canonical |
| GET | `/api/memory/review-queue` | memory routes | global auth middleware; route-specific guard where applicable | canonical |
| POST | `/api/memory/save` | memory routes | global auth middleware; route-specific guard where applicable | canonical |
| GET | `/api/memory/search` | memory routes | global auth middleware; route-specific guard where applicable | canonical |
| GET | `/api/memory/timeline` | memory routes | global auth middleware; route-specific guard where applicable | canonical |
| GET | `/api/mode` | health/capabilities | global auth middleware; route-specific guard where applicable | canonical |
| GET | `/api/ontology/assertions` | ontology routes | global auth middleware; route-specific guard where applicable | canonical |
| POST | `/api/ontology/assertions` | ontology routes | global auth middleware; route-specific guard where applicable | canonical |
| GET | `/api/ontology/assertions/:id` | ontology routes | global auth middleware; route-specific guard where applicable | canonical |
| POST | `/api/ontology/assertions/:id/archive` | ontology routes | global auth middleware; route-specific guard where applicable | canonical |
| POST | `/api/ontology/assertions/:id/link-claim` | ontology routes | global auth middleware; route-specific guard where applicable | canonical |
| POST | `/api/ontology/assertions/:id/supersede` | ontology routes | global auth middleware; route-specific guard where applicable | canonical |
| GET | `/api/ontology/claims/evidence` | ontology routes | global auth middleware; route-specific guard where applicable | canonical |
| GET | `/api/ontology/claims/explain` | ontology routes | global auth middleware; route-specific guard where applicable | canonical |
| GET | `/api/ontology/claims/version` | ontology routes | global auth middleware; route-specific guard where applicable | canonical |
| GET | `/api/ontology/claims/versions` | ontology routes | global auth middleware; route-specific guard where applicable | canonical |
| POST | `/api/ontology/consolidate` | ontology routes | global auth middleware; route-specific guard where applicable | canonical |
| GET | `/api/ontology/contradictions` | ontology routes | global auth middleware; route-specific guard where applicable | canonical |
| GET | `/api/ontology/contradictions/:id` | ontology routes | global auth middleware; route-specific guard where applicable | canonical |
| GET | `/api/ontology/entities/:id/aliases` | ontology routes | global auth middleware; route-specific guard where applicable | canonical |
| POST | `/api/ontology/entities/:id/aliases` | ontology routes | global auth middleware; route-specific guard where applicable | canonical |
| DELETE | `/api/ontology/entities/:id/aliases/:aliasId` | ontology routes | global auth middleware; route-specific guard where applicable | canonical |
| POST | `/api/ontology/extract` | ontology routes | modify | canonical |
| GET | `/api/ontology/links/:id/evidence` | ontology routes | global auth middleware; route-specific guard where applicable | canonical |
| POST | `/api/ontology/operations/apply` | ontology routes | global auth middleware; route-specific guard where applicable | canonical |
| POST | `/api/ontology/operations/batch` | ontology routes | global auth middleware; route-specific guard where applicable | canonical |
| GET | `/api/ontology/proposals` | ontology routes | global auth middleware; route-specific guard where applicable | canonical |
| POST | `/api/ontology/proposals` | ontology routes | global auth middleware; route-specific guard where applicable | canonical |
| GET | `/api/ontology/proposals/:id` | ontology routes | global auth middleware; route-specific guard where applicable | canonical |
| POST | `/api/ontology/proposals/:id/apply` | ontology routes | global auth middleware; route-specific guard where applicable | canonical |
| GET | `/api/ontology/proposals/:id/evidence` | ontology routes | global auth middleware; route-specific guard where applicable | canonical |
| POST | `/api/ontology/proposals/:id/reject` | ontology routes | global auth middleware; route-specific guard where applicable | canonical |
| POST | `/api/ontology/proposals/batch` | ontology routes | global auth middleware; route-specific guard where applicable | canonical |
| GET | `/api/ontology/proposals/conflicts` | ontology routes | global auth middleware; route-specific guard where applicable | canonical |
| POST | `/api/ontology/proposals/repair/duplicates` | ontology routes | global auth middleware; route-specific guard where applicable | canonical |
| POST | `/api/ontology/proposals/repair/merge-plan` | ontology routes | global auth middleware; route-specific guard where applicable | canonical |
| GET | `/api/os/agent-events` | os agent | global auth middleware; route-specific guard where applicable | canonical |
| POST | `/api/os/agent-execute` | os agent | global auth middleware; route-specific guard where applicable | canonical |
| GET | `/api/os/agent-sessions` | os agent | global auth middleware; route-specific guard where applicable | canonical |
| POST | `/api/os/agent-state` | os agent | global auth middleware; route-specific guard where applicable | canonical |
| POST | `/api/os/chat` | os chat | global auth middleware; route-specific guard where applicable | canonical |
| GET | `/api/os/events` | desktop event bus | internal runtime | internal |
| GET | `/api/os/events/stream` | desktop event bus | internal runtime | internal |
| GET | `/api/os/events/stats` | desktop event bus | internal runtime | internal |
| GET | `/api/os/context` | desktop event bus | internal runtime | internal |
| POST | `/api/os/install` | desktop tray | internal runtime | internal |
| GET | `/api/os/tray` | desktop tray | internal runtime | internal |
| GET | `/api/os/tray/:id` | desktop tray | internal runtime | internal |
| GET | `/api/os/tray/:id/probe` | desktop tray | internal runtime | internal |
| PATCH | `/api/os/tray/:id` | desktop tray | internal runtime | internal |
| POST | `/api/os/tray/:id/reprobe` | desktop tray | internal runtime | internal |
| DELETE | `/api/os/widget/:id` | desktop widgets | internal runtime | internal |
| GET | `/api/os/widget/:id` | desktop widgets | internal runtime | internal |
| POST | `/api/os/widget/generate` | desktop widgets | internal runtime | internal |
| GET | `/api/marketplace/mcp` | marketplace MCP | internal runtime | internal |
| GET | `/api/marketplace/mcp/:id` | marketplace MCP | internal runtime | internal |
| PATCH | `/api/marketplace/mcp/:id` | marketplace MCP | internal runtime | internal |
| DELETE | `/api/marketplace/mcp/:id` | marketplace MCP | internal runtime | internal |
| GET | `/api/marketplace/mcp/browse` | marketplace MCP | internal runtime | internal |
| POST | `/api/marketplace/mcp/call` | marketplace MCP | internal runtime | internal |
| GET | `/api/marketplace/mcp/detail` | marketplace MCP | internal runtime | internal |
| POST | `/api/marketplace/mcp/install` | marketplace MCP | internal runtime | internal |
| GET | `/api/marketplace/mcp/policy` | marketplace MCP | internal runtime | internal |
| PATCH | `/api/marketplace/mcp/policy` | marketplace MCP | internal runtime | internal |
| POST | `/api/marketplace/mcp/read-resource` | marketplace MCP | internal runtime | internal |
| POST | `/api/marketplace/mcp/register` | marketplace MCP | internal runtime | internal |
| GET | `/api/marketplace/mcp/search` | marketplace MCP | internal runtime | internal |
| POST | `/api/marketplace/mcp/test` | marketplace MCP | internal runtime | internal |
| GET | `/api/marketplace/mcp/tools` | marketplace MCP | internal runtime | internal |
| GET | `/api/pipeline/models` | pipeline routes | global auth middleware; route-specific guard where applicable | canonical |
| GET | `/api/pipeline/models/by-provider` | pipeline routes | global auth middleware; route-specific guard where applicable | canonical |
| POST | `/api/pipeline/models/refresh` | pipeline routes | global auth middleware; route-specific guard where applicable | canonical |
| POST | `/api/pipeline/pause` | pipeline routes | global auth middleware; route-specific guard where applicable | canonical |
| POST | `/api/pipeline/resume` | pipeline routes | global auth middleware; route-specific guard where applicable | canonical |
| GET | `/api/pipeline/status` | pipeline routes | global auth middleware; route-specific guard where applicable | canonical |
| GET | `/api/plugins` | plugins routes | global auth middleware; route-specific guard where applicable | canonical |
| GET | `/api/plugins/:id` | plugins routes | global auth middleware; route-specific guard where applicable | canonical |
| PATCH | `/api/plugins/:id` | plugins routes | global auth middleware; route-specific guard where applicable | canonical |
| GET | `/api/plugins/:id/diagnostics` | plugins routes | global auth middleware; route-specific guard where applicable | canonical |
| GET | `/api/plugins/audit` | plugins routes | global auth middleware; route-specific guard where applicable | canonical |
| GET | `/api/plugins/prompt-contributions` | plugins routes | global auth middleware; route-specific guard where applicable | canonical |
| GET | `/api/readme` | changelog | global auth middleware; route-specific guard where applicable | canonical |
| GET | `/api/reflections` | reflection routes | global auth middleware; route-specific guard where applicable | canonical |
| POST | `/api/reflections/:id/answer` | reflection routes | global auth middleware; route-specific guard where applicable | canonical |
| POST | `/api/reflections/generate` | reflection routes | global auth middleware; route-specific guard where applicable | canonical |
| GET | `/api/reflections/today` | reflection routes | global auth middleware; route-specific guard where applicable | canonical |
| POST | `/api/repair/backfill-hints` | repair routes | operator/admin (handler guard) | canonical |
| POST | `/api/repair/backfill-skipped` | repair routes | operator/admin (handler guard) | retired / 410 |
| POST | `/api/repair/check-fts` | repair routes | operator/admin (handler guard) | canonical |
| POST | `/api/repair/clean-orphans` | repair routes | operator/admin (handler guard) | canonical |
| POST | `/api/repair/cluster-entities` | repair routes | operator/admin (handler guard) | canonical |
| GET | `/api/repair/cold-stats` | repair routes | operator/admin (handler guard) | canonical |
| GET | `/api/repair/dead-memories` | repair routes | operator/admin (handler guard) | canonical |
| POST | `/api/repair/dead-memories/forget` | repair routes | operator/admin (handler guard) | canonical |
| GET | `/api/repair/dedup-stats` | repair routes | operator/admin (handler guard) | canonical |
| POST | `/api/repair/deduplicate` | repair routes | operator/admin (handler guard) | canonical |
| GET | `/api/repair/embedding-gaps` | repair routes | operator/admin (handler guard) | canonical |
| GET | `/api/repair/integrity-check` | repair routes | operator/admin (handler guard) | canonical |
| POST | `/api/repair/prune-chunk-groups` | repair routes | operator/admin (handler guard) | canonical |
| POST | `/api/repair/prune-generic-entities` | repair routes | operator/admin (handler guard) | canonical |
| POST | `/api/repair/prune-singleton-entities` | repair routes | operator/admin (handler guard) | canonical |
| POST | `/api/repair/re-embed` | repair routes | operator/admin (handler guard) | canonical |
| POST | `/api/repair/re-embed-migration` | repair routes | operator/admin (handler guard) | canonical |
| POST | `/api/repair/rebuild-indexes` | repair routes | operator/admin (handler guard) | canonical |
| POST | `/api/repair/release-leases` | repair routes | operator/admin (handler guard) | canonical |
| POST | `/api/repair/relink-entities` | repair routes | operator/admin (handler guard) | canonical |
| POST | `/api/repair/requeue-dead` | repair routes | operator/admin (handler guard) | canonical |
| POST | `/api/repair/resync-vec` | repair routes | operator/admin (handler guard) | canonical |
| POST | `/api/repair/retention-sweep` | repair routes | operator/admin (handler guard) | canonical |
| GET | `/api/roadmap` | changelog | global auth middleware; route-specific guard where applicable | canonical |
| GET | `/api/secrets` | secrets routes | global auth middleware; route-specific guard where applicable | canonical |
| DELETE | `/api/secrets/1password/connect` | secrets routes | global auth middleware; route-specific guard where applicable | canonical |
| POST | `/api/secrets/1password/connect` | secrets routes | global auth middleware; route-specific guard where applicable | canonical |
| POST | `/api/secrets/1password/import` | secrets routes | global auth middleware; route-specific guard where applicable | canonical |
| GET | `/api/secrets/1password/status` | secrets routes | global auth middleware; route-specific guard where applicable | canonical |
| GET | `/api/secrets/1password/vaults` | secrets routes | global auth middleware; route-specific guard where applicable | canonical |
| DELETE | `/api/secrets/:name` | secrets routes | global auth middleware; route-specific guard where applicable | canonical |
| POST | `/api/secrets/:name` | secrets routes | global auth middleware; route-specific guard where applicable | canonical |
| POST | `/api/secrets/:name/exec` | secrets routes | global auth middleware; route-specific guard where applicable | canonical |
| DELETE | `/api/secrets/bitwarden/connect` | secrets routes | global auth middleware; route-specific guard where applicable | canonical |
| POST | `/api/secrets/bitwarden/connect` | secrets routes | global auth middleware; route-specific guard where applicable | canonical |
| GET | `/api/secrets/bitwarden/folders` | secrets routes | global auth middleware; route-specific guard where applicable | canonical |
| POST | `/api/secrets/bitwarden/migrate` | secrets routes | global auth middleware; route-specific guard where applicable | canonical |
| POST | `/api/secrets/bitwarden/provider` | secrets routes | global auth middleware; route-specific guard where applicable | canonical |
| GET | `/api/secrets/bitwarden/status` | secrets routes | global auth middleware; route-specific guard where applicable | canonical |
| POST | `/api/secrets/exec` | secrets routes | global auth middleware; route-specific guard where applicable | canonical |
| GET | `/api/secrets/exec/:jobId` | secrets routes | global auth middleware; route-specific guard where applicable | canonical |
| GET | `/api/sessions` | session routes | global auth middleware; route-specific guard where applicable | canonical |
| GET | `/api/sessions/:key{(?!summaries$)[^/]+}` | session routes | global auth middleware; route-specific guard where applicable | canonical |
| GET | `/api/sessions/:key{(?!summaries$)[^/]+}/blackbox` | session routes | `recall` permission | canonical |
| POST | `/api/sessions/:key{(?!summaries$)[^/]+}/bypass` | session routes | global auth middleware; route-specific guard where applicable | canonical |
| POST | `/api/sessions/:key{(?!summaries$)[^/]+}/renew` | session routes | global auth middleware; route-specific guard where applicable | canonical |
| GET | `/api/sessions/:key{(?!summaries$)[^/]+}/transcript` | session routes | `recall` permission | canonical |
| GET | `/api/sessions/blackbox` | session routes | `recall` permission | canonical |
| POST | `/api/sessions/search` | session routes | `recall` permission | canonical |
| GET | `/api/sessions/summaries` | session routes | `recall` permission | canonical |
| POST | `/api/sessions/summaries/expand` | session routes | `recall` permission | canonical |
| GET | `/api/skills` | skills | global auth middleware; route-specific guard where applicable | canonical |
| DELETE | `/api/skills/:name` | skills | global auth middleware; route-specific guard where applicable | canonical |
| GET | `/api/skills/:name` | skills | global auth middleware; route-specific guard where applicable | canonical |
| GET | `/api/skills/analytics` | skill analytics | global auth middleware; route-specific guard where applicable | canonical |
| GET | `/api/skills/browse` | skills | global auth middleware; route-specific guard where applicable | canonical |
| POST | `/api/skills/install` | skills | global auth middleware; route-specific guard where applicable | canonical |
| GET | `/api/skills/search` | skills | global auth middleware; route-specific guard where applicable | canonical |
| GET | `/api/sources` | sources routes | global auth middleware; route-specific guard where applicable | canonical |
| DELETE | `/api/sources/:sourceId` | sources routes | global auth middleware; route-specific guard where applicable | canonical |
| GET | `/api/sources/:sourceId/health` | sources routes | global auth middleware; route-specific guard where applicable | canonical |
| GET | `/api/sources/:sourceId/snapshot` | sources routes | global auth middleware; route-specific guard where applicable | canonical |
| POST | `/api/sources/:sourceId/snapshot/import` | sources routes | global auth middleware; route-specific guard where applicable | canonical |
| POST | `/api/sources/discord` | sources routes | global auth middleware; route-specific guard where applicable | canonical |
| POST | `/api/sources/github` | sources routes | global auth middleware; route-specific guard where applicable | canonical |
| POST | `/api/sources/import` | import routes | global auth middleware; route-specific guard where applicable | canonical |
| GET | `/api/sources/imports` | transcript import routes | global auth middleware; route-specific guard where applicable | canonical |
| POST | `/api/sources/imports` | transcript import routes | global auth middleware; route-specific guard where applicable | canonical |
| GET | `/api/sources/imports/:jobId` | transcript import routes | global auth middleware; route-specific guard where applicable | canonical |
| POST | `/api/sources/imports/:jobId/${control}` | transcript import routes | global auth middleware; route-specific guard where applicable | canonical |
| GET | `/api/sources/imports/:jobId/${suffix}` | transcript import routes | global auth middleware; route-specific guard where applicable | canonical |
| PATCH | `/api/sources/imports/:jobId/files/:fileId` | transcript import routes | global auth middleware; route-specific guard where applicable | canonical |
| PUT | `/api/sources/imports/:jobId/files/:fileId` | transcript import routes | global auth middleware; route-specific guard where applicable | canonical |
| GET | `/api/sources/imports/:jobId/files/:fileId/content` | transcript import routes | global auth middleware; route-specific guard where applicable | canonical |
| POST | `/api/sources/imports/:jobId/files/:fileId/finalize` | transcript import routes | global auth middleware; route-specific guard where applicable | canonical |
| POST | `/api/sources/imports/:jobId/files/:fileId/reset` | transcript import routes | global auth middleware; route-specific guard where applicable | canonical |
| GET | `/api/sources/imports/export/transcripts` | transcript import routes | global auth middleware; route-specific guard where applicable | canonical |
| POST | `/api/sources/obsidian` | sources routes | global auth middleware; route-specific guard where applicable | canonical |
| POST | `/api/sources/pick-directory` | sources routes | global auth middleware; route-specific guard where applicable | canonical |
| POST | `/api/sources/pick-files` | sources routes | global auth middleware; route-specific guard where applicable | canonical |
| POST | `/api/sources/web` | sources routes | global auth middleware; route-specific guard where applicable | canonical |
| GET | `/api/status` | pipeline routes | global auth middleware; route-specific guard where applicable | canonical |
| GET | `/api/synthesis/status` | hooks routes | global auth middleware; route-specific guard where applicable | canonical |
| POST | `/api/synthesis/trigger` | hooks routes | global auth middleware; route-specific guard where applicable | canonical |
| GET | `/api/telemetry/events` | telemetry routes | `analytics` permission | canonical |
| GET | `/api/telemetry/export` | telemetry routes | `analytics` permission | canonical |
| GET | `/api/telemetry/health` | telemetry routes | `analytics` permission | canonical |
| GET | `/api/telemetry/memory-search` | telemetry routes | `analytics` permission | canonical |
| GET | `/api/telemetry/memory-search/export` | telemetry routes | `analytics` permission | canonical |
| GET | `/api/telemetry/stats` | telemetry routes | `analytics` permission | canonical |
| GET | `/api/troubleshoot/commands` | repair routes | operator/admin (handler guard) | canonical |
| POST | `/api/troubleshoot/exec` | repair routes | operator/admin (handler guard) | canonical |
| GET | `/api/update/check` | runtime/configuration | global auth middleware; route-specific guard where applicable | canonical |
| GET | `/api/update/config` | runtime/configuration | global auth middleware; route-specific guard where applicable | canonical |
| POST | `/api/update/config` | runtime/configuration | global auth middleware; route-specific guard where applicable | canonical |
| POST | `/api/update/run` | runtime/configuration | global auth middleware; route-specific guard where applicable | canonical |
| GET | `/health` | health/capabilities | public | canonical |
| GET | `/health/live` | health/capabilities | public | canonical |
| GET | `/health/ready` | health/capabilities | public | canonical |
| ALL | `/mcp` | MCP transport | global auth middleware; route-specific guard where applicable | canonical |
| GET | `/memory/search` | memory routes | global auth middleware; route-specific guard where applicable | compatibility alias |
| GET | `/memory/similar` | memory routes | global auth middleware; route-specific guard where applicable | compatibility alias |
| POST | `/v1/chat/completions` | inference | global auth middleware; route-specific guard where applicable | canonical OpenAI-compatible |
| GET | `/v1/models` | inference | global auth middleware; route-specific guard where applicable | canonical OpenAI-compatible |

## Route coverage

The index covers the mounted client and operator routes represented by the documented extraction, including internal runtime routes used by the desktop tray, event bus, widgets, and marketplace MCP clients. Factory- and runtime-composed routes may require checking their owning implementation. It omits test-only registrations, wildcard/static dashboard fallbacks, and framework wiring. Route details live with the owning reference page; this page provides the extracted method/path index and status classification.

## Parameterized action families

Rows containing colon-prefixed segments are parameterized action families, not literal paths. Regex-constrained segments are preserved exactly where registered so generated clients and drift checks can recognize them.

The harness recovery action family is registered for these concrete paths:

- POST `/api/harnesses/:id/repair`
- POST `/api/harnesses/:id/reinitialize`

Both paths require the admin permission and accept a harness identifier in `:id`.

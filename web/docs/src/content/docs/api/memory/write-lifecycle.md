---
title: "Memory write lifecycle"
description: "Create, inspect, revise, supersede, recover, and delete memories."
---

[Back to the memory API index](/api/memory/).

Writes are scoped to the resolved agent and subject to the `mutationsFrozen`
kill switch. Permission names below are enforced by the daemon.

### GET /api/memories

Requires `recall`. Lists paginated memories and stats. Query: `limit` and
offset. Deleted and out-of-scope rows are excluded. Items may include
`contentSafety`.

### POST /api/memory/remember

Requires `remember`. Creates immutable episodic evidence. `content` is required.
Optional fields include `who`, `project`, `type`, `tags`, `importance`, `pinned`,
`sourceType`, `sourceId`, `sourcePath`, `runtimePath`, `idempotencyKey`, temporal
fields, `structured`, `agentId`, `visibility`, `scope`, and `supersedes`.

`agentId`, `visibility`, and `scope` are never widened implicitly. A
cross-scope or missing `supersedes` target fails the write. When accepted,
the target is marked superseded atomically and the response identifies the new
memory, dedupe state, embedding state, and `structured_applied: false`.
Structured input is retained as evidence; Dreaming is the semantic writer.

### POST /api/memory/save

Alias of `POST /api/memory/remember`; same body, authorization, and response.

### POST /api/memory/codex-native-note

Requires `remember`. Writes a Codex-native note. Body requires `content` and
accepts optional `title` and `tags`; respects `mutationsFrozen`.

### GET /api/memory/:id

Requires `recall`. Returns the memory row, including provenance, lifecycle,
version, extraction, embedding, and content-safety fields. Deleted rows require
an explicit include-deleted request. Scope failures are returned as `404`.

### GET /api/memory/:id/history

Requires `recall`. Returns `{ memoryId, count, history }` in chronological order.
`limit` is bounded by the handler.

### GET /api/memory/:id/lineage

Requires `recall`. Returns `{ memoryId, count, lineage }`, walking supersession
links from any row to the head.

### PATCH /api/memory/:id

Requires `modify`. Body requires `reason` and may change `content`, `type`,
`tags`, `importance`, and `pinned`, with optional `if_version` and
`changed_by`. Episodic evidence content and type are immutable; create a new
memory and optionally supersede the old one. Response reports status, versions,
and whether content was embedded.

### DELETE /api/memory/:id

Requires `forget`. Body or query requires `reason`; accepts `force` and
`if_version`. Soft-deletes the row and records audit history. Pinned memories
require force, and autonomous actors cannot force-delete them. Response reports
`id`, `status`, `currentVersion`, and `newVersion`.

### POST /api/memories/:id/tombstone

Requires `forget`. Tombstones a memory. The body may include `reason` and
`changed_by`; `reason` may also be supplied as a query parameter and defaults to
`curator tombstone`. The response includes `id`, `status: "tombstoned"`,
versions, and `idempotent`; repeating an already-deleted request is idempotent.

### POST /api/memories/:id/supersede

Requires `modify`. Body requires `superseded_by`; `reason` and `changed_by` are
optional. The target must exist and share the memory's scope; self-supersession
is rejected. The response includes `id`, `status: "superseded"`,
`superseded_by`, versions, and `idempotent`.

### GET /api/memories/curator-slices

Requires `recall`. Query supports `agentId`, `minSessions` (default `3`, bounded
1–100), and `limit` (default `100`, bounded 1–500). Returns the resolved
`agentId` and the `injectedNeverUsed`, `contradicted`, and `highUsed` slices.

### POST /api/memory/:id/recover

Requires `recover`. Body requires `reason`; optional `if_version` provides an
optimistic concurrency check. Restores a soft-deleted memory within the
configured retention window and reports status and versions.

### GET /api/memory/jobs/:id

Returns the status of an asynchronous memory job, including its job identifier,
state, and terminal/error fields when present.

### POST /api/memory/feedback
### POST /api/memory/forget
### POST /api/memory/modify

Compatibility operation routes. They require the corresponding mutation
permission, resolve agent and scope before acting, and return structured
operation status. Prefer the lifecycle routes above for new integrations.

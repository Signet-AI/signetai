---
title: "HTTP API"
description: "Signet daemon HTTP API reference."
order: 10
section: "Reference"
---

Signet Daemon HTTP API
======================

The Signet [[daemon]] exposes a REST API on `http://localhost:3850` by default.
All requests and responses use JSON unless otherwise noted. The base URL and
port are configurable via environment variables (see [[configuration]]).

> Path note: `$SIGNET_WORKSPACE` means your active Signet workspace path.
> Default is `~/.agents`, configurable via `signet workspace set <path>`.

```
Base URL: http://localhost:3850
SIGNET_PORT  — override port (default: 3850)
SIGNET_HOST  — daemon host for local calls (default: 127.0.0.1)
SIGNET_BIND  — bind host override (default: SIGNET_HOST)
```

Authentication
--------------

The daemon supports three [[auth]] modes, set in `agent.yaml`:

- `local` — no authentication required. All requests are trusted. This is
  the default for single-user local installs.
- `team` — all requests require a `Bearer` token in the `Authorization`
  header.
- `hybrid` — requests from `localhost` are trusted without a token; requests
  from any other origin require a `Bearer` token.

Tokens are signed JWTs with a role and optional scope. Roles and their
permissions:

| Role       | Permissions                                                          |
|------------|----------------------------------------------------------------------|
| `admin`    | all permissions                                                      |
| `operator` | remember, recall, modify, forget, recover, documents, connectors, diagnostics, analytics |
| `agent`    | remember, recall, modify, forget, recover, documents                 |
| `readonly` | recall only                                                          |

Token scopes (`project`, `agent`, `user`) restrict mutations to records
matching the scope. Admin role bypasses scope checks. Unscoped tokens have
full access within their role.

Rate limits apply in `team` and `hybrid` modes:

| Operation      | Limit       |
|----------------|-------------|
| forget         | 30 / min    |
| modify         | 60 / min    |
| batchForget    | 5 / min     |
| admin actions  | 10 / min    |
| inferenceExplain | 120 / min |
| inferenceExecute | 20 / min  |
| inferenceGateway | 30 / min  |
| recallLlm      | 60 / min    |

Errors follow a consistent shape:

```json
{ "error": "human-readable message" }
```

Rate-limit rejections return `429`. Auth failures return `401`. Permission
violations return `403`. Version conflicts and state violations return `409`.
Mutations blocked by the kill switch return `503`.


Health & Status
---------------

### GET /health

No authentication required. Lightweight liveness check.

**Response**

```json
{
  "status": "healthy",
  "uptime": 3600.5,
  "pid": 12345,
  "version": "0.1.69",
  "port": 3850,
  "agentsDir": "/home/user/.agents"
}
```

### GET /api/status

Full daemon status including pipeline config, embedding provider, and a
composite health score derived from diagnostics. Extraction provider
runtime resolution persists startup degradation so operators can detect
silent fallback or hard-blocked extraction after boot.

**Response**

```json
{
  "status": "running",
  "version": "0.1.69",
  "pid": 12345,
  "uptime": 3600.5,
  "startedAt": "2026-02-21T10:00:00.000Z",
  "port": 3850,
  "host": "localhost",
  "agentsDir": "/home/user/.agents",
  "memoryDb": true,
  "pipelineV2": {
    "enabled": true,
    "paused": false,
    "shadowMode": false,
    "mutationsFrozen": false,
    "graphEnabled": false,
    "autonomousEnabled": false,
    "extractionModel": "qwen3:4b"
  },
  "pipeline": {
    "extraction": {
      "running": true,
      "overloaded": false,
      "loadPerCpu": 0.42,
      "maxLoadPerCpu": 0.8,
      "overloadBackoffMs": 30000,
      "overloadSince": null,
      "nextTickInMs": 1200
    }
  },
  "providerResolution": {
    "extraction": {
      "configured": "claude-code",
      "resolved": "claude-code",
      "effective": "ollama",
      "fallbackProvider": "ollama",
      "status": "degraded",
      "degraded": true,
      "fallbackApplied": true,
      "reason": "Claude Code CLI not found during extraction startup preflight",
      "since": "2026-03-26T06:00:00.000Z"
    }
  },
  "inference": {
    "enabled": true,
    "source": "explicit",
    "defaultPolicy": "auto",
    "defaultAgentId": "default",
    "targetCount": 4,
    "policyCount": 2,
    "explicit": true
  },
  "health": { "score": 0.97, "status": "healthy" },
  "embedding": {
    "provider": "ollama",
    "model": "nomic-embed-text",
    "available": true
  },
  "bypassedSessions": 1
}
```

The `bypassedSessions` field reports how many active sessions currently have
bypass enabled (see [[#Sessions]]).
Monitor `providerResolution.extraction.status` for `degraded` or `blocked`
states when the configured extraction provider is unavailable at startup.
When `pipeline.extraction.overloaded` is `true`, the extraction worker is
intentionally backing off for `overloadBackoffMs` between polls.
The `inference` block summarizes the shared inference control plane status.
`source` is `explicit` when a top-level `inference:` block is present in
`agent.yaml`, `legacy-implicit` when extraction and synthesis providers are
compiled into the router automatically, and `disabled` when no routeable
targets exist.


### GET /api/features

Returns all runtime feature flags.

**Response**

```json
{
  "featureName": true,
  "anotherFeature": false
}
```


Inference
-----------------

The daemon exposes Signet's inference control plane over both native RPC-style
routes and an OpenAI-compatible gateway. Native inference routes are intended
for first-party harnesses and CLI tooling. The OpenAI-compatible gateway is for
harnesses that can point at a model endpoint but cannot yet send the richer
Signet routing metadata.

### GET /api/inference/status

Requires `diagnostics` permission in authenticated modes.

Returns configured accounts, targets, policies, workload bindings, and the
current runtime snapshot for each route target.

**Response**

```json
{
  "enabled": true,
  "source": "explicit",
  "defaultPolicy": "auto",
  "defaultAgentId": "default",
  "policies": ["auto", "strict-coding"],
  "taskClasses": ["casual_chat", "hard_coding", "hipaa_sensitive"],
  "targetRefs": ["sonnet/default", "gpt/gpt54", "local/gemma4"],
  "workloadBindings": {
    "interactive": "auto",
    "memoryExtraction": "memory-pipeline",
    "sessionSynthesis": "memory-pipeline"
  },
  "runtimeSnapshot": {
    "targets": {
      "sonnet/default": {
        "available": true,
        "health": "healthy",
        "circuitOpen": false,
        "accountState": "ready"
      }
    }
  },
  "concurrency": {
    "active": {
      "execute": 0,
      "nativeStream": 1,
      "gatewayStream": 0,
      "total": 1
    },
    "limits": {
      "execute": 8,
      "nativeStream": 8,
      "gatewayStream": 16,
      "total": 24
    }
  }
}
```

Inference concurrency limits can be tuned with:

- `SIGNET_INFERENCE_MAX_CONCURRENT_EXECUTE`
- `SIGNET_INFERENCE_MAX_CONCURRENT_NATIVE_STREAMS`
- `SIGNET_INFERENCE_MAX_CONCURRENT_GATEWAY_STREAMS`
- `SIGNET_INFERENCE_MAX_CONCURRENT_TOTAL`

### GET /api/inference/history

Requires `diagnostics` permission in authenticated modes.

Returns recent local inference telemetry in a redacted, operator-friendly
shape. The endpoint only returns events when telemetry is enabled.

**Query parameters**

| Parameter  | Type    | Description                                      |
|------------|---------|--------------------------------------------------|
| `limit`    | integer | Max events, default `50`, max `500`              |
| `since`    | string  | ISO timestamp lower bound                        |
| `until`    | string  | ISO timestamp upper bound                        |
| `event`    | string  | One inference event type to include              |
| `failures` | `1`     | Include only failed, cancelled, or fallback rows |

**Response**

```json
{
  "enabled": true,
  "events": [
    {
      "event": "inference.fallback",
      "timestamp": "2026-04-10T18:12:00.000Z",
      "surface": "native",
      "agentId": "rose",
      "operation": "interactive",
      "taskClass": "interactive",
      "policyId": "auto",
      "selectedTarget": "primary/fast",
      "finalTarget": "backup/safe",
      "attemptPath": "primary/fast -> secondary/deep -> backup/safe",
      "failedTargets": "primary/fast,secondary/deep",
      "fallbackCount": 2,
      "errorCode": "RATE_LIMITED"
    }
  ],
  "summary": {
    "total": 1,
    "failures": 1,
    "fallbacks": 1,
    "cancelled": 0
  }
}
```

Inference history excludes raw prompts, response text, credentials, and session
references.

### POST /api/inference/explain

Requires `admin` permission in authenticated modes.

Dry-runs a route decision without executing the request. This is the backend
used by `signet route explain`.

**Request body**

```json
{
  "agentId": "rose",
  "operation": "interactive",
  "taskClass": "hard_coding",
  "privacy": "restricted_remote",
  "promptPreview": "fix this failing bun test",
  "refresh": true
}
```

Boundary guards:

- `explicitTargets` may contain at most 8 entries.
- `expectedInputTokens`, `expectedOutputTokens`, and `latencyBudgetMs` are
  clamped to sane non-negative bounds.
- `promptPreview` is truncated to 4,000 characters.
- Oversized request bodies return `413`.

**Response**

Returns a full `RouteDecision` object, including `trace.candidates[]` with the
ordered scoring and policy gates applied to each target.

### POST /api/inference/execute

Requires `admin` permission in authenticated modes.

Routes and executes a prompt using the Signet inference layer.

**Request body**

```json
{
  "agentId": "miles",
  "operation": "code_reasoning",
  "taskClass": "hard_coding",
  "prompt": "explain why this Rust borrow checker error happens",
  "maxTokens": 1200
}
```

Boundary guards:

- Request bodies over 512 KiB return `413`.
- `prompt` is capped at 200,000 characters.
- `maxTokens` and `timeoutMs` are clamped to sane non-negative bounds.
- `explicitTargets` may contain at most 8 entries.

**Response**

```json
{
  "text": "The borrow error happens because ...",
  "usage": {
    "inputTokens": 322,
    "outputTokens": 471,
    "cacheReadTokens": null,
    "cacheCreationTokens": null,
    "totalCost": null,
    "totalDurationMs": null
  },
  "decision": {
    "policyId": "auto",
    "mode": "automatic",
    "taskClass": "hard_coding",
    "targetRef": "gpt/gpt54"
  },
  "attempts": [
    { "targetRef": "gpt/gpt54", "ok": true, "durationMs": 1840 }
  ]
}
```

### POST /api/inference/stream

Requires `admin` permission in authenticated modes.

Streams a routed inference request over Server-Sent Events for first-party
Signet consumers. The request body matches `POST /api/inference/execute`.

**SSE events**

- `meta` — includes `requestId` and the selected route decision
- `delta` — streamed text chunks
- `done` — final text, usage, and attempt metadata
- `cancelled` — emitted when the stream is cancelled explicitly or by
  disconnect
- `error` — emitted when a provider dies mid-stream, including partial text

The response also includes `x-signet-request-id`, which can be used with the
cancellation endpoint below.

### DELETE /api/inference/requests/:id

Requires `admin` permission in authenticated modes.

Cancels an active native or gateway inference stream by request id.

### GET /v1/models

Requires `admin` permission in authenticated modes.

OpenAI-compatible model listing for the Signet gateway. Returned IDs include:

- `signet:auto`
- `policy:<policy-id>`
- explicit target refs like `gpt/gpt54`

### POST /v1/chat/completions

Requires `admin` permission in authenticated modes.

OpenAI-compatible chat completion endpoint. Signet routes the request before
execution. The request body accepts standard OpenAI-style `model`, `messages`,
and `max_tokens` fields.

Signet-specific routing hints can be provided in headers:

- `x-signet-agent-id`
- `x-signet-task-class`
- `x-signet-privacy-tier`
- `x-signet-operation`
- `x-signet-route-policy`
- `x-signet-explicit-target`

Boundary guards:

- Request bodies over 512 KiB return `413`.
- `messages` may contain at most 128 entries and 200,000 total characters of
  string content.
- Signet routing headers are normalized and invalid hint values return `400`.

When `stream: true`, the gateway returns OpenAI-style SSE chunks and includes
`x-signet-request-id` in the response headers so operators can cancel the
stream through `DELETE /api/inference/requests/:id`.


Auth
----

### GET /api/auth/whoami

Returns the identity and claims of the current request's token. In `local`
mode, `authenticated` is always `false` and `claims` is `null`.

**Response**

```json
{
  "authenticated": true,
  "claims": {
    "sub": "token:operator",
    "role": "operator",
    "scope": { "project": "my-project" },
    "iat": 1740000000,
    "exp": 1740086400
  },
  "mode": "team"
}
```

### POST /api/auth/token

Create a signed JWT. Requires `admin` permission. Rate-limited to 10
requests/min.

**Request body**

```json
{
  "role": "agent",
  "scope": { "project": "my-project", "agent": "claude", "user": "nicholai" },
  "ttlSeconds": 86400
}
```

`role` is required and must be one of `admin`, `operator`, `agent`,
`readonly`. `scope` is optional — an empty object creates an unscoped token.
`ttlSeconds` defaults to the value in `authConfig.defaultTokenTtlSeconds`.

**Response**

```json
{
  "token": "<jwt>",
  "expiresAt": "2026-02-22T10:00:00.000Z"
}
```

Returns `400` if `role` is invalid or auth secret is unavailable (local
mode). Returns `400` if the request body is missing or malformed.


Config
------

### GET /api/config

Returns all `.md` and `.yaml` files from the agents directory (`$SIGNET_WORKSPACE/`),
sorted by priority: `agent.yaml`, `AGENTS.md`, `SOUL.md`, `IDENTITY.md`,
`USER.md`, then alphabetically.

**Response**

```json
{
  "files": [
    { "name": "agent.yaml", "content": "...", "size": 1024 },
    { "name": "AGENTS.md", "content": "...", "size": 4096 }
  ]
}
```

### POST /api/config

Write a config file. File name must end in `.md` or `.yaml` and must not
contain path separators.

**Request body**

```json
{
  "file": "SOUL.md",
  "content": "# Soul\n..."
}
```

**Response**

```json
{
  "success": true,
  "auditError": "<error string when audit write fails, absent otherwise>",
  "providerTransitions": [
    {
      "role": "extraction",
      "from": "ollama",
      "to": "anthropic",
      "timestamp": "2026-04-12T00:00:00.000Z",
      "source": "api/config:agent.yaml",
      "risky": true
    }
  ]
}
```

`auditError` is present when the config was saved successfully but the
provider-transition audit file could not be written. The config is correct but
rollback via the audit trail will not be available for the transition.
`success: true` can coexist with a non-empty `auditError`.

`commentsStripped: true` is present when the `allowRemoteProviders: false` lock
was active and the submitted config omitted the flag with only local providers
selected. The lock is re-injected into the YAML, which strips YAML comments as a
side effect of the parse→stringify round-trip. Callers should warn users that
hand-written comments in the config file may be lost when this field is present.

Returns `400` for invalid file names, path traversal attempts, or wrong file
types. YAML saves also return `400` when
`memory.pipelineV2.allowRemoteProviders: false` and the submitted config
selects a paid or remote extraction/synthesis provider.

Returns `403` when saving a guarded config file (`agent.yaml`, `AGENT.yaml`,
`config.yaml`) without `admin` permission in team or hybrid auth mode.

### GET /api/config/provider-safety

Returns the currently configured provider-safety snapshot plus recent
provider transitions recorded from config saves and rollbacks.

**Response**

```json
{
  "snapshot": {
    "extractionProvider": "ollama",
    "synthesisProvider": "ollama",
    "allowRemoteProviders": true
  },
  "snapshotError": "Invalid YAML config",
  "transitions": [],
  "latestRiskyTransition": null
}
```

`snapshotError` is present when the config YAML could not be parsed; `snapshot` will be `null` in that case.

### POST /api/config/provider-safety/rollback

Roll back the latest recorded provider transition with a previous provider.
Pass `role: "extraction"` or `role: "synthesis"` to restrict the rollback;
omit it to roll back the most recent provider transition of either role.

Each transition can only be rolled back once — consumed entries are marked
`rolledBack: true` and skipped by subsequent calls.

> **Note:** This endpoint round-trips `agent.yaml` through a YAML parser
> and serializer, which strips comments. Any hand-written comments in the
> file will be lost. Edit the file directly if comment preservation matters.

**Request body**

```json
{ "role": "extraction" }
```

**Response**

```json
{
  "success": true,
  "file": "agent.yaml",
  "rolledBack": {
    "role": "extraction",
    "from": "ollama",
    "to": "anthropic",
    "timestamp": "2026-04-12T00:00:00.000Z",
    "source": "api/config:agent.yaml",
    "risky": true,
    "rolledBack": true
  },
  "providerTransitions": [
    {
      "role": "extraction",
      "from": "anthropic",
      "to": "ollama",
      "timestamp": "2026-04-12T00:01:00.000Z",
      "source": "api/config/provider-safety/rollback",
      "risky": false
    }
  ],
  "isRetry": false
}
```

`isRetry` is `true` when no provider transition was detected during the
rollback. This covers two cases: (1) the transition was already rolled back
in a prior request (audit write failed after config was written, so the
config is re-serialized and comments stripped again), or (2) the current
config already has the target provider (e.g. manually restored) but stale
model/endpoint fields were cleared. In both cases `providerTransitions`
is empty.

Returns `400` if `role` is present but not `extraction` or `synthesis`, if
the rolled-back config would violate `allowRemoteProviders`, or if the rollback
would produce no content change (e.g. synthesis rollback on a config with no
synthesis block — the audit entry is not consumed).
Returns `404` if no un-rolled-back transition exists, or if the source config
file referenced by the transition has been deleted or renamed.

The audit log retains the most recent 100 transitions. Older entries are
dropped with a logged warning — a rollback targeting a truncated entry
returns `404`.

Identity
--------

### GET /api/identity

Parses `IDENTITY.md` and returns the structured fields.

**Response**

```json
{
  "name": "Aria",
  "creature": "fox",
  "vibe": "calm and curious"
}
```

Returns defaults (`{ "name": "Unknown", "creature": "", "vibe": "" }`) if the
file is missing or unreadable.


Memories
--------

The [[memory]] API is the primary interface for reading and writing agent
memory. All write operations respect the `mutationsFrozen` kill switch — if
enabled, writes return `503`. For a typed client wrapper, see the [[sdk]].

### GET /api/memories

List memories with basic stats. Simple pagination only; for filtered search
use `POST /api/memory/recall` or `GET /memory/search`.

Requires `recall` permission.

**Query parameters**

| Parameter | Type    | Default | Description                  |
|-----------|---------|---------|------------------------------|
| `limit`   | integer | 100     | Max records to return        |
| `offset`  | integer | 0       | Pagination offset            |

**Response**

```json
{
  "memories": [
    {
      "id": "uuid",
      "content": "User prefers dark mode",
      "created_at": "2026-02-21T10:00:00.000Z",
      "who": "claude-code",
      "importance": 0.8,
      "tags": "preference,ui",
      "source_type": "manual",
      "pinned": 0,
      "type": "preference"
    }
  ],
  "stats": {
    "total": 1247,
    "withEmbeddings": 1200,
    "critical": 12
  }
}
```

### POST /api/memory/remember

Create a new memory. Requires `remember` permission.

Content prefixes are parsed automatically:
- `critical: <content>` — sets `pinned=true`, `importance=1.0`
- `[tag1,tag2]: <content>` — sets tags

Body-level fields override prefix-parsed values.

**Request body**

```json
{
  "content": "User prefers vim keybindings",
  "who": "claude-code",
  "project": "my-project",
  "importance": 0.9,
  "tags": "preference,editor",
  "pinned": false,
  "sourceType": "manual",
  "sourceId": "optional-external-id",
  "createdAt": "2026-02-21T10:00:00.000Z",
  "agentId": "alice",
  "visibility": "global"
}
```

Only `content` is required. Multi-agent fields:

| Field        | Description |
|--------------|-------------|
| `agentId`    | Agent that owns this memory. Defaults to `"default"`. |
| `visibility` | `"global"` (any permitted agent can read), `"private"` (owner only). Defaults to `"global"`. |

`createdAt` is optional and must be a valid ISO timestamp. Use it when the
memory is sourced from an older conversation or imported artifact so structured
currentness and supersession can compare facts by source time instead of ingest
time.

Structured callers may also pass `structured.entities`, `structured.aspects`,
and `structured.hints`. Aspect attributes are persisted directly under
`entity_attributes`. Include `groupKey` to create a navigable subgroup inside an
aspect, and include `claimKey` when the claim can be updated over time.
Supersession only runs within the same entity/aspect/groupKey/claimKey, so
unrelated events under one aspect do not replace each other. Newer conflicting
attributes on the same grouped claim can mark older attributes as `superseded`
with `superseded_by` pointing at the replacement.

When `structured` is omitted, the default remember path is deliberately
conservative. It embeds and stores the memory, then links mentions to existing
entities for the same `agentId` when they are mechanically recognizable. It does
not create new entities, aspects, attributes, dependencies, or supersession
claims from raw text. Use a structured payload when the caller intends to author
or update the knowledge graph.

**Response**

```json
{
  "id": "uuid",
  "type": "preference",
  "tags": "preference,editor",
  "pinned": false,
  "importance": 0.9,
  "content": "User prefers vim keybindings",
  "embedded": true,
  "deduped": false
}
```

If an identical memory (by content hash or `sourceId`) already exists,
`deduped: true` is returned with the existing record — no duplicate is
created.

### POST /api/memory/save

Alias for `POST /api/memory/remember`. Accepts the same request body and
returns the same response. Requires `remember` permission.

### POST /api/hook/remember

Alias for `POST /api/memory/remember`. Used by Claude Code skill
compatibility. Requires `remember` permission.

### GET /api/memory/:id

Get a single memory by ID. Returns deleted memories only if the query
explicitly requests them; by default, soft-deleted records return `404`.

Requires `recall` permission.

**Response**

```json
{
  "id": "uuid",
  "content": "User prefers vim keybindings",
  "type": "preference",
  "importance": 0.9,
  "tags": "preference,editor",
  "pinned": 0,
  "who": "claude-code",
  "source_type": "manual",
  "project": null,
  "session_id": null,
  "confidence": null,
  "access_count": 3,
  "last_accessed": "2026-02-21T11:00:00.000Z",
  "is_deleted": 0,
  "deleted_at": null,
  "extraction_status": "done",
  "embedding_model": "nomic-embed-text",
  "version": 2,
  "created_at": "2026-02-21T10:00:00.000Z",
  "updated_at": "2026-02-21T10:30:00.000Z",
  "updated_by": "operator"
}
```

### GET /api/memory/:id/history

Full audit history for a memory in chronological order. Requires `recall`
permission.

**Query parameters**

| Parameter | Type    | Default | Description              |
|-----------|---------|---------|--------------------------|
| `limit`   | integer | 200     | Max events (cap: 1000)   |

**Response**

```json
{
  "memoryId": "uuid",
  "count": 3,
  "history": [
    {
      "id": "hist-uuid",
      "event": "created",
      "oldContent": null,
      "newContent": "User prefers vim keybindings",
      "changedBy": "claude-code",
      "actorType": "operator",
      "reason": null,
      "metadata": null,
      "createdAt": "2026-02-21T10:00:00.000Z",
      "sessionId": null,
      "requestId": null
    }
  ]
}
```

### POST /api/memory/:id/recover

Restore a soft-deleted memory. The recovery window is 30 days from deletion.
Requires `recover` permission.

**Request body**

```json
{
  "reason": "Accidentally deleted",
  "if_version": 3
}
```

`reason` is required. `if_version` is optional — if provided, the operation
is rejected with `409` if the current version does not match (optimistic
concurrency).

**Response**

```json
{
  "id": "uuid",
  "status": "recovered",
  "currentVersion": 3,
  "newVersion": 4,
  "retentionDays": 30
}
```

Possible `status` values and their HTTP codes:

| Status               | Code | Meaning                                 |
|----------------------|------|-----------------------------------------|
| `recovered`          | 200  | Success                                 |
| `not_found`          | 404  | Memory does not exist                   |
| `not_deleted`        | 409  | Memory is not deleted                   |
| `retention_expired`  | 409  | Outside 30-day recovery window          |
| `version_conflict`   | 409  | `if_version` mismatch                   |

### PATCH /api/memory/:id

Update a memory's fields. At least one of `content`, `type`, `tags`,
`importance`, or `pinned` must be provided. Requires `modify` permission.
Rate-limited to 60/min.

Scoped tokens in non-local mode have their project scope checked against the
target memory's `project` field before the mutation is applied.

**Request body**

```json
{
  "content": "Updated content",
  "type": "fact",
  "tags": ["updated", "fact"],
  "importance": 0.7,
  "pinned": false,
  "reason": "Correcting outdated information",
  "if_version": 2,
  "changed_by": "operator"
}
```

`reason` is required. `if_version` is optional optimistic concurrency guard.
`tags` may be a string (comma-separated), an array of strings, or `null` to
clear tags.

**Response**

```json
{
  "id": "uuid",
  "status": "updated",
  "currentVersion": 2,
  "newVersion": 3,
  "contentChanged": true,
  "embedded": true
}
```

Possible `status` values and their HTTP codes:

| Status                  | Code | Meaning                                  |
|-------------------------|------|------------------------------------------|
| `updated`               | 200  | Success                                  |
| `no_changes`            | 200  | Patch produced no diff                   |
| `not_found`             | 404  | Memory does not exist                    |
| `deleted`               | 409  | Cannot modify a deleted memory           |
| `version_conflict`      | 409  | `if_version` mismatch                    |
| `duplicate_content_hash`| 409  | New content matches an existing memory   |

### DELETE /api/memory/:id

Soft-delete a memory. Deleted memories can be recovered within 30 days.
Requires `forget` permission. Rate-limited to 30/min.

Scoped tokens have their project scope checked before the deletion. Pinned
memories require `force: true`. Autonomous agents (pipeline/agent actor type)
cannot force-delete pinned memories.

**Request body** (or query parameters)

```json
{
  "reason": "No longer relevant",
  "force": false,
  "if_version": 3
}
```

`reason` is required, either in the body or as `?reason=...` query parameter.
`force` defaults to `false`. `if_version` is optional.

**Response**

```json
{
  "id": "uuid",
  "status": "deleted",
  "currentVersion": 3,
  "newVersion": 4
}
```

Possible `status` values and their HTTP codes:

| Status                    | Code | Meaning                                    |
|---------------------------|------|--------------------------------------------|
| `deleted`                 | 200  | Success                                    |
| `not_found`               | 404  | Memory does not exist                      |
| `already_deleted`         | 409  | Memory is already deleted                  |
| `version_conflict`        | 409  | `if_version` mismatch                      |
| `pinned_requires_force`   | 409  | Pinned memory requires `force: true`       |
| `autonomous_force_denied` | 403  | Autonomous agents cannot force-delete      |

### POST /api/memory/forget

Batch forget with preview/execute workflow. Requires `forget` permission.
Rate-limited to 5/min (batch forget limiter).

Requires at least one of: `query`, `ids`, or a filter field (`type`, `tags`,
`who`, `source_type`, `since`, `until`). The batch size cap is 200.

For large operations (>25 candidates), the `execute` mode requires a
`confirm_token` obtained from a prior `preview` call.

**Request body — preview mode**

```json
{
  "mode": "preview",
  "query": "outdated preferences",
  "type": "preference",
  "tags": "old",
  "who": "claude-code",
  "source_type": "manual",
  "since": "2025-01-01T00:00:00Z",
  "until": "2026-01-01T00:00:00Z",
  "limit": 20
}
```

Or target specific IDs:

```json
{
  "mode": "preview",
  "ids": ["uuid1", "uuid2"]
}
```

**Preview response**

```json
{
  "mode": "preview",
  "count": 3,
  "requiresConfirm": false,
  "confirmToken": "abc123...",
  "candidates": [
    { "id": "uuid1", "score": 0.85, "pinned": false, "version": 2 }
  ]
}
```

**Request body — execute mode**

```json
{
  "mode": "execute",
  "query": "outdated preferences",
  "reason": "Cleaning up stale data",
  "force": false,
  "confirm_token": "abc123..."
}
```

`reason` is required in execute mode. `confirm_token` is required when
`requiresConfirm` was `true` in the preview.

**Execute response**

```json
{
  "mode": "execute",
  "requested": 3,
  "deleted": 3,
  "results": [
    { "id": "uuid1", "status": "deleted", "currentVersion": 2, "newVersion": 3 }
  ]
}
```

### POST /api/memory/modify

Batch update multiple memories in a single request. Requires `modify`
permission. Rate-limited to 60/min. Maximum 200 patches per request.

**Request body**

```json
{
  "reason": "Bulk correction",
  "changed_by": "operator",
  "patches": [
    {
      "id": "uuid1",
      "content": "Updated content",
      "reason": "Per-patch reason override",
      "if_version": 2
    },
    {
      "id": "uuid2",
      "tags": ["updated"],
      "importance": 0.6
    }
  ]
}
```

Top-level `reason` and `changed_by` are defaults applied to all patches. Each
patch can override `reason` individually. `if_version` per patch is optional.

**Response**

```json
{
  "total": 2,
  "updated": 2,
  "results": [
    {
      "id": "uuid1",
      "status": "updated",
      "currentVersion": 2,
      "newVersion": 3,
      "contentChanged": true,
      "embedded": true
    },
    {
      "id": "uuid2",
      "status": "updated",
      "currentVersion": 1,
      "newVersion": 2,
      "contentChanged": false
    }
  ]
}
```

Individual patch items that fail validation return `status: "invalid_request"`
with an `error` field. The batch continues — partial success is possible.

### POST /api/memory/recall

Hybrid search combining BM25 keyword (FTS5) and vector similarity. Results
are fused using a configurable alpha weight (`cfg.search.alpha`). Optional
graph boost and reranker pass are applied if enabled in pipeline config.
Requires `recall` permission.

**Request body**

```json
{
  "query": "user preferences for editor",
  "limit": 10,
  "type": "preference",
  "tags": "editor,ui",
  "who": "claude-code",
  "pinned": false,
  "importance_min": 0.5,
  "since": "2026-01-01T00:00:00Z",
  "agentId": "alice"
}
```

Only `query` is required.

**Response**

```json
{
  "results": [
    {
      "id": "uuid",
      "content": "User prefers vim keybindings",
      "score": 0.92,
      "source": "hybrid",
      "type": "preference",
      "tags": "preference,editor",
      "pinned": false,
      "importance": 0.9,
      "who": "claude-code",
      "project": null,
      "created_at": "2026-02-21T10:00:00.000Z",
      "supplementary": false
    }
  ],
  "query": "user preferences for editor",
  "method": "hybrid",
  "meta": {
    "totalReturned": 1,
    "hasSupplementary": false,
    "noHits": false
  }
}
```

`source` per result is one of `hybrid`, `vector`, `keyword`, or `llm_summary`.
`method` on the response reflects whether vector search was available for
this call.

`meta.totalReturned` reflects the number of returned rows. `meta.hasSupplementary`
is `true` when the response includes supporting context such as an LLM summary
card or linked rationale context. `meta.noHits` is `true` when recall completed
normally but found no matching results.

When `memory.pipelineV2.reranker.useExtractionModel` is enabled, an
additional synthesized summary card may be prepended to results. This card
has `source: "llm_summary"`, `supplementary: true`, and an id of the form
`summary:<sha1-12>`. It is only injected when `limit >= 2` so callers
always receive at least one real memory to verify the summary against. The
card is not stored in the database and does not affect access-time tracking.

**Operational note**: `useExtractionModel` moves recall onto a live LLM
call path. When auth mode is not `local`, the daemon enforces a dedicated
rate-limit bucket — `auth.rateLimits.recallLlm` (default: 60 req/min per
token). Configure it in `agent.yaml` alongside the other operation limits:

```yaml
auth:
  mode: team
  rateLimits:
    recallLlm:
      windowMs: 60000
      max: 30
```

No additional permission level is required beyond `recall`.

### GET /api/memory/search

GET-compatible alias for `POST /api/memory/recall`. Forwards query parameters
to the recall endpoint. Requires `recall` permission.

**Query parameters**

| Parameter      | Description                   |
|----------------|-------------------------------|
| `q`            | Search query (required)       |
| `limit`        | Max results (default: 10)     |
| `type`         | Filter by memory type         |
| `tags`         | Filter by tag (comma-sep)     |
| `who`          | Filter by author              |
| `pinned`       | `1` or `true` to filter       |
| `importance_min` | Minimum importance float    |
| `since`        | ISO timestamp lower bound     |

**Response** — same shape as `POST /api/memory/recall`.

### GET /memory/search

Legacy keyword search endpoint. Also supports filter-only queries without a
search term. Requires `recall` permission.

**Query parameters**

| Parameter       | Description                                  |
|-----------------|----------------------------------------------|
| `q`             | FTS5 query string (optional)                 |
| `distinct`      | `who` — returns distinct authors instead     |
| `limit`         | Max results (default: 20 with query, 50 without) |
| `type`          | Filter by type                               |
| `tags`          | Comma-separated tag filter                   |
| `who`           | Filter by author                             |
| `pinned`        | `1` or `true`                                |
| `importance_min`| Float minimum                                |
| `since`         | ISO timestamp                                |

When `distinct=who` is passed, all other parameters are ignored and the
response is `{ "values": ["alice", "bob"] }`.

Otherwise: `{ "results": [...] }` where each result includes `id`, `content`,
`created_at`, `who`, `importance`, `tags`, `type`, `pinned`, and optionally
`score` (BM25 or recency-weighted).

### GET /memory/similar

Vector similarity search anchored to an existing memory's embedding. Returns
memories most similar to the given record. Requires `recall` permission.

**Query parameters**

| Parameter | Description                              |
|-----------|------------------------------------------|
| `id`      | Memory ID to use as the anchor (required)|
| `k`       | Number of results (default: 10)          |
| `type`    | Optional type filter                     |

**Response**

```json
{
  "results": [
    {
      "id": "uuid",
      "content": "...",
      "type": "preference",
      "tags": [],
      "score": 0.87,
      "confidence": null,
      "created_at": "2026-02-21T10:00:00.000Z"
    }
  ]
}
```

Returns `404` if the anchor memory has no stored embedding.


Embeddings
----------

### GET /api/embeddings

Export all stored embeddings with their parent memory metadata. Falls back to
a legacy Python export script if the `embeddings` table does not exist.
Requires `recall` permission.

**Query parameters**

| Parameter | Type    | Default | Range        | Description              |
|-----------|---------|---------|--------------|--------------------------|
| `limit`   | integer | 600     | 50–5000      | Page size                |
| `offset`  | integer | 0       | 0–100000     | Page offset              |
| `vectors` | boolean | false   | —            | Include raw float arrays |

**Response**

```json
{
  "embeddings": [
    {
      "id": "uuid",
      "content": "...",
      "text": "...",
      "who": "claude-code",
      "importance": 0.8,
      "type": "preference",
      "tags": ["preference"],
      "sourceType": "memory",
      "sourceId": "uuid",
      "createdAt": "2026-02-21T10:00:00.000Z",
      "vector": [0.1, 0.2, ...]
    }
  ],
  "count": 50,
  "total": 1200,
  "limit": 600,
  "offset": 0,
  "hasMore": true
}
```

`vector` is only present when `vectors=true` is set.

### GET /api/embeddings/status

Check the configured embedding provider's availability. Results are cached for
30 seconds. Requires `recall` permission.

**Response**

```json
{
  "provider": "ollama",
  "model": "nomic-embed-text",
  "available": true,
  "dimensions": 768,
  "base_url": "http://localhost:11434",
  "checkedAt": "2026-02-21T10:00:00.000Z"
}
```

On failure, `available` is `false` and `error` contains a description.

### GET /api/embeddings/health

Returns embedding health metrics including coverage and staleness.

**Response** — embedding health object with coverage percentage, stale
count, and provider status.

### GET /api/embeddings/projection

Returns a server-computed UMAP projection of all stored embeddings.
Results are cached in the `umap_cache` table; cache is invalidated when
the embedding count changes. Requires `recall` permission.

**Query parameters**

| Parameter    | Type    | Default | Description                    |
|--------------|---------|---------|--------------------------------|
| `dimensions` | integer | 2       | Output dimensions: `2` or `3`  |

If the projection is still computing, the endpoint returns `202 Accepted`
with `status: "computing"`. Poll again when ready.

**Response (computed)**

```json
{
  "status": "cached",
  "dimensions": 2,
  "count": 847,
  "total": 847,
  "nodes": [
    {
      "id": "uuid",
      "x": 42.1,
      "y": -18.7,
      "content": "User prefers vim keybindings",
      "who": "claude-code",
      "importance": 0.8,
      "type": "preference",
      "tags": ["preference"],
      "pinned": false,
      "sourceType": "memory",
      "sourceId": "uuid",
      "createdAt": "2026-02-21T10:00:00.000Z"
    }
  ],
  "edges": [[0, 3], [0, 7]],
  "cachedAt": "2026-02-21T10:05:00.000Z"
}
```

**Response (computing)**

```json
{ "status": "computing", "dimensions": 2, "count": 0, "total": 847 }
```


Documents
---------

The documents API ingests external content (text, URLs, files) for chunking
and embedding. Each document generates linked memory records via the pipeline.
All document endpoints require `documents` permission.

### POST /api/documents

Submit a document for ingestion. The document is queued and processed
asynchronously. Returns `201` on success, or the existing document's ID and
status if a duplicate URL is detected.

**Request body**

```json
{
  "source_type": "text",
  "content": "Full text content here",
  "title": "My Document",
  "content_type": "text/plain",
  "connector_id": null,
  "metadata": { "author": "nicholai" }
}
```

For `source_type: "url"`:

```json
{
  "source_type": "url",
  "url": "https://example.com/page",
  "title": "Example Page"
}
```

`source_type` is required and must be `text`, `url`, or `file`. `content` is
required for `text`. `url` is required for `url`.

**Response**

```json
{ "id": "uuid", "status": "queued" }
```

Or if deduplicated:

```json
{ "id": "existing-uuid", "status": "processing", "deduplicated": true }
```

### GET /api/documents

List all documents with optional status filter.

**Query parameters**

| Parameter | Description                              |
|-----------|------------------------------------------|
| `status`  | Filter by status (`queued`, `processing`, `done`, `failed`, `deleted`) |
| `limit`   | Page size (default: 50, max: 500)        |
| `offset`  | Pagination offset (default: 0)           |

**Response**

```json
{
  "documents": [...],
  "total": 42,
  "limit": 50,
  "offset": 0
}
```

Each document includes all columns from the `documents` table.

### GET /api/documents/:id

Get a single document by ID.

**Response** — full document row, or `404`.

### GET /api/documents/:id/chunks

List the memory records derived from this document, ordered by chunk index.

**Response**

```json
{
  "chunks": [
    {
      "id": "memory-uuid",
      "content": "Chunk text...",
      "type": "fact",
      "created_at": "2026-02-21T10:00:00.000Z",
      "chunk_index": 0
    }
  ],
  "count": 12
}
```

### DELETE /api/documents/:id

Soft-delete a document and all its derived memory records. Memories linked to
the document are soft-deleted one at a time with audit history.

**Query parameters**

| Parameter | Description                    |
|-----------|--------------------------------|
| `reason`  | Required. Deletion reason.     |

**Response**

```json
{ "deleted": true, "memoriesRemoved": 12 }
```


Connectors
----------

Connectors ingest documents from external sources on a schedule or on demand.
Currently only the `filesystem` provider is operational; `github-docs` and
`gdrive` are registered but not yet functional.

GET requests to connector endpoints are open. POST, DELETE, and mutation
requests require `admin` permission (or `connectors` for operators).

### GET /api/connectors

List all registered connectors.

**Response**

```json
{
  "connectors": [
    {
      "id": "uuid",
      "status": "idle",
      "config_json": "{...}",
      "cursor_json": "{...}",
      "last_sync_at": "2026-02-21T09:00:00.000Z",
      "last_error": null
    }
  ],
  "count": 1
}
```

### POST /api/connectors

Register a new connector. Requires `admin` permission.

**Request body**

```json
{
  "provider": "filesystem",
  "displayName": "My Notes",
  "settings": {
    "rootPath": "/home/nicholai/notes",
    "glob": "**/*.md"
  }
}
```

`provider` must be `filesystem`, `github-docs`, or `gdrive`.

**Response**

```json
{ "id": "uuid" }
```

Returns `201`.

### GET /api/connectors/:id

Get a single connector's details and current state.

### POST /api/connectors/:id/sync

Trigger an incremental sync for a filesystem connector. The sync runs in the
background — poll `GET /api/connectors/:id` for status updates. Requires
`admin` permission.

**Response**

```json
{ "status": "syncing" }
```

Returns `{ "status": "syncing", "message": "Already syncing" }` if a sync is
already running.

### POST /api/connectors/:id/sync/full

Trigger a full resync, discarding the cursor. Requires `?confirm=true` query
parameter as a safety guard. Requires `admin` permission.

**Response**

```json
{ "status": "syncing" }
```

### DELETE /api/connectors/:id

Remove a connector from the registry. Requires `admin` permission.

**Query parameters**

| Parameter | Description                                              |
|-----------|----------------------------------------------------------|
| `cascade` | `true` — also soft-delete documents from this connector  |

**Response**

```json
{ "deleted": true }
```

### GET /api/connectors/:id/health

Lightweight health check for a connector, including document count.

**Response**

```json
{
  "id": "uuid",
  "status": "idle",
  "lastSyncAt": "2026-02-21T09:00:00.000Z",
  "lastError": null,
  "documentCount": 142
}
```


Agents
------

Multi-agent endpoints for managing the agent roster. All agents share one
SQLite database; memories are scoped by `agent_id` and `visibility`. The
read policy controls which other agents' global memories each agent can see.

### GET /api/agents

List all registered agents. Requires no permission (local mode) or `recall`.

**Response**

```json
{
  "agents": [
    {
      "id": "default",
      "name": "default",
      "read_policy": "shared",
      "policy_group": null,
      "created_at": "2026-03-24T00:00:00.000Z",
      "updated_at": "2026-03-24T00:00:00.000Z"
    },
    {
      "id": "alice",
      "name": "alice",
      "read_policy": "isolated",
      "policy_group": null,
      "created_at": "2026-03-24T12:00:00.000Z",
      "updated_at": "2026-03-24T12:00:00.000Z"
    }
  ]
}
```

`read_policy` is one of:
- `isolated` — agent sees only its own memories
- `shared` — agent sees all `visibility=global` memories from any agent
- `group` — agent sees `visibility=global` memories from agents in the same `policy_group`

### GET /api/agents/:name

Get a single agent by name. Returns `404` if not found.

**Response** — same shape as a single entry in `GET /api/agents`.

### POST /api/agents

Register a new agent. Requires `remember` permission.

**Request body**

```json
{
  "name": "alice",
  "read_policy": "isolated",
  "policy_group": null
}
```

Only `name` is required. `read_policy` defaults to `"isolated"`.

**Response** — the created agent record.

### DELETE /api/agents/:name

Remove an agent from the roster. Memories owned by the agent are marked
`visibility='archived'` (not deleted). Requires `admin` permission.

**Query parameters**

| Parameter | Description |
|-----------|-------------|
| `purge`   | Set to `true` to permanently delete all memories where `agent_id = name`. |

**Response**

```json
{ "success": true, "purged": false }
```

Skills
------

### GET /api/skills

List all installed skills from `$SIGNET_WORKSPACE/skills/`. Each skill must have a
`SKILL.md` with YAML frontmatter.

**Response**

```json
{
  "skills": [
    {
      "name": "browser-use",
      "description": "Browser automation skill",
      "version": "1.0.0",
      "author": "browser-use",
      "license": "MIT",
      "user_invocable": true,
      "arg_hint": "<url>",
      "path": "/home/user/.agents/skills/browser-use"
    }
  ],
  "count": 3
}
```

### GET /api/skills/search

Search the skills.sh registry for installable skills.

**Query parameters**

| Parameter | Description                     |
|-----------|---------------------------------|
| `q`       | Search query string (required)  |

**Response**

```json
{
  "results": [
    {
      "name": "browser-use",
      "description": "browser-use/browser-use@browser-use (32.6K installs)",
      "installed": false
    }
  ]
}
```

### GET /api/skills/:name

Get a single skill's metadata and full `SKILL.md` content.

**Response**

```json
{
  "name": "browser-use",
  "description": "...",
  "version": "1.0.0",
  "path": "/home/user/.agents/skills/browser-use",
  "content": "---\ndescription: ...\n---\n\n# Browser Use\n..."
}
```

Returns `400` for invalid names (path traversal). Returns `404` if not
installed.

### POST /api/skills/install

Install a skill via the configured package manager (bun, npm, or pnpm).
Runs `skills add <pkg> --global --yes`. Times out after 60 seconds.

**Request body**

```json
{
  "name": "browser-use",
  "source": "browser-use/browser-use@browser-use"
}
```

`name` is required. `source` overrides the install package name if provided.

**Response**

```json
{ "success": true, "name": "browser-use", "output": "..." }
```

Returns `500` with `{ "success": false, "error": "..." }` on failure.

### DELETE /api/skills/:name

Uninstall a skill by removing its directory from `$SIGNET_WORKSPACE/skills/`.

**Response**

```json
{ "success": true, "name": "browser-use", "message": "Removed browser-use" }
```

### GET /api/skills/analytics

Return usage analytics for skill invocations recorded by the daemon.

**Query parameters**

| Parameter  | Description |
|------------|-------------|
| `agent_id` | Optional agent scope override. Defaults to the request-scoped agent or `default`. |
| `since`    | Optional ISO 8601 UTC timestamp filter, e.g. `2026-03-01T00:00:00Z`. |
| `limit`    | Optional max number of top skills to return. Default `10`, range `1-100`. |

**Response**

```json
{
  "totalCalls": 12,
  "successRate": 0.917,
  "topSkills": [
    {
      "skillName": "web-search",
      "count": 5,
      "successCount": 5,
      "avgLatencyMs": 184
    }
  ],
  "latency": {
    "p50": 160,
    "p95": 310
  }
}
```

Returns `400` if `since` is not an ISO 8601 UTC timestamp.


Harnesses
---------

### GET /api/harnesses

List known harness config file locations and whether each exists on disk.

**Response**

```json
{
  "harnesses": [
    { "name": "Claude Code", "path": "/home/user/.claude/CLAUDE.md", "exists": true },
    { "name": "OpenCode", "path": "/home/user/.config/opencode/AGENTS.md", "exists": false },
    { "name": "OpenClaw (Source)", "path": "/home/user/.agents/AGENTS.md", "exists": true }
  ]
}
```

### POST /api/harnesses/regenerate

Run the `generate-harness-configs.py` script from the scripts directory to
rebuild all harness config files from source. The script must exist at
`$SIGNET_WORKSPACE/scripts/generate-harness-configs.py`.

**Response**

```json
{ "success": true, "message": "Configs regenerated successfully", "output": "..." }
```

Returns `404` if the script is not found.


Plugins
-------

Plugin diagnostics expose the daemon-owned Plugin SDK V1 registry. The
first bundled core plugin is `signet.secrets`, which owns the existing
Secrets API, CLI, MCP, dashboard, SDK, connector, and prompt-contribution
surfaces. Diagnostics never include raw secret values.

### GET /api/plugins

List registered plugins and their lifecycle state, grants, pending
capabilities, and active surface metadata. Active surface metadata is
filtered by granted capabilities. Planned surfaces remain visible through
plugin diagnostics.

**Response**

```json
{
  "plugins": [
    {
      "id": "signet.secrets",
      "name": "Signet Secrets",
      "state": "active",
      "enabled": true,
      "declaredCapabilities": ["secrets:list", "secrets:exec"],
      "grantedCapabilities": ["secrets:list", "secrets:exec"],
      "pendingCapabilities": [],
      "surfaces": {
        "daemonRoutes": [],
        "cliCommands": [],
        "mcpTools": [],
        "dashboardPanels": [],
        "sdkClients": [],
        "connectorCapabilities": [],
        "promptContributions": []
      }
    }
  ]
}
```

### GET /api/plugins/:id

Return one plugin registry record. Returns `404` if the plugin is not
registered.

### GET /api/plugins/:id/diagnostics

Return the registry record, manifest metadata, active surfaces, planned
surfaces, prompt contributions, prompt inclusion/exclusion diagnostics, and
validation errors for a plugin.

### GET /api/plugins/prompt-contributions

List active prompt contributions from enabled plugins with the required
prompt capability grant.

**Response**

```json
{
  "contributions": [
    {
      "id": "signet.secrets.credential-guidance",
      "pluginId": "signet.secrets",
      "target": "user-prompt-submit",
      "mode": "context",
      "priority": 420,
      "maxTokens": 80,
      "content": "When the user provides credentials..."
    }
  ],
  "activeCount": 1
}
```

### GET /api/plugins/audit

List durable plugin audit events from
`$SIGNET_WORKSPACE/.daemon/plugins/audit-v1.ndjson`. Events are newest
first, capped to 500 rows, and sensitive fields are redacted before they
are written and again when read.

**Query parameters**

- `pluginId` - optional plugin id filter, for example `signet.secrets`
- `event` - optional exact event name filter
- `since` / `until` - optional ISO timestamp bounds
- `limit` - optional row limit, default `100`, max `500`

**Response**

```json
{
  "events": [
    {
      "id": "m36n9q5a-x4w2k8p1",
      "timestamp": "2026-04-16T12:00:00.000Z",
      "event": "plugin.enabled",
      "pluginId": "signet.secrets",
      "result": "ok",
      "source": "plugin-host",
      "data": {
        "state": "active",
        "enabled": true
      }
    }
  ],
  "count": 1
}
```

### PATCH /api/plugins/:id

Enable or disable a registered plugin.

**Request body**

```json
{ "enabled": false }
```

Disabling `signet.secrets` removes its active prompt and advertised
surface metadata. It does not delete stored secrets.

Plugin lifecycle changes emit structured daemon diagnostics including
`plugin.discovered`, `plugin.enabled`, `plugin.disabled`,
`plugin.blocked`, `plugin.degraded`, `plugin.health_failed`,
`plugin.capability_denied`, `prompt.contribution_added`, and
`prompt.contribution_removed`. The same events are appended to the durable
plugin audit log for diagnostics and support.


Secrets
-------

Secrets are owned by the bundled `signet.secrets` core plugin. Local
secrets are stored encrypted on disk at `$SIGNET_WORKSPACE/.secrets/`.
Values are never returned in ordinary API responses, only names are
exposed. Bare names such as `OPENAI_API_KEY` are compatibility aliases
for local provider references such as `local://OPENAI_API_KEY`.
Secrets routes require the matching granted `signet.secrets` capability. If
the plugin is disabled, blocked, or missing a route capability, the route
returns a structured plugin-capability error without deleting stored data.
Secret operations emit structured daemon diagnostics for listing,
storage, deletion, command injection, and command completion. These
diagnostics never include raw secret values.

### POST /api/secrets/:name

Store or overwrite a secret value.

**Request body**

```json
{ "value": "sk-abc123..." }
```

`value` must be a non-empty string.

**Response**

```json
{ "success": true, "name": "OPENAI_API_KEY" }
```

### GET /api/secrets

List stored secret names. Values are never included.

**Response**

```json
{ "secrets": ["OPENAI_API_KEY", "GITHUB_TOKEN"] }
```

### DELETE /api/secrets/:name

Delete a stored secret.

**Response**

```json
{ "success": true, "name": "OPENAI_API_KEY" }
```

Returns `404` if the secret does not exist.

### POST /api/secrets/exec

Execute a shell command with multiple secrets injected into the subprocess
environment. Callers pass a map of env var names to secret references —
never actual values. References can be Signet secret names or direct
1Password refs (`op://vault/item/field`). The daemon resolves and injects
all values before spawning.

**Request body**

```json
{
  "command": "curl -H 'Authorization: Bearer $OPENAI_API_KEY' https://api.openai.com/v1/models",
  "secrets": {
    "OPENAI_API_KEY": "OPENAI_API_KEY",
    "GITHUB_TOKEN": "GITHUB_TOKEN"
  }
}
```

Both `command` and `secrets` are required. The `secrets` map must contain at
least one entry.

**Response**

```json
{ "code": 0, "stdout": "...", "stderr": "" }
```

### POST /api/secrets/:name/exec

Legacy single-secret variant. Execute a shell command with a single secret
injected into the subprocess environment. Prefer `/api/secrets/exec` for
new integrations.

**Request body**

```json
{
  "command": "curl -H 'Authorization: Bearer $OPENAI_API_KEY' https://api.openai.com/v1/models",
  "secrets": {
    "OPENAI_API_KEY": "OPENAI_API_KEY"
  }
}
```

`command` is required. `secrets` is optional — if omitted, the named secret
from the URL path is injected under its own name.

**Response**

```json
{ "code": 0, "stdout": "...", "stderr": "" }
```

### GET /api/secrets/1password/status

Return 1Password integration status, including whether a service account
token is configured and (when available) accessible vaults.

### POST /api/secrets/1password/connect

Validate and store a 1Password service account token.

**Request body**

```json
{ "token": "ops_..." }
```

### DELETE /api/secrets/1password/connect

Disconnect 1Password integration by removing the stored service account
token secret.

### GET /api/secrets/1password/vaults

List accessible vaults for the connected service account.

### POST /api/secrets/1password/import

Import password-like fields from 1Password vault items into Signet
secrets.

**Request body**

```json
{
  "vaults": ["Engineering"],
  "prefix": "OP",
  "overwrite": false
}
```


Hooks
-----

Hook endpoints integrate with AI harness session lifecycle events. They are
used by connector packages to inject memory context and extract new memories.

The `x-signet-runtime-path` request header (or `runtimePath` body field)
declares whether the caller is the `plugin` or `legacy` runtime path. The
daemon enforces that only one path can be active per session — subsequent
calls from the other path return `409`.

### POST /api/hooks/session-start

Called at the beginning of a session. Returns context and relevant memories
for injection into the harness system prompt. Requires `remember` permission
(via hook routing).

**Request body**

```json
{
  "harness": "claude-code",
  "sessionKey": "session-uuid",
  "runtimePath": "plugin"
}
```

`harness` is required.

**Response** — implementation-defined context object returned by
`handleSessionStart`.

### POST /api/hooks/user-prompt-submit

Called on each user message. Returns memories relevant to the current prompt
for in-context injection.

**Request body**

```json
{
  "harness": "claude-code",
  "userMessage": "How do I set up dark mode?",
  "userPrompt": "How do I set up dark mode?",
  "lastAssistantMessage": "Earlier we discussed using CSS variables for theme tokens.",
  "sessionKey": "session-uuid",
  "transcriptPath": "/tmp/signet/session-transcript.txt",
  "runtimePath": "plugin"
}
```

`harness` is required.
`userMessage` is preferred when the harness can provide a cleaned user turn.
`userPrompt`, `lastAssistantMessage`, `transcriptPath`, and inline `transcript`
are optional.

Prompt-submit retrieval prefers structured memory recall. When structured
recall is weak or empty, the daemon first attempts temporal-summary
fallback (session DAG artifacts) and then transcript fallback from prior
session transcripts instead of returning no context.

### POST /api/hooks/session-end

Called at session end. Triggers memory extraction from the transcript.
Releases the session's runtime path claim.

**Request body**

```json
{
  "harness": "claude-code",
  "sessionKey": "session-uuid",
  "sessionId": "session-uuid",
  "transcriptPath": "/tmp/signet/session-transcript.txt",
  "runtimePath": "plugin"
}
```

`harness` is required.
`transcriptPath` or inline `transcript` may be provided for transcript
capture. Signet stores a cleaned conversation-only transcript in memory
surfaces and may retain raw auditable traces separately in daemon logs.

When transcript text is available, the daemon first writes canonical
workspace-root-relative markdown lineage files under
`$SIGNET_WORKSPACE/memory/`:

- `{captured_at}--{session_token}--transcript.md`
- `{captured_at}--{session_token}--manifest.md`

The manifest is mutable and may later gain a `compaction_path`; transcript
artifacts are immutable once written. The async summary worker later writes the
matching immutable `--summary.md` artifact for normal `session-end` jobs.

### POST /api/hooks/remember

Explicit memory save from within a session. Requires `remember` permission.

**Request body**

```json
{
  "harness": "claude-code",
  "content": "User wants dark mode by default",
  "sessionKey": "session-uuid",
  "runtimePath": "plugin"
}
```

`harness` and `content` are required.

### POST /api/hooks/recall

Explicit memory query from within a session. Requires `recall` permission.

**Request body**

```json
{
  "harness": "claude-code",
  "query": "user UI preferences",
  "keywordQuery": "\"dark mode\" OR theme",
  "project": "/workspace/repo",
  "limit": 5,
  "type": "preference",
  "tags": "ui,editor",
  "who": "claude-code",
  "since": "2026-01-01T00:00:00Z",
  "until": "2026-04-01T00:00:00Z",
  "expand": true,
  "sessionKey": "session-uuid",
  "runtimePath": "plugin"
}
```

`harness` and `query` are required.

This route is a hook-oriented wrapper around `POST /api/memory/recall`. It
accepts a narrower request surface, applies hook/session policy checks, and
then forwards the supported recall filters into the shared hybrid recall path.

`project` on this route is forwarded as the memory `project` filter. It is not
remapped to recall `scope`.

**Response**

Same recall-family shape as `POST /api/memory/recall`, plus legacy
compatibility fields during the transition period:

```json
{
  "results": [],
  "memories": [],
  "count": 0,
  "query": "user UI preferences",
  "method": "hybrid",
  "meta": {
    "totalReturned": 0,
    "hasSupplementary": false,
    "noHits": true
  },
  "message": "No matching memories found."
}
```

Special no-op cases preserve the same shape and add a flag:

- `{ ..., "bypassed": true }` when the session is bypassed
- `{ ..., "internal": true }` for internal no-hook calls

`memories` and `count` are legacy compatibility aliases for older hook
consumers and will mirror `results` and `results.length` during the
transition period. `message` is the canonical formatted recall brief used by
thin harness hooks so connectors do not reimplement ranking or presentation
rules.

### POST /api/hooks/pre-compaction

Called before context window compaction. Returns summary instructions for
the compaction prompt.

**Request body**

```json
{
  "harness": "claude-code",
  "sessionKey": "session-uuid",
  "runtimePath": "plugin"
}
```

`harness` is required.

### POST /api/hooks/compaction-complete

Save a compaction summary as a memory row, as a temporal DAG artifact, and as a
canonical immutable markdown compaction artifact linked back through the
session manifest.

**Request body**

```json
{
  "harness": "claude-code",
  "summary": "Session covered dark mode setup and vim configuration...",
  "sessionKey": "session-uuid",
  "project": "/workspace/repo",
  "runtimePath": "plugin"
}
```

`harness` and `summary` are required.

If `sessionKey` is present, the daemon uses it to preserve lineage:

- the memory row is agent-scoped
- `source_id` points back to the session lineage
- the temporal node keeps `session_key`
- the artifact can later be expanded through the temporal drill-down API
- transcript and temporal summary persistence are keyed by `agentId +
  sessionKey`, so identical session keys from different agents do not collide
- the canonical compaction file is written to
  `memory/{captured_at}--{session_token}--compaction.md`
- the mutable manifest for that session is backfilled with `compaction_path`

If compaction fires before transcript persistence lands, callers should also
send `project`. The daemon uses that explicit project as the fallback lineage
scope until transcript storage catches up.

**Response**

```json
{ "success": true, "memoryId": "uuid" }
```

### POST /api/hooks/session-checkpoint-extract

Trigger a mid-session memory extraction for long-lived sessions (Discord bots,
persistent agents) that never call `session-end`. Computes a delta since the
last extraction cursor and enqueues a summary job without releasing the session
claim.

**Request body**

```json
{
  "harness": "openclaw",
  "sessionKey": "session-uuid",
  "agentId": "agent-id",
  "project": "/workspace/repo",
  "transcriptPath": "/path/to/session.jsonl",
  "runtimePath": "plugin"
}
```

`harness` and `sessionKey` are required. `transcript` (inline string) takes
precedence over `transcriptPath`; both fall back to the stored session
transcript from a prior `session-end` or `user-prompt-submit` call.

The endpoint skips silently when:
- The delta since the last extraction cursor is < 500 characters
- No transcript is available
- The session is bypassed

On success the extraction cursor advances so the next call only processes
new content.

**Response**

```json
{ "queued": true, "jobId": "uuid" }
```

`queued: true` means a summary job was enqueued; `jobId` identifies the
async job. The job extracts the delta and writes a temporal node scored
at 0.85 (below compaction summaries at 0.95, above chunks at 0.55). Checkpoint
jobs stay DB-native, they do not create canonical `--summary.md` session
artifacts.

```json
{ "skipped": true }
```

Returned when delta < 500 chars, no transcript is available, or the
session is bypassed.

```json
{ "queued": false }
```

Returned by daemon implementations where summary job enqueueing is not
yet available (Phase 5). The delta was found and is above the threshold
but no job was enqueued. Callers may treat this identically to
`{skipped: true}` for retry purposes — the content is not consumed and
will be re-evaluated on the next call.

### GET /api/hooks/synthesis/config

Return the current synthesis configuration (thresholds, model, schedule).

### POST /api/hooks/synthesis

Request a `MEMORY.md` synthesis run. Implementation-defined request body
and response from `handleSynthesisRequest`.

Current `MEMORY.md` generation is a deterministic projection, not a free-form
LLM rewrite:

- scored durable memories come from the memory database
- rolling session-ledger rows come from canonical artifact frontmatter in
  `memory_artifacts`
- temporal context comes from `session_summaries` DAG artifacts
- the response keeps the rendered markdown in `prompt` for backward
  compatibility, with `model: "projection"`
- `indexBlock` contains the exact `## Temporal Index` block already included in
  the rendered projection

The rendered file contains these required sections:

- `## Global Head (Tier 1)`
- `## Thread Heads (Tier 2)`
- `## Session Ledger (Last 30 Days)`
- `## Open Threads`
- `## Durable Notes & Constraints`
- `## Temporal Index`

Optional `agentId` / `sessionKey` inputs may be provided so synthesis resolves
the correct agent-scoped head.

### POST /api/hooks/synthesis/complete

Write a newly synthesized `MEMORY.md`. Backs up the existing file before
overwriting and records DB-backed head metadata used for same-agent
merge protection.

**Request body**

```json
{
  "content": "# Memory\n\n...",
  "agentId": "optional-agent-id",
  "sessionKey": "optional-session-key"
}
```

`content` is required.

If another writer currently holds the active `MEMORY.md` lease for the same
agent head, this route returns `409`.

**Response**

```json
{ "success": true }
```


Sessions
--------

The sessions API exposes active session state, including per-session bypass
toggles. When bypass is enabled for a session, all hook endpoints return
empty no-op responses with `bypassed: true` — but MCP tools (memory_search,
memory_store, etc.) continue to work normally.

### GET /api/sessions

List active sessions for the requesting agent with their bypass status.
The response merges live tracker claims with live cross-agent presence so
sessions do not disappear just because one surface has not claimed the
session yet. Results are scoped to the authenticated agent; for
cross-agent visibility use `GET /api/cross-agent/presence`.

**Response**

```json
{
  "sessions": [
    {
      "key": "session-uuid",
      "runtimePath": "plugin",
      "claimedAt": "2026-03-08T10:00:00.000Z",
      "expiresAt": "2026-03-08T14:00:00.000Z",
      "bypassed": false
    }
  ],
  "count": 1
}
```

### GET /api/sessions/:key

Get a single session's status by its session key.

Both raw keys (`abc123`) and prefixed keys (`session:abc123`) are accepted.

**Response**

```json
{
  "key": "session-uuid",
  "runtimePath": "plugin",
  "claimedAt": "2026-03-08T10:00:00.000Z",
  "expiresAt": "2026-03-08T14:00:00.000Z",
  "bypassed": false
}
```

Returns `404` if the session key is not found.

### GET /api/sessions/summaries

List temporal summary nodes used for drill-down and `MEMORY.md` synthesis.
Results are agent-scoped.

**Response**

```json
{
  "summaries": [
    {
      "id": "sess-1",
      "kind": "session",
      "depth": 0,
      "source_type": "summary",
      "source_ref": "session-uuid",
      "meta_json": "{\"source\":\"summary-worker\"}"
    }
  ]
}
```

### POST /api/sessions/summaries/expand

Expand a temporal node by id. Returns lineage, linked memories, and transcript
context for `MEMORY.md` drill-down and LCM-style expansion. Expansion is
agent-scoped.

**Request body**

```json
{
  "id": "node-id",
  "includeTranscript": true,
  "transcriptCharLimit": 2000
}
```

**Response**

```json
{
  "node": {
    "id": "node-id",
    "kind": "session",
    "depth": 0,
    "sourceType": "summary"
  },
  "parents": [],
  "children": [],
  "linkedMemories": [],
  "transcript": {
    "sessionKey": "session-uuid",
    "excerpt": "..."
  }
}
```

### POST /api/sessions/:key/bypass

Toggle bypass for a session. When enabled, all hook endpoints for this session
return empty no-op responses with `bypassed: true`. MCP tools are not affected.
Both raw keys and `session:<uuid>` forms are accepted.

**Request body**

```json
{
  "enabled": true
}
```

`enabled` is required (boolean).

**Response**

```json
{
  "key": "session-uuid",
  "bypassed": true
}
```

Returns `404` if the session key is not found.


Git
---

The git API manages automatic commit and sync of the `$SIGNET_WORKSPACE/` directory.
Config is loaded from `agent.yaml` under the `git` key. Defaults: `autoCommit:
true`, `autoSync: true`, `syncInterval: 300s`, `remote: origin`,
`branch: main`.

### GET /api/git/status

Return git status for the agents directory.

**Response** — output of `getGitStatus()` including `branch`, `ahead`,
`behind`, `dirty`, `lastCommit`.

### POST /api/git/pull

Pull from the configured remote and branch.

**Response** — result of `gitPull()` including `success`, `output`, `error`.

### POST /api/git/push

Push the current branch to the configured remote.

**Response** — result of `gitPush()`.

### POST /api/git/sync

Pull then push — equivalent to running both operations in sequence.

**Response** — result of `gitSync()`.

### GET /api/git/config

Return the current in-memory git configuration.

**Response**

```json
{
  "enabled": true,
  "autoCommit": true,
  "autoSync": true,
  "syncInterval": 300,
  "remote": "origin",
  "branch": "main"
}
```

### POST /api/git/config

Update runtime git configuration. Changes take effect immediately; the sync
timer is restarted if `autoSync` or `syncInterval` changes.

**Request body** (all fields optional)

```json
{
  "autoSync": true,
  "syncInterval": 600,
  "remote": "origin",
  "branch": "main"
}
```

**Response**

```json
{ "success": true, "config": { ... } }
```


Update
------

The update system checks GitHub releases and the npm registry, then optionally
auto-installs using the detected package manager.

### GET /api/update/check

Check for a newer version. Results are cached for 1 hour unless `?force=true`
is passed.

**Query parameters**

| Parameter | Description                         |
|-----------|-------------------------------------|
| `force`   | `true` — bypass 1-hour cache        |

**Response**

```json
{
  "currentVersion": "0.1.69",
  "latestVersion": "0.1.70",
  "updateAvailable": true,
  "releaseUrl": "https://github.com/Signet-AI/signetai/releases/tag/v0.1.70",
  "releaseNotes": "...",
  "publishedAt": "2026-02-20T12:00:00Z",
  "restartRequired": false,
  "pendingVersion": null,
  "cached": false,
  "checkedAt": "2026-02-21T10:00:00.000Z"
}
```

### GET /api/update/config

Return current update configuration and runtime state.

**Response**

```json
{
  "autoInstall": false,
  "checkInterval": 21600,
  "minInterval": 300,
  "maxInterval": 604800,
  "pendingRestartVersion": null,
  "lastAutoUpdateAt": null,
  "lastAutoUpdateError": null,
  "updateInProgress": false
}
```

### POST /api/update/config

Modify auto-update settings. Changes are persisted to `agent.yaml`.

**Request body** (all fields optional)

```json
{
  "autoInstall": true,
  "checkInterval": 43200
}
```

`checkInterval` must be between 300 and 604800 seconds.

**Response**

```json
{
  "success": true,
  "config": { "autoInstall": true, "checkInterval": 43200 },
  "persisted": true,
  "pendingRestartVersion": null,
  "lastAutoUpdateAt": null,
  "lastAutoUpdateError": null
}
```

### POST /api/update/run

Install the latest version immediately. Runs the global install command for
the detected package manager. A daemon restart is required to activate the
update.

**Response**

```json
{
  "success": true,
  "message": "Update installed. Restart daemon to apply.",
  "output": "...",
  "installedVersion": "0.1.70",
  "restartRequired": true
}
```

If already up to date, returns `success: true` with a message indicating no
update is needed.


Diagnostics
-----------

Requires `diagnostics` permission.

### GET /api/diagnostics

Full diagnostic report across all domains. Includes a composite health score
derived from database health, pipeline state, embedding availability, and
mutation integrity.

**Response** — a multi-domain report object. Domains include `database`,
`pipeline`, `embedding`, `mutation`, `fts`, and `composite`. The `composite`
field looks like:

```json
{ "score": 0.95, "status": "healthy" }
```

### GET /api/diagnostics/:domain

Diagnostic data for a single domain. Known domains: `database`, `pipeline`,
`embedding`, `mutation`, `fts`, `composite`.

Returns `400` for unknown domains.


Repair
------

Administrative repair operations. All require `admin` permission. Operations
are rate-limited internally by the repair limiter and return `429` when the
limit is exceeded.

### POST /api/repair/requeue-dead

Requeue extraction jobs stuck in a terminal-failed state. Typically used
after resolving a pipeline configuration issue.

**Response**

```json
{ "action": "requeueDeadJobs", "success": true, "affected": 12, "message": "..." }
```

### POST /api/repair/release-leases

Release stale pipeline job leases that have exceeded their timeout. Run this
if pipeline workers crashed and left jobs locked. Stale jobs that still have
remaining retries are returned to `pending`. Stale jobs that have already
reached `max_attempts` are moved to `dead` instead of being requeued again.

**Response**

```json
{
  "action": "releaseStaleLeases",
  "success": true,
  "affected": 3,
  "message": "released 2 stale lease(s) back to pending and dead-lettered 1 exhausted job(s)"
}
```

### POST /api/repair/check-fts

Check FTS5 index consistency against the memories table and detect legacy
tokenizer drift. Optionally repair mismatches by rebuilding the index or
recreating `memories_fts` with the canonical `unicode61` tokenizer.

**Request body** (optional)

```json
{ "repair": true }
```

**Response**

```json
{ "action": "checkFtsConsistency", "success": true, "affected": 0, "message": "..." }
```

### POST /api/repair/retention-sweep

Trigger a manual retention decay sweep. This endpoint is currently not wired
to the pipeline worker and returns `501`.

**Response**

```json
{
  "action": "triggerRetentionSweep",
  "success": false,
  "affected": 0,
  "message": "Use the maintenance worker for automated sweeps..."
}
```

### GET /api/repair/embedding-gaps

Returns the count of memories that are missing vector embeddings.
Requires `admin` permission.

**Response**

```json
{
  "unembedded": 42,
  "total": 1200,
  "coverage": "96.5%"
}
```

### POST /api/repair/re-embed

Batch re-embeds memories that are missing vector embeddings. Processes
up to `batchSize` memories per call. Requires `admin` permission.
Rate-limited — returns `429` when the limit is exceeded.

**Request body**

```json
{
  "batchSize": 50,
  "dryRun": false
}
```

`batchSize` defaults to `50`. `dryRun: true` reports what would be
embedded without calling the embedding provider.

**Response**

```json
{
  "action": "reEmbedMissingVectors",
  "success": true,
  "affected": 42,
  "message": "re-embedded 42 memories"
}
```

### POST /api/repair/clean-orphans

Remove embedding rows that reference memories which no longer exist.
Rate-limited. Requires `admin` permission.

**Response**

```json
{
  "action": "cleanOrphanedEmbeddings",
  "success": true,
  "affected": 12,
  "message": "cleaned 12 orphaned embeddings"
}
```

### GET /api/repair/dedup-stats

Returns statistics on potential duplicate memories (by content hash).
Requires `admin` permission.

**Response** — object with duplicate counts and affected memory IDs.

### POST /api/repair/deduplicate

Deduplicate memories by content hash and optionally by semantic similarity.
Rate-limited. Requires `admin` permission.

**Request body**

```json
{
  "batchSize": 50,
  "dryRun": false,
  "semanticEnabled": false,
  "semanticThreshold": 0.95
}
```

All fields are optional. `dryRun: true` reports what would be deduplicated
without making changes. `semanticEnabled` adds vector-similarity dedup on
top of hash-based dedup.

**Response**

```json
{
  "action": "deduplicateMemories",
  "success": true,
  "affected": 7,
  "message": "deduplicated 7 memories"
}
```


Pipeline
--------

### GET /api/pipeline/status

Composite pipeline status snapshot for dashboard visualization. Returns
worker status, job queue counts (memory and summary), diagnostics, latency
histograms, error summary, and the current pipeline mode.

Known `mode` values: `controlled-write`, `shadow`, `frozen`, `paused`,
`disabled`.

**Response**

```json
{
  "workers": { ... },
  "queues": {
    "memory": { "pending": 3, "leased": 1, "completed": 200, "failed": 0, "dead": 0 },
    "summary": { "pending": 0, "leased": 0, "completed": 5, "failed": 0, "dead": 0 }
  },
  "diagnostics": { ... },
  "latency": { ... },
  "errorSummary": { ... },
  "mode": "controlled-write"
}
```

Mode is one of: `disabled`, `frozen`, `shadow`, `paused`, `controlled-write`.

### POST /api/pipeline/pause

Pause the extraction runtime in-place without restarting the daemon.
Requires `admin` permission and uses the admin rate limit bucket.

Returns `409` if another pause/resume transition is already running.

**Response**

```json
{
  "success": true,
  "changed": true,
  "paused": true,
  "file": "/home/user/.agents/agent.yaml",
  "mode": "paused"
}
```

### POST /api/pipeline/resume

Resume the extraction runtime in-place without restarting the daemon.
Requires `admin` permission and uses the admin rate limit bucket.

**Response**

```json
{
  "success": true,
  "changed": true,
  "paused": false,
  "file": "/home/user/.agents/agent.yaml",
  "mode": "controlled-write"
}
```

`changed` is `false` when the persisted pause flag already matches the
requested state.


Knowledge graph navigation
--------------------------

Signet exposes the structured memory graph as a navigable hierarchy for agents.
Search discovers unknown paths; navigation inspects known paths without loading
the full constellation graph.

```text
Entity -> Aspect -> Group -> ClaimKey -> Attributes
```

The house/filesystem analogy is intentional: entities are houses or top-level
folders, aspects are rooms, groups are dressers, claim keys are drawers, and
attributes are notes inside those drawers.

All routes accept optional `agent_id` and default to `default`.

### GET /api/knowledge/navigation/entities

List entities with structural counts. Query parameters: `q`, `type`, `limit`,
`offset`.

### GET /api/knowledge/navigation/entity

Resolve one entity by name.

```text
/api/knowledge/navigation/entity?name=Nicholai
```

### GET /api/knowledge/navigation/tree

Return a compact entity outline for agent browsing. The tree includes aspects,
groups, claim slots, counts, and active previews so agents can decide where to
drill next without loading the full constellation graph. Query parameters:
`entity`, `depth`, `max_aspects`, `max_groups`, `max_claims`.

Depth controls how far the outline expands: `1` returns aspects, `2` returns
aspects and groups, and `3` returns aspects, groups, and claim slots.

```text
/api/knowledge/navigation/tree?entity=Nicholai&depth=3
```

### GET /api/knowledge/navigation/aspects

List aspects for an entity.

```text
/api/knowledge/navigation/aspects?entity=Nicholai
```

### GET /api/knowledge/navigation/groups

List groups under an entity aspect. Attributes without `group_key` appear under
`general` for backward compatibility.

```text
/api/knowledge/navigation/groups?entity=Nicholai&aspect=food
```

### GET /api/knowledge/navigation/claims

List claim slots under an entity/aspect/group path.

```text
/api/knowledge/navigation/claims?entity=Nicholai&aspect=food&group=restaurants
```

### GET /api/knowledge/navigation/attributes

List attributes under an entity/aspect/group/claim path. Defaults to
`status=active`; pass `status=all` to include superseded history. Query
parameters: `entity`, `aspect`, `group`, `claim`, `status`, `kind`, `limit`,
`offset`.

```text
/api/knowledge/navigation/attributes?entity=Nicholai&aspect=food&group=restaurants&claim=favorite_restaurant
```

CLI equivalents:

```bash
signet knowledge tree Nicholai
signet knowledge entities --query Nicholai
signet knowledge entity Nicholai
signet knowledge aspects Nicholai
signet knowledge groups Nicholai food
signet knowledge claims Nicholai food restaurants
signet knowledge attributes Nicholai food restaurants favorite_restaurant
signet knowledge attributes Nicholai food restaurants favorite_restaurant --status all
signet knowledge hygiene
```

### GET /api/knowledge/hygiene

Return a report-only graph hygiene scan. Query parameters: `agent_id`, `limit`,
and `memory_limit`.

The response includes suspicious entities, duplicate canonical entity groups,
attribute rows missing `group_key` or `claim_key`, attributes without source
memories, and safe mention-link candidates where an existing entity name appears
in a memory that is not yet linked. This endpoint does not mutate graph data.

MCP exposes the same report as `knowledge_hygiene_report`.


Dreaming
--------

Dreaming is a periodic knowledge-graph consolidation process that uses a
smart model to merge, prune, and enrich the entity graph.

### GET /api/dream/status

Return the current dreaming worker state, configuration, and recent passes.
Requires `admin` permission.

**Query parameters**

| Parameter | Type   | Required | Description         |
|-----------|--------|----------|---------------------|
| `agentId` | string | no       | Agent ID (default: `"default"`) |

**Response**

```json
{
  "enabled": true,
  "worker": { "running": true, "active": false },
  "state": {
    "tokensSinceLastPass": 42000,
    "lastPassAt": "2026-04-01T12:00:00.000Z",
    "lastPassId": "abc-123",
    "lastPassMode": "incremental"
  },
  "config": {
    "tokenThreshold": 100000,
    "backfillOnFirstRun": true,
    "maxInputTokens": 128000,
    "maxOutputTokens": 16000,
    "timeout": 300000
  },
  "passes": [
    {
      "id": "pass-uuid",
      "mode": "incremental",
      "status": "completed",
      "startedAt": "2026-04-01T12:00:00.000Z",
      "completedAt": "2026-04-01T12:05:00.000Z",
      "tokensConsumed": 8000,
      "mutationsApplied": 12,
      "mutationsSkipped": 3,
      "mutationsFailed": 1,
      "summary": "Merged 3 duplicate entities, pruned 5 junk attributes",
      "error": null
    }
  ]
}
```

### POST /api/dream/trigger

Manually trigger a dreaming pass. Requires `admin` permission.
Returns `202 Accepted` immediately and runs the pass in the background
(passes can take up to several minutes on large graphs).
Returns 409 if a pass is already running. Returns 503 if the
dreaming worker is not started.

Poll `GET /api/dream/status` and check `passes[0].status` for completion.

**Request body**

```json
{
  "mode": "incremental"
}
```

`mode` is `"incremental"` (default) or `"compact"`.

**Response** — `202 Accepted`

```json
{
  "accepted": true,
  "passId": "pass-uuid",
  "status": "running",
  "mode": "incremental"
}
```


Checkpoints
-----------

Session checkpoints track continuity state at compaction boundaries.

### GET /api/checkpoints

List session checkpoints for a project.

**Query parameters**

| Parameter | Type   | Required | Description                          |
|-----------|--------|----------|--------------------------------------|
| `project` | string | yes      | Project path to filter by            |
| `limit`   | integer | no      | Max results (default: 10, max: 100)  |

**Response**

```json
{
  "checkpoints": [
    {
      "session_key": "abc-123",
      "project": "/path/to/project",
      "trigger": "periodic",
      "created_at": "2026-02-21T10:00:00.000Z"
    }
  ],
  "count": 1
}
```

### GET /api/checkpoints/:sessionKey

Get all checkpoints for a specific session.

**Response**

```json
{
  "checkpoints": [ ... ],
  "count": 3
}
```


Analytics
---------

Requires `analytics` permission.

### GET /api/analytics/usage

Aggregate request counts, memory operation totals, and per-endpoint hit
counts collected since daemon start.

**Response** — collector-defined usage summary object.

### GET /api/analytics/errors

Recent error events from the analytics collector.

**Query parameters**

| Parameter | Description                                   |
|-----------|-----------------------------------------------|
| `stage`   | Filter by pipeline stage (e.g., `mutation`)   |
| `since`   | ISO timestamp — only errors after this time   |
| `limit`   | Max errors to return                          |

**Response**

```json
{
  "errors": [ { "stage": "mutation", "message": "...", "at": "..." } ],
  "summary": { "total": 5, "byStage": { "mutation": 5 } }
}
```

### GET /api/analytics/latency

Latency histograms for key operation groups: `remember`, `recall`, `mutate`.

**Response** — collector-defined latency object with p50/p95/p99 per group.

### GET /api/analytics/logs

Recent structured log entries. Same data as `GET /api/logs` but namespaced
under analytics.

**Query parameters**

| Parameter  | Description                                           |
|------------|-------------------------------------------------------|
| `limit`    | Max log entries (default: 100)                        |
| `level`    | `debug`, `info`, `warn`, or `error`                   |
| `category` | Filter by log category (e.g., `memory`, `pipeline`)   |
| `since`    | ISO timestamp lower bound                             |

**Response**

```json
{ "logs": [...], "count": 47 }
```

### GET /api/analytics/memory-safety

Combined view of mutation diagnostics and recent mutation errors. Useful for
auditing data integrity.

**Response**

```json
{
  "mutation": { ... },
  "recentErrors": [ ... ],
  "errorSummary": { ... }
}
```

### GET /api/analytics/continuity

Session continuity scores over time. Tracks how well memory injection
maintains context across sessions.

**Query parameters**

| Parameter | Type    | Description                                    |
|-----------|---------|------------------------------------------------|
| `project` | string | Filter by project path (optional)              |
| `limit`   | integer | Max scores to return (default: 50)             |

**Response**

```json
{
  "scores": [
    {
      "id": "uuid",
      "session_key": "abc-123",
      "project": "/path/to/project",
      "harness": "claude-code",
      "score": 0.85,
      "memories_recalled": 12,
      "memories_used": 8,
      "novel_context_count": 3,
      "reasoning": "...",
      "created_at": "2026-02-21T10:00:00.000Z"
    }
  ],
  "summary": {
    "count": 50,
    "average": 0.78,
    "trend": 0.05,
    "latest": 0.85
  }
}
```

### GET /api/analytics/continuity/latest

Latest continuity score per project. Returns one row per project, ordered
by most recent.

**Response**

```json
{
  "scores": [
    { "project": "/path/to/project", "score": 0.85, "created_at": "2026-02-21T10:00:00.000Z" }
  ]
}
```


Telemetry
---------

Telemetry endpoints expose local-only event data collected by the daemon.
No data is sent externally. If telemetry is disabled, endpoints return
`enabled: false`.

### GET /api/telemetry/events

Query raw telemetry events.

**Query parameters**

| Parameter | Type    | Description                                    |
|-----------|---------|------------------------------------------------|
| `event`   | string  | Filter by event type (e.g., `llm.generate`)    |
| `since`   | string  | ISO timestamp lower bound                      |
| `until`   | string  | ISO timestamp upper bound                      |
| `limit`   | integer | Max events (default: 100)                      |

**Response**

```json
{
  "events": [
    {
      "event": "llm.generate",
      "properties": { "inputTokens": 500, "outputTokens": 200, "durationMs": 1200 },
      "timestamp": "2026-02-21T10:00:00.000Z"
    }
  ],
  "enabled": true
}
```

Inference emits additional local-first telemetry events:

- `inference.route`
- `inference.execute`
- `inference.stream`
- `inference.fallback`

These events intentionally exclude raw prompts, response text, secrets,
credentials, and session references.

### GET /api/telemetry/stats

Aggregated telemetry statistics since daemon start or since a given timestamp.

**Query parameters**

| Parameter | Type   | Description                           |
|-----------|--------|---------------------------------------|
| `since`   | string | ISO timestamp lower bound (optional)  |

**Response**

```json
{
  "enabled": true,
  "totalEvents": 500,
  "llm": {
    "calls": 120,
    "errors": 2,
    "totalInputTokens": 60000,
    "totalOutputTokens": 24000,
    "totalCost": 0.45,
    "p50": 800,
    "p95": 2400
  },
  "inference": {
    "routes": 40,
    "executes": 18,
    "streams": 4,
    "errors": 3,
    "cancelled": 1,
    "fallbacks": 5,
    "p50": 120,
    "p95": 900
  },
  "pipelineErrors": 3
}
```

### GET /api/telemetry/export

Export raw telemetry events as newline-delimited JSON (NDJSON).

**Query parameters**

| Parameter | Type    | Description                           |
|-----------|---------|---------------------------------------|
| `since`   | string  | ISO timestamp lower bound (optional)  |
| `limit`   | integer | Max events (default: 10000)           |

**Response** — `Content-Type: application/x-ndjson`. Each line is a
JSON-serialized telemetry event. Returns `404` if telemetry is not enabled.


Timeline
--------

Requires `analytics` permission.

### GET /api/timeline/:id

Build a chronological timeline for a memory entity, combining mutation
history, log events, and errors associated with the given ID.

**Response** — timeline object with ordered events from `buildTimeline()`.

### GET /api/timeline/:id/export

Same as `GET /api/timeline/:id` but wraps the result in an export envelope
with version and timestamp metadata.

**Response**

```json
{
  "meta": {
    "version": "0.1.69",
    "exportedAt": "2026-02-21T10:00:00.000Z",
    "entityId": "uuid"
  },
  "timeline": { ... }
}
```


Logs
----

### GET /api/logs

Return recent structured log entries from the in-memory log buffer.

**Query parameters**

| Parameter  | Description                                           |
|------------|-------------------------------------------------------|
| `limit`    | Max entries (default: 100)                            |
| `level`    | Minimum level: `debug`, `info`, `warn`, `error`       |
| `category` | Filter by category string                             |
| `since`    | ISO timestamp — only logs after this time             |

**Response**

```json
{ "logs": [...], "count": 100 }
```

### GET /api/logs/stream

Server-Sent Events stream of live log output. Each event is a JSON-serialized
`LogEntry`. The connection sends an initial `{"type":"connected"}` event and
then emits entries in real time as the daemon generates them.

```
Content-Type: text/event-stream
Cache-Control: no-cache
Connection: keep-alive
```

Each SSE event:

```
data: {"level":"info","category":"memory","message":"Memory saved","at":"..."}
```

The stream stays open until the client disconnects.


MCP Server
----------

### ALL /mcp

Model Context Protocol endpoint using Streamable HTTP transport (stateless).
Supports POST (send messages), GET (SSE stream), and DELETE (session teardown).

Exposes memory tools: `memory_search`, `memory_store`, `memory_get`,
`memory_list`, `memory_modify`, `memory_forget`. See `docs/MCP.md` for full
tool documentation.

**POST /mcp** — Send MCP JSON-RPC messages. Returns JSON or SSE stream.

**GET /mcp** — Open an SSE stream for server-initiated notifications.

**DELETE /mcp** — Terminate MCP session (no-op in stateless mode).


Scheduled Tasks
----------------

### GET /api/tasks

List all scheduled tasks with their last run status.

**Response**

```json
{
  "tasks": [{
    "id": "uuid",
    "name": "Review open PRs",
    "prompt": "Review all open pull requests",
    "cron_expression": "0 9 * * *",
    "harness": "claude-code",
    "working_directory": "/path/to/project",
    "enabled": 1,
    "last_run_at": "2026-02-23T09:00:00Z",
    "next_run_at": "2026-02-24T09:00:00Z",
    "last_run_status": "completed",
    "last_run_exit_code": 0
  }],
  "presets": [
    {"label": "Every 15 min", "expression": "*/15 * * * *"},
    {"label": "Hourly", "expression": "0 * * * *"},
    {"label": "Daily 9am", "expression": "0 9 * * *"},
    {"label": "Weekly Mon 9am", "expression": "0 9 * * 1"}
  ]
}
```

### POST /api/tasks

Create a new scheduled task.

**Request body**

```json
{
  "name": "Review open PRs",
  "prompt": "Review all open pull requests and summarize findings",
  "cronExpression": "0 9 * * *",
  "harness": "claude-code",
  "workingDirectory": "/path/to/project"
}
```

**Response** (201)

```json
{"id": "uuid", "nextRunAt": "2026-02-24T09:00:00Z"}
```

### GET /api/tasks/:id

Get a single task with its 20 most recent runs.

### PATCH /api/tasks/:id

Update a task's name, prompt, cron, harness, working directory, or enabled state.

### DELETE /api/tasks/:id

Delete a task and all its run history (cascade).

### POST /api/tasks/:id/run

Trigger an immediate manual run. Returns 202 with `runId`. Returns 409 if
the task already has a running execution. Skill usage analytics are
attributed using non-breaking task scope hints when available.

### GET /api/tasks/:id/runs

Paginated run history. Supports `limit` and `offset` query parameters.

### GET /api/tasks/:id/stream

Server-Sent Events stream of live task output. Replays buffered output on
connect, then streams new events in real time. Sends keepalive comments
every 15 seconds.

**Event types**

| Type           | Description                              |
|----------------|------------------------------------------|
| `connected`    | Initial connection confirmation           |
| `run-started`  | A run has begun (includes `runId`)        |
| `run-output`   | Stdout or stderr chunk (`stream` field)   |
| `run-completed`| Run finished (includes `exitCode`)        |

```
Content-Type: text/event-stream
Cache-Control: no-cache
Connection: keep-alive
```


Dashboard
---------

### GET /

Serves the SvelteKit dashboard as a single-page application. Static files are
served from the built dashboard directory. Any path without a file extension
falls back to `index.html` for client-side routing.

If the dashboard build is not found, a minimal HTML fallback page is served
with links to key API endpoints.

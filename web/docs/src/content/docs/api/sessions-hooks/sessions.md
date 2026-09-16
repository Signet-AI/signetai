---
title: "Session endpoints"
description: "Session status, renewal, bypass, transcript, and replay endpoints."
---

## Sessions

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

### POST /api/sessions/:key/renew

Renew the authenticated agent's live session claim. This is an externally
registered daemon route. Authorization comes from authenticated agent and scope
resolution; renewal does not require a separately named `recall` or `remember`
permission. The route accepts raw keys (`abc123`) and prefixed keys
(`session:abc123`). The optional `agent_id` query parameter selects an
authorized agent scope; without it, the request uses the authenticated default
scope.

A session with a finite lease gets a new expiry and returns:

```json
{
  "key": "session-uuid",
  "renewed": true,
  "expiresAt": "2026-03-08T14:00:00.000Z"
}
```

Sessions without a finite lease refresh agent presence and omit `expiresAt`:

```json
{ "key": "session-uuid", "renewed": true }
```

The route returns `403` when the requested agent scope is not authorized, and
`404` when the session is missing, expired, or cannot be renewed.

The session hooks also renew claims internally during lifecycle processing. For
example, checkpoint extraction calls the session tracker directly; that
lifecycle renewal is not a second HTTP route.

### GET /api/sessions/:key/transcript

Return the canonical cleaned transcript for a session. Results are scoped to
the authenticated agent; pass `agent_id` only when calling with an authorized
agent scope.

Both raw keys (`abc123`) and prefixed keys (`session:abc123`) are accepted.

**Response**

```json
{
  "sessionKey": "session-uuid",
  "agentId": "default",
  "content": "User: ...\nAssistant: ..."
}
```

Returns `404` if no transcript exists for that session and agent scope.

### GET /api/sessions/blackbox

List sessions with replayable Black Box evidence for the requesting agent.
This is a dashboard-oriented flight recorder index assembled from existing
recall telemetry, context injection events, source artifacts, and epistemic
assertions. Results are scoped to the authenticated agent and may be narrowed
with `project`.

**Query parameters**

- `agent_id` / `agentId` — optional scoped agent selector when authorized.
- `project` — optional project path filter.
- `limit` — optional maximum session count.

**Response**

```json
{
  "agentId": "default",
  "sessions": [
    {
      "sessionKey": "session-uuid",
      "agentId": "default",
      "project": "/workspace/repo",
      "lastAt": "2026-03-08T10:00:00.000Z",
      "recallEvents": 3,
      "artifactEvents": 1
    }
  ],
  "count": 1
}
```

### GET /api/sessions/:key/blackbox

Return a session-scoped Black Box replay for a specific session key. The replay
preserves the raw session key supplied by the caller so persisted `session:`
prefixes continue to resolve. It explains what evidence was visible to Signet
at each point in the session; it does not claim deterministic model causality.

**Query parameters**

- `agent_id` / `agentId` — optional scoped agent selector when authorized.
- `project` — optional project path filter. When present, unprojected recall
  context rows are omitted unless they can be joined through project artifacts.

**Response**

```json
{
  "sessionKey": "session-uuid",
  "agentId": "default",
  "generatedAt": "2026-03-08T10:05:00.000Z",
  "eventCount": 2,
  "events": [
    {
      "id": "telemetry:abc:query",
      "kind": "recall.requested",
      "at": "2026-03-08T10:00:00.000Z",
      "title": "Recall requested",
      "detail": "dashboard provenance",
      "refs": [],
      "payload": {
        "route": "/api/memory/recall",
        "resultCount": 3
      }
    }
  ],
  "frame": {
    "at": "2026-03-08T10:00:00.000Z",
    "activeRefCount": 0,
    "activeRefs": [],
    "likelyInfluences": [],
    "warnings": []
  }
}
```

`events[].kind` is one of `recall.requested`, `recall.result`,
`context.recalled`, `artifact.written`, or `assertion.created`.

### POST /api/sessions/search

Search active or completed session transcripts. This route powers the
`session_search` MCP tool and is intended for sub-agents that need to inspect
the parent session without forcing a large token snapshot into every spawn.
Results are agent-scoped and require `recall` permission.

**Request body**

```json
{
  "query": "Juniper trunk ports",
  "sessionKey": "optional-specific-session",
  "currentSessionKey": "agent:nicholai:subagent:abc123",
  "agentId": "nicholai",
  "project": "/workspace/repo",
  "limit": 5
}
```

`query` is required. `limit` is clamped to `1..20`. If `sessionKey` is absent
and `currentSessionKey` encodes OpenClaw sub-agent lineage, Signet defaults the
search to the inferred parent session. Otherwise, Signet searches transcripts
in the requested agent and project scope while excluding `currentSessionKey`.

**Response**

```json
{
  "query": "Juniper trunk ports",
  "hits": [
    {
      "sessionKey": "agent:nicholai:main",
      "project": "/workspace/repo",
      "updatedAt": "2026-03-25T10:05:00.000Z",
      "excerpt": "keep the Juniper EX4300 VLAN audit focused on trunk ports",
      "rank": -1.2
    }
  ],
  "count": 1
}
```

### GET /api/sessions/summaries

Read temporal manifest nodes from the legacy `session_summaries` table for
session drill-down and `MEMORY.md` synthesis. This endpoint is a compatibility
read: it does not create or populate summary rows. Results are agent-scoped and
can be filtered by `project`, `depth`, or `session_key` (also accepted as
`sessionKey`), with `limit` and `offset` pagination.

If the legacy table is absent, or it exists but has no matching rows, the route
returns an empty result rather than synthesizing summaries:

```json
{ "summaries": [], "total": 0 }
```

When the table is present and populated, each returned row includes the stored
summary fields plus `childCount`; the response always includes `total`.

**Response**

```json
{
  "summaries": [
    {
      "id": "sess-1",
      "kind": "session",
      "depth": 0,
      "source_type": "transcript",
      "source_ref": "session-uuid",
      "childCount": 0,
      "meta_json": "{\"source\":\"session-summary\"}"
    }
  ],
  "total": 1
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

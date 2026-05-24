---
title: "Core configuration API"
description: "Auth, config, and identity endpoints."
order: 13
section: "Reference"
---

# Core configuration API

Auth, config, and identity endpoints.

[Back to HTTP API overview](../API.md).

## Auth

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


## Config

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


## Identity

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

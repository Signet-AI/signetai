---
title: "Authentication"
description: "Token-based authentication for the daemon API."
order: 13
section: "Reference"
---

Auth
===

Auth is optional. By default the daemon runs in `local` mode: no tokens,
no authentication, localhost-only binding. Auth exists for team and remote
deployments where the daemon is shared or exposed over a network.

The system is intentionally simple — no external dependencies, no OAuth
flows, no user database. Tokens are signed with HMAC-SHA256 using a
secret that lives on disk. Roles and scopes are embedded in the token
payload itself.


Auth Modes
---

**local** (default) — No authentication required. All requests are
granted full access without any token. The daemon should only be
accessible from localhost when running in this mode. Best for single-user
local development.

**team** — Every request must include a valid Bearer token. Use this
when the daemon is accessible over a network or shared among multiple
users. Unauthenticated requests get a `401 Unauthorized`.

**hybrid** — The middle ground. Localhost requests can proceed without
a token (full access), but if a token is included it will be validated.
Remote requests always require a valid token. This lets local tooling
work without credentials while still securing remote access.

Note: localhost detection in hybrid mode works by checking the `Host`
request header, not the TCP peer address. This is spoofable in theory
but acceptable given the daemon typically binds to 127.0.0.1.


Token Management
---

Tokens use a simple signed format: `{base64url(payload)}.{base64url(hmac)}`.
The payload is a JSON object encoded with base64url. The signature is
HMAC-SHA256 over the encoded payload, also base64url-encoded. There are
no external dependencies — only Node's built-in `crypto` module.

The signing secret is 32 random bytes, auto-generated on first use and
stored at `~/.agents/.daemon/auth-secret` (mode 0600). If you rotate
the secret, all existing tokens are immediately invalidated.

Token claims:

| Claim | Type   | Description                              |
|-------|--------|------------------------------------------|
| sub   | string | Subject identifier (who the token is for)|
| role  | string | One of: admin, operator, agent, readonly |
| scope | object | Optional restriction (see Scope below)   |
| iat   | number | Issued-at timestamp (Unix seconds)       |
| exp   | number | Expiry timestamp (Unix seconds)          |

Default TTLs: 7 days for regular tokens (`defaultTokenTtlSeconds: 604800`),
24 hours for session tokens (`sessionTokenTtlSeconds: 86400`). Both are
configurable in `agent.yaml`.

Generate a token: `POST /api/auth/token` with `{ role, scope? }` in the
request body. Inspect the current token: `GET /api/auth/whoami`.


Roles and Permissions
---

Four roles, ordered from most to least privileged:

**admin** — Full access including admin operations. Can do everything
any other role can do, plus the `admin` permission which gates
administrative endpoints.

**operator** — Everything except `admin`. Has full memory access plus
documents, connectors, diagnostics, and analytics. Intended for trusted
automation or infrastructure tooling.

**agent** — Core memory operations plus documents. Does not have access
to connectors, diagnostics, analytics, or admin. The default role for
AI assistant integrations.

**readonly** — `recall` only. Can query memory but cannot write, modify,
or delete anything.

Permission matrix:

| Permission  | admin | operator | agent | readonly |
|-------------|-------|----------|-------|----------|
| remember    |  yes  |   yes    |  yes  |    no    |
| recall      |  yes  |   yes    |  yes  |   yes    |
| modify      |  yes  |   yes    |  yes  |    no    |
| forget      |  yes  |   yes    |  yes  |    no    |
| recover     |  yes  |   yes    |  yes  |    no    |
| documents   |  yes  |   yes    |  yes  |    no    |
| connectors  |  yes  |   yes    |   no  |    no    |
| diagnostics |  yes  |   yes    |   no  |    no    |
| analytics   |  yes  |   yes    |   no  |    no    |
| admin       |  yes  |    no    |   no  |    no    |

In `local` mode, permission checks are bypassed entirely — all operations
are allowed regardless of any claims present.


Scope
---

Tokens can be scoped to restrict access to a subset of resources. A
scope is an object with up to three optional fields: `project`, `agent`,
and `user`. When a scope field is set on a token, requests touching a
different value for that field will be rejected with `403 Forbidden`.

An unscoped token (empty scope object) has full access within its role's
permissions. The `admin` role bypasses scope checks entirely — admin
tokens always have full resource access regardless of scope.

Scope restrictions only apply in `team` and `hybrid` modes. In `local`
mode, scope is ignored.

Example: a token scoped to `{ agent: "mr-claude" }` can only access
memory records associated with that agent. Requests targeting a different
agent will be rejected.


Rate Limiting
---

The daemon applies a sliding window rate limiter to destructive operations.
State is in-memory and resets on daemon restart. Rate limits are only
enforced in `team` and `hybrid` modes — `local` mode has no limits.

Default limits (per actor per minute):

| Operation   | Limit |
|-------------|-------|
| forget      |    30 |
| modify      |    60 |
| batchForget |     5 |
| forceDelete |     3 |
| admin       |    10 |

The actor is identified by the token's `sub` claim when present. For
unauthenticated requests (hybrid mode, localhost), the `x-signet-actor`
header is used as a fallback. If neither is available, the actor defaults
to `"anonymous"`.

When a limit is exceeded, the daemon returns `429 Too Many Requests` with
a `Retry-After` header indicating how many seconds until the window resets.

All rate limit configs can be overridden in `agent.yaml` under the
`auth.rateLimits` key.


Configuration
---

Auth is configured in `agent.yaml` under the `auth:` key. All fields
are optional — omitting the section entirely gives you `local` mode
with defaults.

```yaml
auth:
  mode: local  # local | team | hybrid
  defaultTokenTtlSeconds: 604800  # 7 days
  sessionTokenTtlSeconds: 86400   # 24 hours
  rateLimits:
    forget:
      windowMs: 60000
      max: 30
    modify:
      windowMs: 60000
      max: 60
    batchForget:
      windowMs: 60000
      max: 5
    forceDelete:
      windowMs: 60000
      max: 3
    admin:
      windowMs: 60000
      max: 10
```

The secret path is always `~/.agents/.daemon/auth-secret` and is not
configurable. The daemon creates it automatically on first start in any
non-local mode.


HTTP Headers
---

`Authorization: Bearer <token>` — Required in `team` mode. Optional in
`hybrid` mode for localhost requests (validated if present, not required).

`x-signet-actor` — Actor identifier used by the rate limiter when no
token is present. Useful for attributing requests from unauthenticated
local tools in hybrid mode.

`x-signet-actor-type: operator|agent` — Actor type hint used by certain
policy decisions (e.g. repair action gating). Optional.


Deployment Guide
---

**Single user, local machine** — Use the default `local` mode. No
configuration needed. The daemon listens on `localhost:3850` and any
local client has full access.

**Shared team server or CI** — Use `team` mode. Generate tokens for
each consumer with appropriate roles:

```bash
# Generate an operator token for a CI pipeline
curl -X POST http://localhost:3850/api/auth/token \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <your-admin-token>" \
  -d '{ "role": "operator", "sub": "ci-pipeline" }'

# Generate a readonly token for a monitoring script
curl -X POST http://localhost:3850/api/auth/token \
  -H "Authorization: Bearer <your-admin-token>" \
  -d '{ "role": "readonly", "sub": "monitor" }'
```

**Developer machine with remote access** — Use `hybrid` mode. Local
tools (the CLI, dashboard, AI assistants) work without credentials.
Remote tools like CI jobs or teammates need a token. Set `mode: hybrid`
in `agent.yaml` and distribute tokens only to remote consumers.

**Scoped agent tokens** — When multiple AI agents share a daemon, issue
each one a scoped `agent` token to prevent cross-agent memory access:

```json
{
  "role": "agent",
  "sub": "project-assistant",
  "scope": { "agent": "project-assistant" }
}
```

Rotating the secret invalidates all outstanding tokens immediately. Do
this if a token is leaked. The daemon will regenerate a new secret at
`~/.agents/.daemon/auth-secret` if the file is deleted, then restart.

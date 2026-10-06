---
title: "Core configuration API"
description: "Auth, config, and identity endpoints."
---

Auth, config, and identity endpoints.

[Back to HTTP API overview](/api/).

## Auth

### GET /api/auth/whoami

Returns the identity and claims of the current request's credential. This route
is open so the dashboard can determine whether to show the login screen; if an
`Authorization` header is present, the signed token or API key is validated the
same way protected routes validate it. In `local` mode, `authenticated` is
always `false` and `claims` is `null`. `effectiveAccess` is `true` when the
current request can use the dashboard without another login, including trusted
localhost requests in `hybrid` mode. `error` is the reason a presented
credential was rejected, such as `token expired`, `invalid api key`,
`api key revoked`, or `credential could not be verified` when the key store is
unavailable, and `null` when none was presented or it was accepted.
`permissions` lists what the daemon's policy grants this request: every
permission in `local` mode or for trusted localhost requests in `hybrid` mode,
otherwise the permissions the credential's role and permission list both allow.
Clients can use it to show what a credential may do; the daemon still checks
each route. `claims.name`, when present, is a display name: the API key's name,
or the username for password sign-in. Other open
routes, such as `/health` and `/api/mode`, do not look up API keys.

**Response**

```json
{
  "authenticated": true,
  "claims": {
    "sub": "token:operator",
    "name": "ci-runner",
    "role": "operator",
    "scope": { "project": "my-project" },
    "iat": 1740000000,
    "exp": 1740086400
  },
  "trustedLocal": false,
  "effectiveAccess": true,
  "error": null,
  "permissions": ["remember", "recall", "modify", "forget", "recover", "documents", "connectors", "diagnostics", "analytics"],
  "mode": "team",
  "providers": [
    { "id": "password", "type": "password", "enabled": true, "username": "admin" },
    { "id": "sso", "type": "oidc", "enabled": false, "startPath": "/api/auth/sso/start" },
    { "id": "saml", "type": "saml", "enabled": false, "startPath": "/api/auth/saml/start" }
  ]
}
```

### GET /api/auth/methods

Open route returning configured dashboard login providers. Password login is
enabled when `SIGNET_ADMIN_PASSWORD`, `SIGNET_ADMIN_PASSWORD_HASH`, or
`auth.login.password.passwordHash` is set. SSO and SAML entries are exposed as
reserved provider paths for future implementation.

### POST /api/auth/login

Open route that exchanges the configured admin username and password for an
admin session bearer token. Rate-limited to 5 attempts/minute.

**Request body**

```json
{ "username": "admin", "password": "..." }
```

**Response**

```json
{
  "token": "<token>",
  "expiresAt": "2026-02-22T10:00:00.000Z",
  "role": "admin",
  "username": "admin"
}
```

Returns `401` for invalid credentials, `429` when rate-limited, and `503` when
password login has not been configured.

### POST /api/auth/session

Exchanges the request's credential, a signed token or an API key, for a session
token. Requires a valid credential. The session copies the credential's `sub`,
`role`, `scope`, and `permissions`, so it can never grant more than the
credential that minted it. It expires after `auth.sessionTokenTtlSeconds` or
when the presented credential expires, whichever comes first. The dashboard uses
this route so the browser stores a session instead of an API key.

**Response**

```json
{
  "token": "<token>",
  "expiresAt": "2026-02-22T10:00:00.000Z",
  "role": "agent",
  "sub": "api-key:key_..."
}
```

Returns `401` when no valid credential is presented or the credential has
already expired.

Session tokens are not tracked by the daemon. Revoking an API key prevents new
sessions from it but does not end sessions already minted from it; those end at
their `expiresAt`.

### POST /api/auth/handoff

Mints a session as `POST /api/auth/session` does and holds it behind a
single-use code that expires after 60 seconds. `signet dashboard` uses this
route to open the dashboard signed in without putting a credential in the URL.
At most 32 codes can be pending at once, and at most 4 for one credential.
Codes are held in daemon memory and do not survive a restart.

**Response**

```json
{ "code": "<code>", "expiresAt": "2026-02-22T10:00:00.000Z" }
```

Returns `401` without a valid credential and `429` when too many codes are
pending.

### POST /api/auth/handoff/redeem

Open route that returns the session held behind a handoff code, once. Shares
the login rate limit.

**Request body**

```json
{ "code": "<code>" }
```

**Response**

Same shape as `POST /api/auth/session`. Returns `400` when `code` is missing or
not a string, `401` when the code is unknown, expired, or already redeemed, and
`429` when rate-limited.

### GET /api/auth/sso/start
### GET /api/auth/sso/callback
### GET /api/auth/saml/start
### POST /api/auth/saml/acs

Open reserved provider paths. They currently return `501` until SSO/SAML
providers are implemented.

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

### GET /api/auth/api-keys

List named daemon API keys. Requires `admin` permission. The response never
includes raw `sig_sk_...` key values; raw keys are only returned once at
creation time.

**Response**

```json
{
  "apiKeys": [
    {
      "id": "key_abc123",
      "prefix": "1b363ad385e1",
      "name": "work laptop pi",
      "role": "agent",
      "scope": { "agent": "pi-work-laptop" },
      "permissions": ["recall", "remember", "documents"],
      "connector": "pi",
      "harness": "pi",
      "agentId": "pi-work-laptop",
      "allowedProjects": [],
      "createdAt": "2026-06-11T04:02:17.922Z",
      "lastUsedAt": null,
      "revokedAt": null,
      "expiresAt": null
    }
  ]
}
```

### POST /api/auth/api-keys

Create a named API key for remote connectors or other daemon clients. Requires
`admin` permission. The raw `key` is returned once in this response and is
stored hashed at rest.

**Request body**

```json
{
  "name": "work laptop pi",
  "connector": "pi",
  "role": "agent",
  "agentId": "pi-work-laptop",
  "scope": { "agent": "pi-work-laptop" },
  "allowedProjects": [],
  "expiresAt": null
}
```

`name` is required, at most 128 characters. `role` defaults to `agent` and must be one of `admin`,
`operator`, `agent`, or `readonly` when provided. `connector`, `harness`,
`agentId`, `allowedProjects`, `scope`, `permissions`, and `expiresAt` are
optional. `agentId` is connector metadata; API callers should also set
`scope: { "agent": "..." }` when scope-guarded API surfaces should be limited
to that agent. For connector keys, `scope.agent` should usually match
`agentId`. The Signet CLI does this automatically when you run
`signet api-key create --agent-id <id>`. Connector keys default to the
connector permission set: `recall`, `remember`, and `documents`.

**Response**

```json
{
  "apiKey": {
    "id": "key_abc123",
    "prefix": "1b363ad385e1",
    "name": "work laptop pi",
    "role": "agent",
    "scope": { "agent": "pi-work-laptop" },
    "permissions": ["recall", "remember", "documents"],
    "connector": "pi",
    "harness": "pi",
    "agentId": "pi-work-laptop",
    "allowedProjects": [],
    "createdAt": "2026-06-11T04:02:17.922Z",
    "lastUsedAt": null,
    "revokedAt": null,
    "expiresAt": null,
    "key": "sig_sk_..."
  }
}
```

Returns `400` if the request body is missing or malformed, `name` is empty,
`role` is invalid, or `expiresAt` is not a valid ISO timestamp.

### DELETE /api/auth/api-keys/:id

Revoke an API key by id or prefix. Requires `admin` permission. Revocation is
idempotent for an existing key: already-revoked keys are returned with their
original `revokedAt` timestamp.

**Response**

```json
{
  "apiKey": {
    "id": "key_abc123",
    "prefix": "1b363ad385e1",
    "name": "work laptop pi",
    "role": "agent",
    "scope": { "agent": "pi-work-laptop" },
    "permissions": ["recall", "remember", "documents"],
    "connector": "pi",
    "harness": "pi",
    "agentId": "pi-work-laptop",
    "allowedProjects": [],
    "createdAt": "2026-06-11T04:02:17.922Z",
    "lastUsedAt": null,
    "revokedAt": "2026-06-11T05:00:00.000Z",
    "expiresAt": null
  }
}
```

Returns `404` if the id or prefix does not match an API key.


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
  "success": true
}
```

Returns `400` for invalid file names, path traversal attempts, or wrong file
or payload types. Returns `403` when saving a guarded config file (`agent.yaml`,
`AGENT.yaml`, `config.yaml`) without `admin` permission in team or hybrid auth
mode.

Provider selection is configured through the canonical `inference` routing
block. Retired `memory.pipelineV2` provider/model/endpoint fields are rejected
by the daemon loader; use the migration guidance on the [upgrading page](/upgrading/).


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

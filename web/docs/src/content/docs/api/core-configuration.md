---
title: "Core configuration API"
description: "Authentication, configuration, agents, and daemon identity endpoints."
---

[Back to HTTP API](/api/).

## Authentication and identity

| Method | Route | Contract |
|---|---|---|
| GET | `/api/auth/methods` | Reports auth mode and providers. Password provider includes `id`, `type`, `enabled`, and username; SSO/SAML may be disabled. |
| POST | `/api/auth/login` | Public password login. Returns `token`, `expiresAt`, `role`, and `username`; invalid credentials are `401`, malformed input `400`, unavailable login `503`, and login throttling `429` with `Retry-After`. |
| GET | `/api/auth/whoami` | Returns `authenticated`, `trustedLocal`, `effectiveAccess`, `claims`, `mode`, and providers. |
| POST | `/api/auth/token` | Admin-only token minting. `role` is `admin`, `operator`, `agent`, or `readonly`; accepts `scope` and optional positive `ttlSeconds`. |
| GET/POST | `/api/auth/api-keys` | Admin-only list/create. Create accepts `name`, role, scope, permissions, connector, harness, `agentId`, `allowedProjects`, and `expiresAt`; the secret is returned at creation. |
| DELETE | `/api/auth/api-keys/:id` | Admin-only revoke; unknown IDs return `404`. |

Bearer credentials carry a role and optional explicit scope. Permissions include
`remember`, `recall`, `modify`, `forget`, `recover`, `admin`, `documents`,
`connectors`, `diagnostics`, and `analytics`. Scope can identify a project,
agent, or user; API keys can additionally bind connector, harness, agent, or
project allowlists. Requests outside scope are denied. Missing, ambiguous,
expired, or unauthorized identity fails closed; it does not become `default`.

SSO/SAML compatibility routes return `501` when not configured. See
[Authentication](/auth/) for credential lifecycle and permission details.

## Configuration and agent identity

- `GET /api/config` lists `.md` and `.yaml` files in the daemon's resolved agent
  directory, including name, content, and byte size.
- `POST /api/config` requires admin permission for every write. The JSON body is
  `{ "file": "...", "content": "..." }`; filenames cannot contain `/` or `..`
  and must end in `.md` or `.yaml`. The content limit is 1 MiB; oversized
  requests return `413`, invalid bodies/names/types `400`.
- `agent.yaml` and `config.yaml` are guarded: they require admin permission and
  must pass pipeline configuration validation before writing. A failed
  validation does not write the file.

The daemon resolves configuration and identity at its boundary; clients must
not rely on local config-file fallbacks. Agent reads expose policy and resolved
scope. Agent writes accept `isolated`, `shared`, or `group`; `group` requires a
non-empty group name of at most 128 characters. `signet agent set` uses PATCH,
while `signet agent info` is only a compatibility alias for `show`.

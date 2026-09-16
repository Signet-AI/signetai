---
title: "Core configuration API"
description: "Authentication, configuration, agents, and daemon identity endpoints."
---

[Back to HTTP API](/api/).

## Authentication

| Method | Route | Status |
|---|---|---|
| GET | `/api/auth/methods` | canonical |
| POST | `/api/auth/login` | canonical |
| GET | `/api/auth/whoami` | canonical |
| POST | `/api/auth/token` | canonical; admin |
| GET/POST/DELETE | `/api/auth/api-keys` and `/api/auth/api-keys/:id` | canonical; admin |
| GET | `/api/auth/sso/start`, `/api/auth/sso/callback` | compatibility provider surface; may return 501 |
| GET | `/api/auth/saml/start`, POST `/api/auth/saml/acs` | compatibility provider surface; may return 501 |

Login and discovery routes are reachable before a bearer token is established.
Token and API-key administration requires admin permission.

## Configuration and identity

The configuration, agent, workspace, and identity routes in this section are
protected by their registered permission guards. `GET /api/agents/:name` returns
`read_policy`, optional `policy_group`, timestamps, and resolved
`effective_scope`. `POST /api/agents` and `PATCH /api/agents/:name` accept
`isolated`, `shared`, or `group`; `group` requires a group name.

`signet agent set` uses PATCH. `signet agent show` uses GET. `signet agent info`
is a compatibility alias, not a second state owner.

Do not document local config-file fallbacks: the daemon resolves configuration
at its boundary and rejects unsupported or ambiguous identity input.

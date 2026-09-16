---
title: "Security and lifecycle"
description: "Configure authentication and bounded lifecycle behavior."
---

Security settings live under `auth` in `agent.yaml`. Authentication modes are `local`, `team`, and `hybrid`; choose the mode that matches the network boundary. See [Authentication](/auth/) for the credential flow.

## Authentication configuration

Use `local` for a trusted local daemon. Use `team` for authenticated clients. Use `hybrid` when loopback access remains trusted while remote requests require credentials. Team and hybrid modes use `<SIGNET_PATH>/.daemon/auth-secret`; if required authentication state cannot be loaded, the daemon is unavailable or not ready. The `Host` header does not make a request local.

Optional dashboard password login accepts `SIGNET_ADMIN_USERNAME`, `SIGNET_ADMIN_PASSWORD`, and `SIGNET_ADMIN_PASSWORD_HASH` as service-environment credential inputs. YAML configuration uses `auth.login.password.username` and `auth.login.password.passwordHash`; supported legacy fields are `auth.adminUser.username` and `auth.adminUser.passwordHash`. These variables are not general-purpose environment overrides and do not establish blanket precedence for unrelated YAML settings.

Daemon-issued tokens default to 604800 seconds (7 days), and dashboard login sessions default to 86400 seconds (24 hours). Set the positive `auth.defaultTokenTtlSeconds` and `auth.sessionTokenTtlSeconds` fields when those defaults do not fit the deployment.

## Rate-limit fields and defaults

In team and hybrid modes, authentication rate limits use per-actor in-memory windows. Each configured limit has `windowMs` and `max`; both must be positive. Defaults are:

| Field | `windowMs` | `max` |
| --- | ---: | ---: |
| `auth.rateLimits.forget` | 60000 | 30/minute |
| `auth.rateLimits.modify` | 60000 | 60/minute |
| `auth.rateLimits.batchForget` | 60000 | 5/minute |
| `auth.rateLimits.forceDelete` | 60000 | 3/minute |
| `auth.rateLimits.admin` | 60000 | 10/minute |
| `auth.rateLimits.login` | 60000 | 5/minute |
| `auth.rateLimits.inferenceExplain` | 60000 | 120/minute |
| `auth.rateLimits.inferenceExecute` | 60000 | 20/minute |
| `auth.rateLimits.inferenceGateway` | 60000 | 30/minute |
| `auth.rateLimits.recallLlm` | 60000 | 60/minute |

Counters reset when the daemon restarts. Local mode does not apply these auth rate limits. A rejected request returns `429` with `Retry-After`.

## Apply changes safely

The daemon loads authentication configuration into runtime state. Use the supported daemon reload/restart path after changing `agent.yaml`; restart when changing service environment variables or rotating `auth-secret`. Replacing the secret invalidates signed tokens and dashboard sessions, so issue fresh credentials afterward. Keep the secret file persistent across container upgrades.

- `401` — a protected request has no bearer credential, or its bearer token/API key is malformed, invalid, or expired.
- `403` — the credential is valid but its role, permission, or scope does not allow the operation.
- `429` — the request exceeded its applicable in-memory rate limit; `Retry-After` is returned.
- `503` — the daemon is unavailable or not ready because required authentication state could not be loaded.

The `/health/ready` probe returns `503` when required authentication state cannot be loaded. A protected request that reaches the daemon without its signing secret currently returns `500` (`auth secret not configured`), not `503`; treat that as a deployment error. SSO and SAML settings and `/api/auth/sso/*` and `/api/auth/saml/*` routes remain reserved compatibility surfaces and are not configured login providers today.

Keep auth material, runtime state, logs, and secret storage private. Do not expose a local-mode daemon on a shared network. See [Secrets](/secrets/) for encrypted values, [Self-hosting](/self-hosting/) for deployment boundaries, and [Diagnostics](/diagnostics/) for evidence after lifecycle changes.

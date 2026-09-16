---
title: "Authentication"
description: "Bootstrap protected access, issue scoped keys, and revoke credentials."
---

Signet supports `local`, `team`, and `hybrid` authentication. `local` is for a trusted local daemon. `team` requires credentials for protected requests. `hybrid` keeps requests from the loopback peer trusted and requires credentials for remote requests; the `Host` header does not establish locality.

## Bootstrap team authentication

Set the daemon to team mode in `agent.yaml`:

```yaml
auth:
  mode: team
```

From the repository root, start the daemon once so it creates the signing secret, then mint the first admin token:

```bash
cd deploy/docker
docker compose exec signet bun /app/deploy/docker/scripts/create-token.mjs --role admin --sub bootstrap
```

The command writes the raw token to standard output once. Store it in a secret manager and send it as `Authorization: Bearer <token>`. Never put a token or password in `agent.yaml`, shell history, screenshots, logs, or source control. The command reads `${SIGNET_PATH}/.daemon/auth-secret`, defaulting to `/data/agents/.daemon/auth-secret` in the container; `--secret` overrides that path for the token command only.

Optional dashboard password login accepts `SIGNET_ADMIN_USERNAME`, `SIGNET_ADMIN_PASSWORD`, and `SIGNET_ADMIN_PASSWORD_HASH` as service-environment credential inputs. YAML configuration uses `auth.login.password.username` and `auth.login.password.passwordHash`; the supported legacy YAML fields are `auth.adminUser.username` and `auth.adminUser.passwordHash`. These variables do not provide general precedence for unrelated configuration.

## Roles, permissions, and one-time credentials

Valid token roles are `admin`, `operator`, `agent`, and `readonly`. The permission names are `remember`, `recall`, `modify`, `forget`, `recover`, `admin`, `documents`, `connectors`, `diagnostics`, and `analytics`. A credential may further restrict its role permissions with a `permissions` list.

Token claims can carry `project`, `agent`, and `user` scope fields. Admin tokens bypass scope checks. Non-admin tokens with an explicit scope are denied (`403`) when the requested target conflicts with that scope. Non-admin empty-scope tokens currently retain access for compatibility, but this is deprecated; issue explicit scopes. API keys can additionally be associated with an agent, connector, harness, or project allowlist.

Create a named API key for each connector or machine:

```bash
signet api-key create --name "work laptop pi" --connector pi --agent-id pi-work-laptop
signet api-key list
```

The raw `sig_sk_...` API-key value is displayed only at creation. Treat it as a one-time secret. Revoke an exposed or retired key:

```bash
signet api-key revoke <id-or-prefix>
```

## Token lifetime and secret rotation

Daemon-issued tokens default to `auth.defaultTokenTtlSeconds: 604800` (7 days). Dashboard login sessions default to `auth.sessionTokenTtlSeconds: 86400` (24 hours). The container token command defaults to `--ttl 604800` seconds and accepts a positive `--ttl` value.

The daemon stores its signing secret at `<SIGNET_PATH>/.daemon/auth-secret` (normally `~/.agents/.daemon/auth-secret`; in the container, `/data/agents/.daemon/auth-secret`). Keep this file private and persistent. Replacing it invalidates existing signed tokens and dashboard sessions. Restart the daemon after rotation, then issue fresh credentials.

## Authentication failures

- `401` — a protected request has no bearer credential, or the bearer token/API key is malformed, invalid, or expired.
- `403` — the credential is valid but its role, permission, or scope does not allow the operation.
- `429` — the request exceeded the applicable in-memory rate limit. The response includes `Retry-After`.
- `503` — the daemon is unavailable or not ready because required authentication state could not be loaded.

The `/health/ready` probe returns `503` when required authentication state cannot be loaded. A protected request that reaches the daemon without its signing secret currently returns `500` (`auth secret not configured`), not `503`; treat that state as a deployment error. Authentication configuration is applied through the daemon's supported reload/restart path after changing `agent.yaml`. Restart after changing service environment variables or rotating the secret. In-memory rate-limit counters reset on restart.

SSO and SAML routes are reserved compatibility surfaces and are not configured login providers today. For remote connectors, see [Remote Harness Connectors](/remote-connectors/). For deployment and TLS, see [Self-hosting](/self-hosting/).

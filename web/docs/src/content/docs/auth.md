---
title: "Authentication"
description: "Configure daemon authentication for local, hybrid, and team deployments."
---

Authentication is optional for a single local machine. Use `team` mode for a daemon shared over a network or by multiple people. Do not expose a daemon that remains in `local` mode.

Setting up a daemon for several people? [Teams](/teams/) walks through it end to end, from team mode to dashboard sign-in and handing out keys.

## Modes

- **`local`**: no bearer credential is required. This is the default and should remain localhost-only.
- **`team`**: every protected request requires a valid bearer credential. Use this for a shared server or CI-facing daemon.
- **`hybrid`**: localhost requests can proceed without a credential; remote requests require one. Do not rely on hybrid mode behind an untrusted same-host reverse proxy, because the daemon uses the TCP peer address to identify localhost traffic.

## Configure a team daemon

Set the mode explicitly in the workspace `agent.yaml` used by the daemon:

```yaml
network:
  mode: tailscale

auth:
  mode: team
```

`auth.mode` defaults to `local` when omitted. `network.mode: tailscale` makes the daemon bind for network access; use your network boundary, firewall, or reverse proxy deliberately.

Start the daemon with the password-login bootstrap supplied through a secret-safe environment mechanism:

```bash
SIGNET_ADMIN_USERNAME=admin \
SIGNET_ADMIN_PASSWORD='load-this-from-a-secret-manager' \
signet daemon start
```

The daemon creates its signing secret under `runtime/auth-secret` for non-local modes. Do not copy, commit, or distribute that file. The password value is not written to `agent.yaml`; a persisted configuration may contain only a password hash.

`signet daemon` by itself prints the command group help. The command that starts the service is `signet daemon start`.

## Bootstrap credentials safely

In team mode, token and API-key creation are admin-protected endpoints. A new server therefore needs an initial admin authentication path before it can issue API keys:

1. Set `SIGNET_ADMIN_PASSWORD` or `SIGNET_ADMIN_PASSWORD_HASH` when starting the daemon, as above.
2. Sign in to the dashboard with that admin credential, or authenticate against `POST /api/auth/login` from a secret-aware client. The dashboard also accepts an API key, which it exchanges for a browser session, and `signet dashboard` opens it signed in when `SIGNET_API_KEY` is set. See [Dashboard](/dashboard/#signing-in).
3. Use the resulting short-lived admin bearer session to create scoped API keys or tokens.
4. Store each issued key only in the remote consumer's secret store. The raw API key is shown once.

Do not put the bootstrap password, admin bearer token, or issued key into shell history, source files, screenshots, or `agent.yaml`. `SIGNET_API_KEY` is the normal client environment variable; `SIGNET_TOKEN` remains an older alias.

## Create and use API keys

Once an admin bearer credential is available to the CLI as `SIGNET_API_KEY`, create a named, scoped remote-client key:

```bash
signet api-key create \
  --name "work-laptop-pi" \
  --connector pi \
  --agent-id pi-work-laptop

signet api-key list
signet api-key revoke <id-or-prefix>
```

`--agent-id` restricts the credential to that agent scope. Connector keys are intended for remote connectors and receive their connector permission set. Clients send keys as bearer credentials:

```bash
SIGNET_DAEMON_URL=https://signet.example.test:3850 \
SIGNET_API_KEY='store-in-a-secret-manager' \
signet connector install pi --agent-id pi-work-laptop
```

Verify an installed remote client without printing its key:

```bash
curl -fsS "$SIGNET_DAEMON_URL/api/auth/whoami" \
  -H "Authorization: Bearer ***"
```

## Roles and scopes

| Role | Intended access |
|---|---|
| `admin` | Administrative actions and all lower-level permissions. |
| `operator` | Operational access without the admin permission. |
| `agent` | Core memory and document operations. |
| `readonly` | Recall only. |

A scope can restrict a credential by agent, project, or user. Use the narrowest role and scope that a remote client needs. Admin credentials bypass normal scope restrictions, so keep them short-lived and tightly controlled.

## Password login configuration

Password login is enabled when one of these is available: `SIGNET_ADMIN_PASSWORD`, `SIGNET_ADMIN_PASSWORD_HASH`, or `auth.login.password.passwordHash` in `agent.yaml`. The default username is `admin`; set `SIGNET_ADMIN_USERNAME` or `auth.login.password.username` to change it. Persist a `pbkdf2-sha256$...` hash rather than a plaintext password.

SSO and SAML endpoints are reserved but are not configured login providers today.

## Rotate and recover

Revoking an API key prevents further use of that key. Replacing or deleting the daemon signing secret invalidates existing signed tokens and dashboard sessions; restart the daemon afterward and issue fresh credentials. Treat this as an incident-recovery operation, not routine maintenance.

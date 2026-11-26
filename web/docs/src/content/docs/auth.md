---
title: "Authentication"
description: "Configure daemon authentication for local, hybrid, and team deployments."
---

Authentication is optional for a single local machine. Use `team` mode for a daemon shared over a network or by multiple people. Do not expose a daemon that remains in `local` mode.

Setting up a daemon for several people? Start with [Organizations](/organization/) for individual accounts, device sign-in, and revocable connector credentials. An existing unclaimed team workspace keeps its legacy authentication until an administrator claims it.

## Modes

- **`local`**: no bearer credential is required. This is the default and should remain localhost-only.
- **`team`**: every protected request requires a valid credential. Claimed organizations accept user sessions and owned API keys; browsers use session cookies with CSRF protection.
- **`hybrid`**: direct localhost requests can proceed without a credential; remote requests require one. A request carrying `Forwarded`, any supported `X-Forwarded-*` header, or `X-Real-IP` never receives loopback trust. The daemon warns and exposes `hybridProxyDetected` through identity and status responses. Use team mode behind a reverse proxy.

## Organization sign-in

An unclaimed team daemon prints a one-time setup token. Claim it through `POST /api/org/claim`; the setup token is then consumed. Password sign-in creates a server-side browser session, not a stateless signed token. OIDC is available when configured through organization settings.

Browser sessions use `signet_session` (HttpOnly, SameSite=Lax) and `signet_csrf`. Cookie-authenticated writes require `x-signet-csrf` containing the CSRF secret. Cookies are Secure over HTTPS or when the configured public URL is HTTPS. Secure cookies use the `__Host-` prefix (`__Host-signet_session` and `__Host-signet_csrf`); HTTP loopback keeps the plain names. Bearer-authenticated clients do not need CSRF headers.

CLI and desktop sessions use the device-code flow and rotating refresh tokens. Retrying a rotated-away refresh token returns the same current access/refresh pair until the client first uses that pair, up to 24 hours after rotation, including across daemon restarts. Using the new access token on an authenticated request or refreshing with the new refresh token ends the old token’s retry grace. Reusing the old token afterward revokes the session with `refresh_reuse`. Session, device, and key revocations and user deactivation are checked against server records on every request. Logout leaves connector keys intact; revoke the key or device to stop a connector.

The `member` role has core memory and document permissions. Admin adds administration and audit, not classification authority. A compliance flag adds `classify` and `audit`. Connector permissions are bounded by their user and their enforced agent, harness, device, and project bindings. Actor headers cannot change the authenticated user.

Authentication failures return `401 { error, reason }` with `WWW-Authenticate: Bearer`. Authorization failures return `403 { error, reason, required? }`. A write to a destination whose classifications you cannot read returns `403` with reason `classified_destination`, even if you can act as its agent. Signet refuses the write before capturing content or looking for duplicates. `whoami.effectiveAccess` remains a boolean: local mode, trusted loopback access, or a valid authenticated credential makes it `true`. The additive `whoami.accessMode` field distinguishes `open`, `authenticated`, and `none`.

## Agent preference

`PATCH /api/auth/preferences` accepts `{ defaultReadAgentId }` from a signed-in user session. It changes only your default read agent, not another user's preference or your default write ownership. The agent must exist and be unarchived; API keys cannot change the account preference. The change is audited and appears in `/api/auth/whoami`.

## Dashboard handoff

A signed-in user session can call `POST /api/auth/handoff` to receive `{ code, expiresAt }`. The code expires after 60 seconds, is single use, and becomes invalid when its issuing session expires or is revoked. API keys cannot mint browser sessions. Pending handoffs are bounded and are invalidated by a daemon restart.

The browser sends the code in the JSON body of `POST /api/auth/handoff/redeem`. Redemption sets the browser session and CSRF cookies and returns `{ user, expiresAt, csrf }`, never a bearer token. Put the code in a URL fragment rather than a query string, clear it before redemption, and never put an access or refresh token in a URL.

## Reverse proxies and browser origins

`auth.trustedProxies` is an IP/CIDR list, empty by default. It is validated when configuration loads. List only proxies that you control:

```yaml
auth:
  mode: team
  trustedProxies:
    - 192.0.2.10
    - "2001:db8:1::/48"
```

When the socket peer is trusted, the daemon uses the rightmost untrusted `X-Forwarded-For` hop as the client address and honors `X-Forwarded-Proto` and `X-Forwarded-Host` for the browser-facing origin. Configure the proxy to replace client-supplied forwarding headers. Otherwise, forwarded headers do not change the client address or origin. Without a trusted-proxy entry, clients behind one proxy share its rate-limit bucket. Forwarding headers still disable hybrid loopback trust, even when the proxy is trusted.
If every `X-Forwarded-For` hop is trusted, the client address is the proxy peer.

Browser authentication writes accept the configured organization public URL or the request origin, including the origin supplied by a trusted proxy. Local and hybrid modes also accept the existing development dashboard origins, including `http://localhost:5173` and `http://127.0.0.1:5173`; team mode does not grant that development exception. Cookie-authenticated writes still require CSRF protection.

Password login allows five attempts per minute for each username/client-address pair and at most 30 per username across clients. Open authentication endpoints also have per-client admission limits. Full limiter maps evict their oldest-expiring entries rather than rejecting every new client.

## Legacy team configuration

The following configuration and signed-token commands apply before an organization is claimed, and to hybrid deployments. Claimed organizations use the setup, invitation, and device provisioning flows described above. Non-admin legacy signed credentials with no agent, user, or project scope are rejected with `empty_scope`. Pre-upgrade API keys retain their explicit migration grace period.

### Configure a team daemon

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

Admins signed in to the dashboard can create, list, and revoke keys under **Settings → API keys**. From the CLI, once an admin bearer credential is available as `SIGNET_API_KEY`, create a named, scoped remote-client key:

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

### Transcript deletion authorization

`DELETE /api/sessions/:key/transcript` requires `forget` permission in soft mode
or `admin` permission for `?purge=hard`, and an
explicit agent identity outside local mode. An agent-scoped credential supplies
that identity; an unscoped credential must send it. Session ownership and project
scope are checked before capture is bypassed or any evidence changes. Missing
and out-of-scope sessions both return `404`. Hard purge (`?purge=hard`) requires
an authenticated admin role in both team and hybrid modes, including localhost.
An admin credential restricted to `["admin"]` may hard-purge but may not soft-delete;
a credential restricted to `["forget"]` may soft-delete but may not hard-purge.
Pinned memories are retained in either mode. See the
[API contract](/api/sessions-hooks/#delete-apisessionskeytranscript).

## Password login configuration

Password login is enabled when one of these is available: `SIGNET_ADMIN_PASSWORD`, `SIGNET_ADMIN_PASSWORD_HASH`, or `auth.login.password.passwordHash` in `agent.yaml`. The default username is `admin`; set `SIGNET_ADMIN_USERNAME` or `auth.login.password.username` to change it. Persist a `pbkdf2-sha256$...` hash rather than a plaintext password.

OIDC SSO is available in claimed organizations. SAML remains reserved. OIDC client secrets are resolved by name from Signet Secrets; organization settings never hold secret values.

## Rotate and recover

Revoking an API key prevents further use of that key. The daemon rejects every request whose key check starts after the revocation is saved. A request whose key check was already running when the revocation was saved can still complete. Replacing or deleting the daemon signing secret invalidates existing signed tokens and dashboard sessions; restart the daemon afterward and issue fresh credentials. Treat this as an incident-recovery operation, not routine maintenance.

---
title: "Self-Hosting"
description: "Run Signet with the first-party Docker deployment and secure the daemon boundary."
---

Use the first-party Docker deployment when you need a persistent, self-hosted Signet daemon. It includes the daemon, Caddy reverse proxy, persistent volumes, health checks, and a team-auth bootstrap.

## Docker Compose quick start

```bash
cd deploy/docker
cp .env.example .env
docker compose up -d --build
```

The stack stores the Signet workspace in the `signet_data` volume at `/data/agents` in the container and publishes Caddy on ports 80 and 443 by default. Open the health endpoint locally:

```bash
curl -fsS http://localhost/health
```

The supplied compose configuration binds the daemon inside the stack and Caddy is the published entry point. Do not publish port 3850 directly unless you have an explicit private-network design and matching authentication.

## First admin credential

The container entrypoint initializes `auth.mode: team` on first run when no configuration exists. Mint an initial admin token inside the running service:

```bash
docker compose exec signet \
  bun /app/deploy/docker/scripts/create-token.mjs --role admin --sub bootstrap
```

The token is printed once. Store it in an approved secret manager, then create narrowly scoped keys or tokens for real clients. To use the dashboard, open your domain and paste the token under **Use an API key instead**; the browser keeps a session, not the token. See [Teams](/teams/), [Authentication](/auth/), and [Remote Harness Connectors](/remote-connectors/).

## Configure the proxy

Set these values in `deploy/docker/.env` before production use:

```text
SIGNET_DOMAIN=signet.example.com
SIGNET_IMAGE_TAG=latest
SIGNET_HTTP_PORT=80
SIGNET_HTTPS_PORT=443
```

Caddy terminates TLS for a real public domain. Keep `auth.mode: team` for a public or shared deployment. `hybrid` is for trusted local workflows and should not be used as the only boundary behind a reverse proxy.

Provider credentials are optional compose environment values. Prefer the Signet secret store and `$secret:NAME` configuration references for durable operator configuration; do not commit a populated `.env` file.

## Health and operations

```bash
docker compose ps
docker compose logs -f signet
curl -fsS http://localhost/health
```

For deeper readiness and diagnostics, authenticate as needed and use the daemon endpoints documented in [Daemon](/daemon/) and [Diagnostics](/diagnostics/).

## Backup and upgrade

Back up the named workspace volume before a major version change. The Docker deployment keeps configuration, the database, and daemon state under `/data/agents`.

```bash
# Pull the configured image tag and recreate services
docker compose pull
docker compose up -d
```

Follow the release-specific checks in [Upgrading](/upgrading/) and confirm readiness after restart. Do not discard the volume to work around a migration error.

## Host-managed deployments

A host service manager can run the daemon directly, but it must provide a stable runtime, one writer per workspace, explicit `SIGNET_PATH`, explicit bind behavior, and restart-safe health checks. The CLI lifecycle commands are:

```bash
signet daemon start
signet daemon stop
signet daemon restart
signet daemon status --json
```

Use a service supervisor you already operate rather than copying an outdated unit file. Verify `/health/live` and `/health/ready` after every deployment.

## Security checklist

- Bind to loopback by default. Use `network.mode: tailscale` or an explicit `SIGNET_BIND` only for a trusted network design.
- Use `auth.mode: team` for shared, proxied, or public access.
- Use one named API key per connector or automation client, then revoke it when the client is retired.
- Keep the workspace volume, `runtime/`, `data/`, and `.secrets/` private and backed up.
- Do not put raw tokens, passwords, or provider keys in source control, issue trackers, or screenshots.

Related: [Daemon](/daemon/), [Authentication](/auth/), [Remote Harness Connectors](/remote-connectors/), [Diagnostics](/diagnostics/).

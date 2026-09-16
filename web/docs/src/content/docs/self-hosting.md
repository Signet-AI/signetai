---
title: "Self-hosting"
description: "Deploy Signet with a durable workspace, private network boundary, and health checks."
---

Self-hosting means running the Signet daemon on infrastructure you control. Keep one daemon writer per workspace and persist the workspace volume.

## Docker deployment

From the repository root, configure the release environment and start the service:

```bash
cd deploy/docker
cp .env.example .env
docker compose up -d
```

`.env` supplies Docker and provider inputs such as the public domain and Caddy's host-published ports. It does not configure Signet's authentication mode. Configure the persisted workspace and auth mode in `agent.yaml` on the `signet_data` volume (`/data/agents/agent.yaml` in the container):

```yaml
auth:
  mode: team
```

The Docker entrypoint creates this file with `team` mode on a new volume. Keep `agent.yaml`, `.daemon/`, and `.secrets/` on the same persistent volume, and do not commit a populated `.env` file or any credentials.

The daemon listens on internal container port `3850` and is private to the Compose network. Caddy is the only published service boundary; `SIGNET_HTTP_PORT` and `SIGNET_HTTPS_PORT` are host ports for Caddy, not daemon ports. Verify the proxy boundary and the daemon container health separately:

```bash
# Published Caddy boundary
curl -fsS "http://127.0.0.1:${SIGNET_HTTP_PORT:-80}/health/ready"

# Internal daemon container health (the daemon listens on container port 3850)
test "$(docker inspect --format '{{.State.Health.Status}}' "$(docker compose ps -q signet)")" = healthy
```

Before allowing remote access, verify both the persisted setting and the running daemon's mode, then create credentials as described in [Authentication](/auth/):

```bash
docker compose exec signet sh -c "grep -A1 '^auth:' /data/agents/agent.yaml"
# Auth discovery is intentionally unauthenticated and reports the running mode.
curl -fsS "http://127.0.0.1:${SIGNET_HTTP_PORT:-80}/api/auth/methods"
```

Use `team` or `hybrid` for remote clients. Keep `local` mode on a trusted local-only deployment.

## Network and TLS

Bind localhost for a single-host deployment. For remote access, use a private network such as Tailscale or WireGuard, or terminate HTTPS at a reverse proxy. Keep Caddy's published ports restricted to the intended network.

## Updates and recovery

Apply release-specific migration guidance from [Upgrading](/upgrading/), then restart and verify both checks again:

```bash
docker compose pull
docker compose up -d
curl -fsS "http://127.0.0.1:${SIGNET_HTTP_PORT:-80}/health/ready"
test "$(docker inspect --format '{{.State.Health.Status}}' "$(docker compose ps -q signet)")" = healthy
```

Keep the volume when a migration or readiness check reports an error. Use [Diagnostics](/diagnostics/) to capture evidence before repair. A service manager may supervise the daemon directly, but it must provide a stable runtime, explicit workspace and bind settings, one writer, and restart-safe health checks.

## Security boundary

Keep the workspace volume, runtime state, secret store, auth material, and logs private. Use one scoped API key per remote connector and revoke keys when a machine or client is retired. See [Authentication](/auth/), [Secrets](/secrets/), and [Remote Harness Connectors](/remote-connectors/).

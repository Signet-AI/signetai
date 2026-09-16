---
title: "Self-hosting"
description: "Deploy Signet with a durable workspace, private network boundary, and health checks."
---

Self-hosting means running the Signet daemon on infrastructure you control. Keep one daemon writer per workspace and persist the workspace volume.

## Docker deployment

From the repository's deployment directory, configure the release environment and start the service:

```bash
cp .env.example .env
docker compose up -d
```

Set the deployment bind, workspace volume, authentication mode, and any provider values in `deploy/docker/.env` as required by the compose file. Prefer the Signet secret store and `$secret:NAME` references for durable credentials. Do not commit a populated `.env` file.

Confirm the service from the host:

```bash
curl -fsS http://127.0.0.1:3850/health/ready
```

Persist the workspace, `.daemon/`, and `.secrets/` data on the configured volume. Back it up with an encrypted system that preserves private permissions.

## Network and TLS

Bind localhost for a single-host deployment. For remote access, use a private network such as Tailscale or WireGuard, or terminate HTTPS at a reverse proxy. Select `team` or `hybrid` authentication before allowing remote clients; do not expose a local-mode daemon on a shared network.

## Updates and recovery

Apply release-specific migration guidance from [Upgrading](/upgrading/), then restart and verify readiness:

```bash
docker compose pull
docker compose up -d
curl -fsS http://127.0.0.1:3850/health/ready
```

Keep the volume when a migration or readiness check reports an error. Use [Diagnostics](/diagnostics/) to capture evidence before repair. A service manager may supervise the daemon directly, but it must provide a stable runtime, explicit workspace and bind settings, one writer, and restart-safe health checks.

## Security boundary

Keep the workspace volume, runtime state, secret store, auth material, and logs private. Use one scoped API key per remote connector and revoke keys when a machine or client is retired. See [Authentication](/auth/), [Secrets](/secrets/), and [Remote Harness Connectors](/remote-connectors/).

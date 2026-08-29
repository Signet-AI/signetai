---
title: "Upgrading"
description: "Update Signet, preserve workspace state, and verify the running daemon."
---

Upgrade the installed Signet distribution through the daemon-aware update commands when they are available:

```bash
signet update check
signet update install
signet update status
signet update channel
```

An installed update can require a daemon restart before it is active:

```bash
signet daemon restart
signet daemon status --json
curl -fsS http://127.0.0.1:3850/health/ready
```

## Before updating

1. Record the installed version and daemon status.
2. Back up the private workspace state using your approved encrypted backup process.
3. Preserve `agent.yaml` before correcting a configuration migration error.
4. Do not delete the database, auth secret, or secret store to force an upgrade through.

For the first-party Docker deployment, pull the configured image and recreate the services:

```bash
cd deploy/docker
docker compose pull
docker compose up -d
```

See [Self-Hosting](/self-hosting/) for the persistent volume and initial auth boundary.

## Configuration migration

Current configuration uses the workspace `agent.yaml`, with canonical inference routing for model selection. `memory.synthesis` is retired and rejected by the loader. If an old workspace fails to start after an update:

1. Preserve the exact daemon error.
2. Make the smallest source-backed change to the named configuration key.
3. Restart the daemon.
4. Verify status, readiness, and the affected workflow.

Do not revive removed provider or synthesis configuration just because an old guide mentions it. Use [Inference and routing](/configuration/inference-routing/) for current target and workload bindings.

## After updating

```bash
signet daemon status --json
curl -fsS http://127.0.0.1:3850/health/live
curl -fsS http://127.0.0.1:3850/health/ready
curl -fsS http://127.0.0.1:3850/api/diagnostics
```

Then test the feature you depend on: a bounded recall, a provider route, or a remote connector authentication check. A green version command does not prove the daemon's workspace, migration, inference route, or connector are healthy.

## Rollback and incident handling

If a release fails after a verified backup, stop the daemon, preserve logs and the workspace, and follow the deployment mechanism's rollback procedure. Restore private state only from a known-good backup. File deletion is not a migration strategy.

Related: [Daemon](/daemon/), [Diagnostics](/diagnostics/), [Configuration](/configuration/).

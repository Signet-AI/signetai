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

## Update channels

Signet has two update channels:

- `stable` follows the npm `latest` tag and GitHub's latest release. It is the default.
- `nightly` follows the npm `next` tag, which is a development prerelease or the newer stable release.

A stable release advances both tags. A development release advances only `next`. Tags move forward in version order, so nightly follows stable when no development build is newer. Stable users never move to a development prerelease.

Show or set the channel:

```bash
signet update channel
signet update channel nightly
signet update channel stable
```

`latest` and `next` are accepted as aliases for `stable` and `nightly`. The daemon stores the choice in `agent.yaml`:

```yaml
updates:
  auto_install: false
  check_interval: 21600
  channel: stable
```

Install a channel directly:

```bash
npm install -g signetai
npm install -g signetai@next
curl -fsSL https://signetai.sh/install.sh | SIGNET_CHANNEL=nightly bash
```

On Windows, set `$env:SIGNET_CHANNEL = "nightly"` before running `iwr -useb https://signetai.sh/install.ps1 | iex`.

`SIGNET_RELEASE_TAG`, `SIGNET_VERSION`, and `VERSION` pin an explicit version in the installer.

Native updates check each asset's size and SHA-256 against the release manifest. These checks detect incomplete or corrupted downloads. They do not authenticate the manifest.

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

## Workspace layout upgrade

The first time a v2-aware daemon starts on a v1 workspace, it upgrades the
layout in place under the same workspace root before it opens the database. Do
not copy, move, or delete workspace directories by hand. If the upgrade cannot
proceed safely, the daemon leaves the workspace on v1, starts normally, and
reports the reason in `signet status` (`workspaceLayout.upgrade`); fix the cause
and restart to retry. A workspace whose daemon is still running under an older
release is upgraded after that daemon stops. After the upgrade, do not run an
older release that predates layout support against the workspace. See
[Workspace v2](/workspace-v2/) for the paths that move.

## Rollback and incident handling

If a release fails after a verified backup, stop the daemon, preserve logs and the workspace, and follow the deployment mechanism's rollback procedure. Restore private state only from a known-good backup. File deletion is not a migration strategy.

Related: [Daemon](/daemon/), [Diagnostics](/diagnostics/), [Configuration](/configuration/).

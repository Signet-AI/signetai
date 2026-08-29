---
title: "Daemon"
description: "Operate the Signet daemon: lifecycle, network binding, health, logs, and runtime boundaries."
---

The Signet daemon owns the HTTP API, dashboard, workspace database, background workers, diagnostics, telemetry, and harness-facing services. Its default local address is `http://127.0.0.1:3850`.

## Lifecycle

```bash
signet daemon start
signet daemon stop
signet daemon restart
signet daemon status --json
signet daemon logs
```

Top-level `signet start`, `signet stop`, `signet restart`, and `signet logs` remain aliases. Prefer the `signet daemon` form in automation and operator runbooks.

A successful process start is not readiness. Verify both process state and readiness after a restart:

```bash
signet daemon status --json
curl -fsS http://127.0.0.1:3850/health/live
curl -fsS http://127.0.0.1:3850/health/ready
```

`/health/live` is a cheap process liveness probe. `/health/ready` includes readiness gates and can return a non-success response while the daemon is still starting or a required subsystem is unavailable.

## Network binding

`SIGNET_PORT` defaults to `3850`. `SIGNET_BIND` controls the listening interface. `SIGNET_HOST` is the daemon's local-call host. `SIGNET_PATH` selects the workspace for the process.

The default network mode is loopback-only. For a trusted tailnet or private LAN, configure the workspace and restart:

```yaml
network:
  mode: tailscale
```

```bash
signet daemon restart
signet daemon status --json
```

A deployment manager can override the bind address explicitly:

```bash
SIGNET_BIND=0.0.0.0 SIGNET_PORT=3850 signet daemon start
```

An exposed interface is not an authentication setting. Use `auth.mode: team` for an untrusted or Internet-facing deployment. `hybrid` is convenient for a trusted workstation, but is not a public reverse-proxy security boundary. See [Authentication](/auth/) and [Self-Hosting](/self-hosting/).

## Runtime configuration

The daemon loads `agent.yaml` from the selected workspace. Some files and service settings can be observed after startup, but long-running pipeline workers begin from a configuration snapshot. Restart after changing pipeline, embedding, inference, auth, or network configuration.

```bash
signet daemon restart
signet daemon status --json
```

Do not assume a file watcher makes every configuration key live. Use `/api/status`, `/api/pipeline/status`, readiness, and representative operator checks to confirm the intended effect.

## Operator endpoints

| Endpoint                                                  | Purpose                                                   |
| --------------------------------------------------------- | --------------------------------------------------------- |
| `/health`, `/health/live`, `/health/ready`                | Liveness and readiness probes.                            |
| `/api/status`                                             | Daemon, binding, workspace, runtime, and update state.    |
| `/api/pipeline/status`                                    | Pipeline state and runtime configuration summary.         |
| `/api/diagnostics`                                        | Health report for authenticated operators where required. |
| `/api/repair/*`                                           | Explicit repair actions with admin protection.            |
| `/api/analytics/*`, `/api/telemetry/*`, `/api/timeline/*` | Operational metrics and investigation surfaces.           |

The full request and response surface is in [HTTP API](/api/). Do not automate against a dashboard rendering when an API endpoint exists.

## Logs and local state

Runtime state lives under `$SIGNET_WORKSPACE/.daemon/`. By default, daemon logs are written there; `SIGNET_LOG_FILE` can select an explicit log file and `SIGNET_LOG_DIR` can select a log directory. Use the CLI first:

```bash
signet daemon logs
```

If the daemon will not start, capture the exact validation error and preserve the workspace before changing data. Do not delete the SQLite database, auth secret, or PID file as a routine recovery step.

## Persistent deployment

The CLI manages daemon lifecycle; first-party persistent container deployment is documented in [Self-Hosting](/self-hosting/). If you run a host service manager, make it own a single daemon process, set `SIGNET_PATH` and networking explicitly, and verify restart behavior with health probes. Do not point multiple writers at one workspace.

Related: [Diagnostics](/diagnostics/), [Analytics](/analytics/), [Authentication](/auth/), [Upgrading](/upgrading/).

---
title: "Analytics"
description: "Operational metrics, telemetry audit data, logs, and incident investigation endpoints."
---

Analytics is the daemon's current operational view. It is not a replacement for source data, workspace backups, or a monitoring system.

## Operational endpoints

These endpoints require analytics permission in authenticated deployments:

| Endpoint                               | Use                                                     |
| -------------------------------------- | ------------------------------------------------------- |
| `GET /api/analytics/usage`             | Request, actor, provider, and connector counters.       |
| `GET /api/analytics/errors`            | Recent errors; supports stage, time, and limit filters. |
| `GET /api/analytics/latency`           | Latency summary.                                        |
| `GET /api/analytics/logs`              | Recent structured daemon log entries.                   |
| `GET /api/analytics/memory-safety`     | Memory safety metrics.                                  |
| `GET /api/analytics/continuity`        | Continuity state.                                       |
| `GET /api/analytics/continuity/latest` | Latest continuity summary.                              |
| `GET /api/telemetry/events`            | Recorded telemetry event view.                          |
| `GET /api/telemetry/health`            | Telemetry collector state.                              |
| `GET /api/timeline/*`                  | Timeline investigation routes.                          |

Start with a bounded query and correlate it with daemon status and diagnostics:

```bash
curl -fsS http://127.0.0.1:3850/api/analytics/errors?limit=20
curl -fsS http://127.0.0.1:3850/api/analytics/latency
curl -fsS http://127.0.0.1:3850/api/diagnostics
```

Counters and in-memory buffers are runtime observations. They can reset when the daemon restarts. Use durable logs, database state, and the affected source when investigating a persistent incident.

## Telemetry

Daemon and CLI telemetry are configured at `memory.pipelineV2.telemetryEnabled` and default to off. Only explicit `true` enables collection. Missing means not yet answered; `false` means declined. Interactive setup, update install, and the dashboard ask once. You can keep it off explicitly with:

```yaml
memory:
  pipelineV2:
    telemetryEnabled: false
```

Use `signet telemetry` to inspect consent, `signet telemetry on` or `signet telemetry off` to change it, or Settings → Advanced. Changes apply without restarting. Automated setup never prompts or writes a consent choice.

The npm package separately sends an anonymous install count before consent. Set `SIGNET_TELEMETRY_OPTOUT=1` before installing to skip it. For a process-local opt-out that also suppresses consent prompts without editing configuration:

```bash
SIGNET_TELEMETRY_OPTOUT=1 signet daemon start
```

The daemon writes recorded telemetry events to:

```text
$SIGNET_WORKSPACE/runtime/telemetry/events.jsonl
```

PostHog delivery is best-effort and depends on telemetry configuration. The local JSONL audit is the inspection surface; it lets an operator see what was recorded without treating a remote dashboard as the source of truth.

Telemetry is designed to avoid memory content, user identity, file paths, and raw secrets. The audit log is still workspace-private operational data: do not commit it or paste it into a public issue without review.

## Investigation workflow

1. Check daemon state and `/health/ready`.
2. Pull a bounded recent error and latency view.
3. Identify the affected request, session, source, provider, or queue.
4. Inspect the original source and daemon logs.
5. Use [Diagnostics](/diagnostics/) for health or repair decisions.
6. Re-run the same bounded query after a change to verify the outcome.

Related: [Daemon](/daemon/), [Diagnostics](/diagnostics/), [Configuration](/configuration/).

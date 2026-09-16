---
title: "Analytics"
description: "Inspect operational metrics, telemetry, and daemon logs."
---

Analytics reports runtime observations. It does not replace source data, workspace backups, or an external monitoring system.

## Permission and routes

In authenticated deployments, each operational route applies its own authorization. Analytics routes use the `analytics` permission; telemetry and timeline routes have separate route guards.

| Route | Purpose |
|---|---|
| `GET /api/analytics/usage` | Request, actor, provider, and connector counters |
| `GET /api/analytics/errors` | Recent errors with stage, time, and limit filters |
| `GET /api/analytics/latency` | Latency summary |
| `GET /api/analytics/logs` | Recent structured daemon logs |
| `GET /api/analytics/memory-safety` | Memory-safety metrics |
| `GET /api/analytics/continuity` | Continuity state |
| `GET /api/analytics/continuity/latest` | Latest continuity summary |
| `GET /api/telemetry/events` | Recorded telemetry events |
| `GET /api/telemetry/health` | Telemetry collector state |
| `GET /api/timeline/*` | Timeline investigation routes |

Use bounded queries and correlate them with readiness and diagnostics:

```bash
curl -fsS 'http://127.0.0.1:3850/api/analytics/errors?limit=20'
curl -fsS http://127.0.0.1:3850/api/analytics/latency
curl -fsS http://127.0.0.1:3850/api/diagnostics
```

Counters and in-memory buffers describe the current daemon lifetime. Use logs, database state, and the affected source for persistent incidents.

## Telemetry

Telemetry is enabled by default through `memory.pipelineV2.telemetryEnabled`. Opt out in configuration or for one process:

```yaml
memory:
  pipelineV2:
    telemetryEnabled: false
```

```bash
SIGNET_TELEMETRY_OPTOUT=1 signet daemon start
```

The local audit file is `$SIGNET_WORKSPACE/.daemon/telemetry/events.jsonl`. Treat it as private operational data. Telemetry is designed to omit memory content, user identity, file paths, and raw secrets; review events before sharing them.

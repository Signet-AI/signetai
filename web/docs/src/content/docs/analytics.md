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

Signet telemetry is anonymous. It reports install counts, usage, crashes, and token and cost counts per provider, so the project can see how Signet runs and what it costs.

### Consent

Daemon and CLI telemetry are configured at `memory.pipelineV2.telemetryEnabled` and default to off. Only explicit `true` enables collection. Missing means not yet answered; `false` means declined. Interactive `signet setup`, a successful interactive `signet update install`, and the dashboard ask once, with No as the default. Non-interactive, `--file`, `--json`, and `--dry-run` runs never ask or write a choice.

Keep it off explicitly with:

```yaml
memory:
  pipelineV2:
    telemetryEnabled: false
```

The key must be nested under `memory.pipelineV2`. A top-level `pipelineV2` key is ignored.

Inspect or change consent with:

```bash
signet telemetry
signet telemetry on
signet telemetry off
```

Settings → Advanced shows the same states. Changes apply without restarting the daemon. Opting out discards unsent events and aborts in-flight delivery.

The npm package separately sends one anonymous install count before consent. Set `SIGNET_TELEMETRY_OPTOUT=1` before installing to skip it. `SIGNET_TELEMETRY_OPTOUT=1` or `true` also disables the daemon collector, CLI events, and consent prompts for that process:

```bash
SIGNET_TELEMETRY_OPTOUT=1 signet daemon start
```

Set it in CI and scripted environments.

### Where events go

- PostHog cloud (US region, `https://us.i.posthog.com`). The key shipped with Signet can only send events, not read them.
- Local SQLite `telemetry_events`, kept 90 days by default.
- A local audit log, described below.

Events are identified by a random per-install UUID. Delivery is best-effort and never blocks the daemon. A failed request leaves events queued for a later attempt.

These keys under `memory.pipelineV2` tune delivery:

| Key | Default | Meaning |
| --- | --- | --- |
| `telemetry.posthogHost` | `https://us.i.posthog.com` | PostHog URL. Empty disables sending. |
| `telemetry.flushIntervalMs` | `60000` | Time between flushes. Range 5 seconds to 10 minutes. |
| `telemetry.flushBatchSize` | `50` | Events per flush. Range 1 to 500. |
| `telemetry.retentionDays` | `90` | Days before local telemetry data is purged. Range 1 to 365. |
| `telemetry.deploymentRole` | `unknown` | `personal`, `service`, `automation`, `development`, `ci`, or `unknown`. |
| `telemetry.installChannel` | `unknown` | `desktop`, `package-manager`, `source`, `container`, or `unknown`. |

`SIGNET_TELEMETRY_DEPLOYMENT_ROLE` and `SIGNET_TELEMETRY_INSTALL_CHANNEL` override the last two. `SIGNET_TELEMETRY_ENV=dev` tags events as development. It is not an opt-out.

Embedding cost rates, in USD per million input tokens, are set under `embedding.costRates`.

### Audit log

After consent, each daemon and CLI event is appended as one JSON line to:

```text
$SIGNET_WORKSPACE/runtime/telemetry/events.jsonl
```

This file is the exact record of what Signet recorded. The install count is not written to it. The log is workspace-private: do not commit it or paste it into a public issue without review.

`GET /api/telemetry/health` and the dashboard Logs panel show aggregate delivery state without event payloads.

### What is never collected

- Memory content, recall query text, prompt text, and responses.
- File paths, usernames, and email addresses.
- Command arguments. The CLI sends only the top-level command name.
- Raw agent names. Inference events carry a salted per-install hash.
- Raw secrets, endpoints, credentials, and provider messages.

Crash reports contain the error type, a message truncated to 400 characters, the top 8 stack frames, and uptime. Home directory paths are replaced with `~`. Resource and runtime-pressure data is sent as coarse buckets, never raw values.

PostHog sees the request IP address on receipt and derives city and country from it.

`memorySearchQaEnabled` is a separate local-only recall QA ledger. It stores query text and result snapshots on your machine and is never sent.

### Events

Daemon and CLI:

- `install.ping`: npm install count, sent before consent.
- `install.activated`: first collector start after opt-in.
- `first.remember`, `first.recall`: first successful remember and recall, once per install.
- `daemon.started`: daemon boot.
- `daemon.previous_exit`: how the previous run ended (`clean`, `error`, or `unrecorded`).
- `daemon.heartbeat`: every 5 minutes, with version, platform, memory count, active connectors, and bucketed process resource use.
- `telemetry.health`: delivery queue state, logged on each flush.
- `session.start`, `session.turn`, `session.end`: session counts keyed by a hash of the session key, with token and cost totals on end.
- `llm.generate`: LLM call latency, tokens, cost, provider, and model.
- `pipeline.embedding`: embedding tokens, provider, and cost.
- `recall.performed`, `recall.attempted`, `recall.outcome`: recall type, result counts, latency, and delivery outcome by surface.
- `source.lifecycle`: bucketed source connect, index, readiness, and freshness milestones.
- `pipeline.error`, `pipeline.operation`: failure stage and code, and one summary per logical operation.
- `dreaming.pass`: outcome, token and cost totals, and effect counts for each dreaming pass.
- `inference.route`, `inference.execute`, `inference.stream`, `inference.fallback`: routing decisions and outcomes.
- `error.occurred`: sanitized crashes, unhandled rejections, and event-loop stalls.
- `version.upgraded`, `version.observed`: version changes.
- `command.invoked`: CLI command name.

Marketing site (`signetai.sh` only, no automatic capture, no session recording):

- `marketing.page_view`
- `marketing.cta_clicked`
- `marketing.harness_selected`
- `marketing.install_surface_opened`
- `marketing.command_copied`
- `marketing.guide_opened`
- `marketing.docs_search_state`, which sends result-count and query-length buckets, never query text.
- `marketing.outbound_clicked`, which sends a destination category, not the URL.

## Investigation workflow

1. Check daemon state and `/health/ready`.
2. Pull a bounded recent error and latency view.
3. Identify the affected request, session, source, provider, or queue.
4. Inspect the original source and daemon logs.
5. Use [Diagnostics](/diagnostics/) for health or repair decisions.
6. Re-run the same bounded query after a change to verify the outcome.

Related: [Daemon](/daemon/), [Diagnostics](/diagnostics/), [Configuration](/configuration/).

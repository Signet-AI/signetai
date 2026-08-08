# Telemetry

> Single source of truth for Signet's anonymous product telemetry. When
> adding or changing an event, a config flag, or the privacy contract, update
> this document — not the telemetry sections of CONFIGURATION.md, ANALYTICS.md,
> or PIPELINE.md in parallel.

## What telemetry is and why

Signet ships an anonymous, default-on telemetry collector so the project can
understand how it runs in the wild. It answers three questions:

- **Install and usage analytics** — how many installs, on which platforms and
  versions, how much the daemon is used.
- **Crash diagnostics** — sanitized reports of process-level crashes and
  wedged event loops, enough to reproduce and fix remotely.
- **Per-install economics** — token and cost counts per provider, so the
  project can reason about what running Signet actually costs.

Telemetry is opt-out, not opt-in: `telemetryEnabled: false` in config, or
`SIGNET_TELEMETRY_OPTOUT=1` in the environment. It never carries memory
content, query text, prompt text, or personal identity (see the
[privacy contract](#privacy-contract)). Sending is best-effort and can never
break the daemon.

## Where events go

- **PostHog cloud** — project **547297** (US region), host
  `https://us.i.posthog.com`, `POST /batch/` endpoint. The project API key is a
  public ingest key by PostHog design; it is not a secret.
- **`distinct_id`** — a random per-install anonymous UUID persisted in the
  `telemetry_install` table (migration 109). One id per daemon-using install,
  stable across restarts. The daemon attaches `$lib: "signet-daemon"` and
  `$lib_version` to every batch; the install ping uses
  `$lib: "signet-install"`.
- **Local SQLite** — every event is also written to `telemetry_events` (90-day
  retention, pruned every 10th flush) with a `sent_to_posthog` flag marking
  successful batch delivery.
- **Open JSONL log** — every recorded event is mirrored as one JSON line to
  `<agentsDir>/.daemon/telemetry/events.jsonl`, the inspectable audit surface
  (see [below](#the-open-audit-log)).

The collector buffers events in memory (auto-flush at 200 events, hard cap
5000), flushes on the configured interval, backs off 5x after 3 consecutive
PostHog failures, and never throws into the daemon.

## Event catalog

| Event | When | Key payload fields |
|---|---|---|
| `install.ping` | npm wrapper postinstall (native binary install) | `version`, `platform` |
| `install.activated` | first daemon run of a new install (persisted install id first created) | `version`, `platform` |
| `first.remember` / `first.recall` | first successful remember / recall per install, exactly once | `version`, `platform` |
| `daemon.started` | daemon boot | `version`, `platform`, `uptimeMs` |
| `daemon.heartbeat` | every 5 minutes | `uptimeMs`, `memoryCount`, `connectorsActive`, `pipelineMode`, `extractionProvider`, `embeddingProvider` |
| `session.start` | real session start (deduped; stubs and clear/reset paths don't count) | `harness`, `sessionHash` |
| `session.turn` | every `session-end` hook call (per turn, see notes) | `harness`, `promptCount`, `sessionHash` |
| `session.end` | real session termination: explicit `reason: "clear"`, or a TTL-evicted (abandoned) session claim | `harness`, `reason` (`clear` / `expired`), `sessionHash` |
| `llm.generate` | every LLM call | `provider`, `latencyMs`, `success`, `inputTokens`, `outputTokens`, `cacheReadTokens`, `cacheCreationTokens`, `totalCost` |
| `pipeline.embedding` | every embedding fetch, at the usage-recording boundary | `tokens`, `provider`, `sourceKind` (`memory-capture` / `artifact-index` / `recall` / `dreaming` / `other`) |
| `recall.performed` | every completed shared recall search | `type` (`semantic` / `keyword` / `temporal` / `graph`), `results`, `latencyMs`, `truncated` |
| `pipeline.error` | categorized extraction, decision, or embedding failure | `stage`, `code` only; no message or stack content |
| `dreaming.pass` | completed agentic dreaming pass (early-exit passes emit nothing) | `mode`, `tokensInput`, `tokensOutput`, `tokensCacheRead`, `tokensCacheWrite`, `cost` |
| `inference.route` | inference control-plane routing decision | `surface`, `agentId`, `operation`, `taskClass`, `policyId`, `selectedTarget`, `candidateCount`, `blockedCount`, `allowedCount`, `privacy`, `durationMs`, `success`, `errorCode` |
| `inference.execute` / `inference.stream` | per-execution outcome | `surface`, `agentId`, `operation`, `taskClass`, `policyId`, `selectedTarget`, `finalTarget`, `attemptPath`, `failedTargets`, `attemptCount`, `failedCount`, `fallbackCount`, `privacy`, `durationMs`, `inputTokens`, `outputTokens`, `success`, `cancelled`, `errorCode` |
| `inference.fallback` | emitted alongside execute/stream when a target failed and routing fell back | same fields as execute/stream |
| `error.occurred` | process-level crash, unhandled rejection, or event-loop wedge | `type`, `message`, `stack`, `uptimeMs`; `EventLoopLag` reports add `lagMs` |
| `version.upgraded` | daemon auto-update path only | `from`, `to` |
| `command.invoked` | CLI command (name only, never arguments) | `command` |

Declared but **not yet emitted**: `pipeline.extraction` and
`pipeline.decision`.

Notes on individual events:

- **`install.ping`** — the wrapper postinstall counter. Each ping uses a
  *fresh throwaway UUID*, so it never joins the daemon's persisted id: one
  physical install is two PostHog users across ping and daemon events. Bun
  global installs skip the postinstall and desktop installs never run it, so
  the ping structurally undercounts both populations.
- **`install.activated`** — emitted exactly once, when the persisted install
  id is first created. It covers bun, desktop, and npm uniformly and is the
  **active installs** metric. Count distinct ids with `install.activated`;
  never sum ping and activated counts.
- **Session events (#1212)** — the three events measure different things and
  are deliberately not comparable with each other: `session.start` fires once
  per real session start (deduped per session key; resumed sessions do not
  re-fire); `session.turn` fires on every `session-end` hook call, which
  harnesses invoke per turn to persist messages — a *turns persisted* volume
  counter; `session.end` fires only at real terminations (explicit
  `reason: "clear"`, or TTL-evicted abandoned claims), deduped once per
  session lifetime via `session-end-state.ts` (in-memory, cleared on real and
  clear session starts). All three carry `sessionHash`, a 16-hex sha256 of the
  normalized session key, so distinct sessions and concurrency are countable
  without leaking raw keys. Cleanly-finished sessions that never send
  `clear` are not counted as ended — only provable terminations are.
- **`first.remember` / `first.recall`** — the activation funnel. Emitted
  exactly once per install, when the first successful remember / recall
  completes (guarded by an atomic claim on the persisted install id, so
  concurrent or repeated calls can't double-fire). Events carry only
  `version` and `platform` — no content, no query text, no agent ids. The
  funnel query is activated vs activated+first.remember vs +first.recall
  (below). A deduped remember counts; the automatic recall injected into
  prompt-submit context does not — only the explicit recall route fires it.
- **`dreaming.pass`** — dreaming is the largest token consumer (millions of
  input tokens per heavy install), so always include it in token/cost
  aggregates.
- **`recall.performed`** — emitted at the shared `hybridRecall` boundary with
  counts and timing only. Aggregate recall can emit one event for the main
  search and additional events for decomposed subqueries. Local stats read the
  flushed telemetry table, so they can lag the in-memory event buffer by one
  flush interval.

## Privacy contract

- **Anonymous per-install UUIDs.** The `distinct_id` is a random UUID
  persisted in the workspace database. No email, name, or account is ever
  sent; PostHog persons show up as the UUID.
- **No content.** Events carry no memory content, no recall query text, no
  prompt text, and no file paths. `llm.generate` records token/cost counts,
  latency, provider, and success — never the prompt or response.
- **Sanitized crash reports.** `error.occurred` captures the error type, a
  message truncated to 400 characters with control characters replaced and
  `/home/<user>` / `/Users/<user>` paths stripped to `~`, the top 8 stack
  frames with home directories removed, and uptime in ms. `EventLoopLag`
  reports (the event-loop-wedge class) are rate-limited to once per 10
  minutes per process so a stuck loop can't flood the project. No memory
  content is ever captured anywhere, so errors cannot carry it by design.
- **Agent ids in `inference.*` are hashed.** Inference events carry
  `agentId` as a SHA-256 hash salted with the per-install install id (16 hex
  chars). Stable within an install (per-agent analysis still works), not
  joinable across installs, not reversible — the raw agent name is never
  sent. (Hashed in `telemetry.anonymizeAgentId`; previous versions sent it
  as-is.)
- **Geo.** PostHog captures `$ip` server-side on every event and derives
  city/country from it. The wrapper cannot suppress this; it is an open
  question whether to send `$ip: null` or soften the no-IP claim (issue
  #1200).
- **`memorySearchQaEnabled` is separate and local-only.** It writes a recall
  QA ledger that *intentionally* includes query text and result snapshots. It
  is exposed only through analytics-gated endpoints and is never sent to
  PostHog.

## Configuration

All telemetry keys live under `memory.pipelineV2` in `agent.yaml`:

| Key | Default | Range | Description |
|---|---|---|---|
| `telemetryEnabled` | `true` | boolean | Master switch; `false` opts out |
| `telemetry.posthogHost` | `https://us.i.posthog.com` | — | PostHog instance URL; empty disables sending |
| `telemetry.posthogApiKey` | public ingest key | — | PostHog project API key shared by daemon and CLI |
| `telemetry.flushIntervalMs` | `60000` | 5s-10min | Time between event flushes |
| `telemetry.flushBatchSize` | `50` | 1-500 | Max events per flush batch |
| `telemetry.retentionDays` | `90` | 1-365 | Days before local telemetry data is purged |
| `memorySearchQaEnabled` | `false` | boolean | Local-only recall QA ledger (never sent) |

**Nesting pitfall (regression-pinned):** the daemon reads the flag via
`loadPipelineConfig` from `yaml.memory.pipelineV2`. A *top-level*
`pipelineV2.telemetryEnabled` key is invisible to the daemon — the original
setup disclosure wrote top-level and the opt-out silently did nothing until
fixed (1d014075). Setup/CLI writers must write into `memory.pipelineV2`.

**Runtime opt-out:** `SIGNET_TELEMETRY_OPTOUT=1` (or `true`) in the daemon's
environment disables both the daemon collector and the install ping — one
knob for the whole product. CI runners, containers, and scripted
environments should set it so automated daemon boots don't count as
installs.

**Disclosure:** `signet setup` tells users telemetry is on by default and
asks whether to disable it. Declining writes `telemetryEnabled: false`;
non-interactive/CI setups keep the default (enabled).

## The open audit log

Every recorded event is appended as one JSON line to
`<agentsDir>/.daemon/telemetry/events.jsonl` — daemon events and CLI
`command.invoked` lines alike. It is the single inspectable surface for
exactly what was recorded: users can audit the file without trusting the
sink. The CLI appends `command.invoked` (command name only) locally,
best-effort, with no daemon round-trip or auth, gated on the same
`memory.pipelineV2.telemetryEnabled` flag. `command.invoked` is JSONL-only —
it is never flushed to PostHog.

## Known semantics quirks

- `pipeline.embedding` is tokens-only; embedding cost accounting is pending
  (#1201).
- `install.ping` and `install.activated` measure different populations —
  report them as complementary, never summed.
- CI and dev fleets inflate "user" counts: every automated daemon boot with
  default config is a phantom install. Identify them as `daemon.started`
  without a matching `install.ping`, and set `SIGNET_TELEMETRY_OPTOUT=1` in
  workflows. Dev-install tagging (`SIGNET_TELEMETRY_ENV=dev`) is under
  discussion (#1200).
- Flush cadence is the configured interval (default 60s); a freshly started
  daemon takes up to a minute to appear in PostHog.

## How to query

The project is PostHog **547297** (US region). The shipped ingest key is
ingest-only by PostHog design and **cannot read data** — query with a
personal API key (`phx_…`) that has `query:read`, e.g. via the PostHog CLI:

```bash
export POSTHOG_CLI_HOST=https://us.posthog.com POSTHOG_CLI_PROJECT_ID=547297 POSTHOG_CLI_API_KEY=<phx key>
bunx -y @posthog/cli@latest api call --json execute-sql '{"query": "<hogql>"}'
```

HogQL examples that work:

```sql
-- events by type
select event, count() as n from events group by event order by n desc
-- active installs (distinct ids that ever activated)
select distinct_id, count() as n from events where event = 'install.activated' group by distinct_id
-- activation funnel: activated vs used (first remember) vs recalled
select
  count(distinct distinct_id) as activated,
  count(distinct if(event = 'first.remember', distinct_id, null)) as first_remember,
  count(distinct if(event = 'first.recall', distinct_id, null)) as first_recall
from events where event in ('install.activated', 'first.remember', 'first.recall')
-- llm cost by provider
select properties.provider as provider, count() as calls, sum(properties.totalCost) as cost
  from events where event = 'llm.generate' group by provider
```

The local daemon also exposes `/api/telemetry/stats` (llm, embedding, recall,
and dreaming aggregates from the local `telemetry_events` table) — see
[docs/api/telemetry-logs.md](./api/telemetry-logs.md). A local analytics
vault mirrors the key PostHog aggregates for daily review via
`scripts/sync-analytics.py`.

## Changelog of event additions

| Release | Change |
|---|---|
| 0.170.0 | Per-install PostHog analytics: daemon collector, default-on (#1026) |
| 0.171.0 | Phase 2 (#1026): open JSONL audit log, lifecycle events (`daemon.started`, `daemon.heartbeat`, `session.start`/`session.end`, `error.occurred`, `version.upgraded`, `command.invoked`), wrapper install ping, default-on disclosure in setup; fix setup opt-out to write `memory.pipelineV2` |
| 0.172.0 | `pipeline.embedding` with stats (#1181) |
| 0.173.0 | `install.activated` on first daemon run |
| 0.174.0 | `dreaming.pass` with provider-reported token usage and cost |
| 0.176.0 | Sanitized crash reports: full `error.occurred` payload (truncated, home-stripped message + top-8 stack frames) and rate-limited `EventLoopLag` wedge reports |
| next | `session.turn` + real `session.end` split (#1212): the per-turn event renamed from the old `session.end`; `session.end` now fires only at real terminations, deduped per lifetime; `sessionHash` added to all three session events |
| Unreleased | `recall.performed` with anonymous recall type, result count, latency, and truncation metrics (#1203) |
| Unreleased | First-run activation funnel: `first.remember` / `first.recall`, exactly once per install (#1202) |

Related: #1026 (original rollout), #1200 (IP capture, dev tagging),
#1201-#1207 (event-scoped follow-ups), #1212 (session.end rename — resolved).

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
- **Local SQLite** — daemon events are written to `telemetry_events` (90-day
  retention, pruned every 10th flush) with a `sent_to_posthog` flag marking
  successful batch delivery. CLI command events are written there when remote
  delivery is configured and a telemetry SQLite database with its tables is
  available.
- **Open JSONL log** — every recorded event is mirrored as one JSON line to
  `<agentsDir>/.daemon/telemetry/events.jsonl`, the inspectable audit surface
  (see [below](#the-open-audit-log)).

CLI `command.invoked` events follow the same contract as daemon events: they
are written to the local JSONL log and, when PostHog delivery is configured
and a telemetry SQLite database with its tables is available, queued in the
SQLite database, then best-effort flushed to PostHog using the persisted
per-install id. CLI delivery is bounded by the configured batch size and a
two-second request timeout; a failed request leaves the event queued for a
later attempt.

The collector buffers events in memory (auto-flush at 200 events, hard cap
5000), flushes on the configured interval, backs off 5x after 3 consecutive
PostHog failures, and never throws into the daemon. Every scheduled flush
also emits one bounded `telemetry.health` event. Its local-only aggregate
fields include queue depth, oldest unsent age, daemon activity freshness,
delivery success/failure counts for the last 24 hours, backoff state, and
dropped-buffer count. The event is logged locally before the delivery attempt,
so it remains diagnostically useful during a remote outage.

Delivery state is persisted in `telemetry_delivery_state` and queue rows keep
stable event IDs for PostHog `$insert_id` de-duplication across retries. A
timeout remains an indeterminate remote result, so the row is retried rather
than marked sent. Retention pruning removes delivered rows only; daemon-owned
unsent rows remain available for later delivery up to the bounded 20,000-row
queue. CLI command rows have their own bounded 5,000-row queue because they
are flushed by short-lived CLI processes rather than the daemon. The authenticated
`GET /api/telemetry/health` route and the dashboard Logs panel expose the same
aggregate state without exposing event payloads, install IDs, credentials,
paths, or user identity.

## Event catalog

| Event | When | Key payload fields |
|---|---|---|
| `install.ping` | npm wrapper postinstall (native binary install) | `version`, `platform`, `deploymentRole`, `installChannel` (`package-manager`) |
| `install.activated` | first daemon run of a new install (persisted install id first created) | `version`, `platform`, `deploymentRole`, `installChannel` |
| `first.remember` / `first.recall` | first successful remember / recall per install, exactly once | `version`, `platform` |
| `daemon.started` | daemon boot | `version`, `platform`, `uptimeMs` |
| `daemon.previous_exit` | next successful boot reconciles the prior lifecycle record, exactly once when one exists | `classification` (`clean` / `error` / `unrecorded`), `reasonCategory`, `exitCode`, `previousVersion`, `previousUptimeMs`, `restartDelayMs` |
| `daemon.heartbeat` | every 5 minutes | `version`, `platform`, `uptimeMs`, `memoryCount`, `connectorsActive`, `pipelineMode`, `extractionProvider`, `embeddingProvider`, bounded runtime-pressure and process resource-utilization buckets |
| `telemetry.health` | every scheduled telemetry flush | `status`, `deliveryConfigured`, queue/buffer counts, unsent and delivery age buckets, recent success/failure counts, backoff state, dropped-event count, `flushIntervalMs` |
| `session.start` | real session start (deduped; stubs and clear/reset paths don't count) | `harness`, `sessionHash` |
| `session.turn` | every non-boundary `session-end` hook call (per turn, see notes) | `harness`, `promptCount`, `sessionHash` |
| `session.end` | real session termination: an explicit boundary reason or a TTL-evicted (abandoned) session claim | `harness`, `reason` (`clear` / `session.deleted` / `session_branch` / `session_fork` / `session_shutdown` / `session_switch` / `stale-session-sweep` / `expired`), `sessionHash`, `tokensInput`, `tokensOutput`, `tokensCacheRead`, `tokensCacheWrite`, `cost`, `accountingProvenance` |
| `llm.generate` | every LLM call | `provider`, `latencyMs`, `success`, `inputTokens`, `outputTokens`, `cacheReadTokens`, `cacheCreationTokens`, `totalTokens`, `totalCost`, `accountingProvenance` |
| `pipeline.embedding` | every embedding fetch, at the usage-recording boundary | `tokens`, `provider`, `sourceKind` (`memory-capture` / `artifact-index` / `recall` / `dreaming` / `other`), `cost` (USD), `accountingProvenance` |
| `recall.performed` | every completed shared recall search | `surface`, `type` (`semantic` / `keyword` / `temporal` / `graph`), `results`, `latencyMs`, `truncated` |
| `recall.attempted` | every valid recall request or automatic prompt-context retrieval attempt | `surface` (`explicit_api` / `tool_call` / `prompt_injection` / `dashboard` / `other`) |
| `recall.outcome` | result and delivery boundary for a recall attempt | `surface`, `resultState` (`empty` / `non_empty` / `truncated` / `error`), `deliveryState` (`returned` / `injected` / `consumed` / `not_delivered`), `results` |
| `source.lifecycle` | bounded source connect, index, readiness, first-recall, and recurring freshness milestones | `phase`, fixed `sourceClass`, bounded outcomes/counts/buckets |
| `pipeline.error` | categorized extraction, decision, or embedding failure | `stage`, `code` only; no message or stack content |
| `dreaming.pass` | every terminal agentic dreaming pass, including no-op, failed, and cancelled passes | `mode`, `outcome`, `outcomeCode`, bounded successful-target `provider` and `model` when available, `tokensInput`, `tokensOutput`, `tokensCacheRead`, `tokensCacheWrite`, `tokensTotal`, `cost`, `accountingProvenance`, `artifactsConsidered`, `memoriesCreated`, `memoriesUpdated`, `memoriesSuperseded`, `memoriesRetired`, `claimsChanged`, `relationshipsChanged`, `provenanceLinksChanged`, `toolCalls`, `durationMs` |
| `pipeline.operation` | one bounded summary for a logical indexing, capture, recall, dreaming, extraction, or other operation | `operationClass`, `outcome`, `accepted`, `skipped`, `retried`, `failed`, duration/queue-age buckets, optional `causeFamily` |
| `inference.route` | inference control-plane routing decision | `surface`, `agentId`, `operation`, `taskClass`, `policyId`, `selectedTarget`, `candidateCount`, `blockedCount`, `allowedCount`, `privacy`, `durationMs`, `success`, `errorCode` |
| `inference.execute` / `inference.stream` | per-execution outcome | `surface`, `agentId`, `operation`, `taskClass`, `policyId`, `selectedTarget`, `finalTarget`, `attemptPath`, `failedTargets`, `attemptCount`, `failedCount`, `fallbackCount`, `privacy`, `durationMs`, `inputTokens`, `outputTokens`, `success`, `cancelled`, `errorCode` |
| `inference.fallback` | emitted alongside execute/stream when a target failed and routing fell back | same fields as execute/stream |
| `error.occurred` | process-level crash, unhandled rejection, or event-loop wedge | `type`, `message`, `stack`, `uptimeMs`; `EventLoopLag` reports add `lagMs` and the latest bounded runtime-pressure buckets |
| `version.upgraded` | daemon auto-update path only | `from`, `to` |
| `version.observed` | daemon start sees a different persisted version (any update mechanism) | `from`, `to` |
| `command.invoked` | CLI command (name only, never arguments) | `command`, `deploymentRole`, `installChannel` |

### Marketing site events

The marketing site uses the same PostHog project with `surface: "marketing"`
and `$lib: "signet-web"` on every event. Automatic capture, automatic page
views, pageleave events, performance capture, heatmaps, console-log recording,
feature-flag/remote-config requests, session recording, surveys, and form capture
are disabled. Search telemetry sends only state and bounded result-count/query-length
buckets; it never sends query text. Guide, harness, and CTA links are classified
by their dedicated events; outbound events cover other external HTTP(S) links
and send destination categories rather than raw URLs.

| Event | When | Key payload fields |
|---|---|---|
| `marketing.page_view` | site route loads | `pageCategory`, `pagePath` |
| `marketing.cta_clicked` | marked CTA is clicked | `cta`, `placement`, page context |
| `marketing.harness_selected` | harness link is clicked | `harness`, page context |
| `marketing.install_surface_opened` | install method/surface tab is selected | `surfaceName`, `option`, page context |
| `marketing.command_copied` | install or setup command is copied | `commandKind`, `placement`, page context |
| `marketing.guide_opened` | marked guide or docs link is opened | `guide`, `destination`, page context |
| `marketing.docs_search_state` | docs search reaches a new state | `state`, `resultCountBucket`, `queryLengthBucket` |
| `marketing.outbound_clicked` | external HTTP(S) link is clicked | `destination`, page context |

Declared but **not yet emitted**: `pipeline.extraction` and
`pipeline.decision`.

`pipeline.error` remains the backward-compatible raw attempt stream. Product
reliability dashboards should use `pipeline.operation` for the primary
incident count: a source indexing job emits one summary regardless of how
many chunks or retries it contains. The local `/api/telemetry/stats` response
exposes both `pipelineErrors` (raw attempts) and `pipelineOperations.incidents`
(failed or partial logical operations), grouped by operation class and
normalized cause family. Operation events intentionally carry no operation id,
source id, content hash, path, provider message, stack, or input details.

Notes on individual events:

- **`daemon.previous_exit`** — emitted once by the next successful boot when
  a valid prior lifecycle record exists. `clean` and `error` come from terminal
  records; `starting` and `running` become `unrecorded`, because the prior
  process died before it could write a terminal state. The event never claims
  SIGKILL versus OOM, which the local record cannot distinguish. `reasonCategory`
  is a bounded category (`signal`, `update`, `uncaught_exception`,
  `unhandled_rejection`, `startup`, or `other`), and the duration, version, and
  exit-code fields are bounded. The raw lifecycle reason, error, PID, systemd
  unit, and local paths are not sent.
- **`install.ping`** — the wrapper postinstall counter. Each ping uses a
  *fresh throwaway UUID*, so it never joins the daemon's persisted id: one
  physical install is two PostHog users across ping and daemon events. Bun
  global installs skip the postinstall and desktop installs never run it, so
  the ping structurally undercounts both populations.
- **`install.activated`** — emitted exactly once, when the persisted install
  id is first created. It covers bun, desktop, and npm uniformly and is the
  **active installs** metric. Count distinct ids with `install.activated`;
  never sum ping and activated counts.
- **Deployment metadata** — every daemon and CLI event carries bounded
  `deploymentRole` and `installChannel` values. Both default to `unknown` and
  are set only by explicit configuration or the documented environment
  variables. `SIGNET_TELEMETRY_ENV=dev` remains compatible and maps the role
  to `development` while retaining `deployment: dev` and the `-dev` version
  suffix. `version.observed` is an observation, not an auto-update claim.
- **Session events (#1212/#1231)** — the three events measure different things and
  are deliberately not comparable with each other: `session.start` fires once
  per real session start (deduped per session key; resumed sessions do not
  re-fire); `session.turn` fires on every non-boundary `session-end` hook call, which
  harnesses invoke per turn to persist messages — a *turns persisted* volume
  counter; `session.end` fires only at real terminations (recognized explicit
  boundary reasons `clear`, `session.deleted`, `session_branch`, `session_fork`,
  `session_shutdown`, `session_switch`, or the internal `stale-session-sweep` reason, or
  TTL-evicted abandoned claims), deduped once per
  session lifetime via `session-end-state.ts` (in-memory, cleared on real and
  clear session starts). All three carry `sessionHash`, a 16-hex sha256 of the
  normalized session key, so distinct sessions and concurrency are countable
  without leaking raw keys. Cleanly-finished sessions that send a recognized
  lifecycle reason are counted as ended; ordinary per-turn hooks without one
  remain `session.turn` events.
- **`first.remember` / `first.recall`** — the activation funnel. Emitted
  exactly once per install, when the first successful remember / recall
  completes (guarded by an atomic claim on the persisted install id, so
  concurrent or repeated calls can't double-fire). Events carry only
  `version` and `platform` — no content, no query text, no agent ids. The
  funnel query is activated vs activated+first.remember vs +first.recall
  (below). A deduped remember counts; the automatic recall injected into
  prompt-submit context does not — only the explicit recall route fires it.
  The `session.end` token and cost fields are collector-derived sums of
  matching `llm.generate`, `dreaming.pass`, and `pipeline.embedding` events.
  Unscoped usage is attributed only when exactly one session is active;
  concurrent sessions are never guessed together. `accountingProvenance` is
  preserved from the matching events and becomes `mixed` when a total combines
  more than one accounting mode.
- **Accounting provenance** — every usage-bearing event records one bounded
  value: `provider_reported`, `locally_estimated`, `configured_rate`,
  `local_zero_cost`, or `unavailable`. A missing provider usage report is
  `unavailable`, not a zero-token or zero-cost result. The `/api/telemetry/stats`
  response exposes `coverage` per usage family with calls, tokens, and cost
  totals by provenance. Aggregate recall usage and session summaries use the
  same values, with `mixed` for combined totals. Session coverage includes a
  `mixed` bucket so those combined totals are not misclassified as
  `unavailable`.
- **`dreaming.pass`** — dreaming is the largest token consumer (millions of
  input tokens per heavy install), so always include it in token/cost
  aggregates. `outcome` is one of `completed`, `no-op`, `failed`, or
  `cancelled`; `outcomeCode` is bounded (`completed`, `no_work`,
  `no_effects`, `partial_failure`, `mutation_failure`, `timeout`,
  `cancelled`, or `error`). A successful pass with no durable graph effect is
  `no-op`; a focused pass that has no work is `no_work`. Provider usage fields
  remain null when unavailable, which is distinct from a no-op. Effect fields
  contain counts only: they never include artifact names, memory text,
  prompts, tool arguments, source paths, or raw agent identities. Semantic
  memory version replacements are counted as created/superseded rather than
  in-place updates. `artifactsConsidered` counts unique evidence references
  surfaced by the pass, `toolCalls` counts completed capability calls, and
  `durationMs` is the bounded wall-clock pass duration. When the routed run
  succeeds, `provider` is the normalized provider family and `model` is the
  configured model ID for the target that actually completed the pass,
  including a fallback target. These fields are omitted when no successful
  target metadata is available. They never contain target refs, account IDs or
  labels, endpoints, credential refs, agent identities, or content.
- **`recall.performed`** — emitted at the shared `hybridRecall` boundary with
  counts and timing only. Aggregate recall can emit one event for the main
  search and additional events for decomposed subqueries. It measures search
  execution, not delivery. Local stats read the flushed telemetry table, so
  they can lag the in-memory event buffer by one flush interval.
- **Normalized causes** are a bounded taxonomy: `context_limit`,
  `invalid_input`, `auth`, `quota`, `rate_limit`, `provider_unavailable`,
  `timeout`, `parse_failure`, `cancellation`, and `internal_error`. HTTP
  context-limit responses are classified locally from status and response
  shape, but the response body is never recorded or sent.
- **Runtime-pressure buckets (#1282)** — heartbeats and rate-limited
  `EventLoopLag` reports carry `runtimePressureVersion`, queue-depth and
  oldest-job-age buckets, active-worker and configured batch-size buckets,
  database and embedding latency buckets, process memory/CPU pressure buckets,
  `recoveryOutcome`, and a coarse `snapshotAgeBucket`. Heartbeat queue
  observations use capped, indexed probes and never scan the full queue. The
  wedge path reads only the latest observations, appends one bounded sanitized
  JSONL audit line for hard-kill survivability, and never enters SQLite or
  provider work. `recoveryOutcome` is
  `still_degraded` during an episode, `recovered` after the pressure state
  clears, and `restarted` on the first heartbeat after an abnormal prior exit.
- **Process resource-utilization buckets (#1424)** — the existing five-minute
  `daemon.heartbeat` is the only fleet sample boundary. It carries
  `resourceTelemetryVersion: 1`, `resourceScope: process`, and these fixed
  buckets: CPU `unavailable`, `zero`, `1-25%`, `26-75%`, `76-100%`,
  `101-200%`, `201+%`; RSS, heap-used, and macOS physical footprint
  `unavailable`, `zero`, `1-64MiB`, `65-128MiB`, `129-256MiB`, `257-512MiB`,
  `513-1024MiB`, `1025+MiB`. CPU is process utilization and may exceed 100%
  on a multicore machine. These fields never represent host-wide capacity.
  A missing physical-footprint reading is `unavailable`, not zero. The
  workload class is `normal`, `dreaming`, or `critical_pressure`, using the
  active Dreaming pass and existing pressure state at that heartbeat; critical
  pressure takes precedence. Local resource-monitor logs retain detailed raw
  measurements. Local `/api/telemetry/stats` reports bounded bucket totals
  from persisted heartbeat events. Platform, version, and existing provider
  fields remain available for grouping; no model or new workload classifier is
  inferred at this boundary.
- The process CPU bucket is the bounded `process.cpuUsage()` delta since the
  previous local resource snapshot. Other local health or diagnostics polls
  can shorten that sampling window; the fleet event still emits only the
  resulting bucket, never the duration or raw CPU value.
- **`recall.attempted` / `recall.outcome`** — the bounded retrieval-outcome
  contract (#1277). Attempts are recorded once at each supported recall
  surface. Outcomes separate empty, non-empty, truncated, and error results
  from the delivery boundary: explicit API and tool results are `returned`,
  automatic session-start and prompt-submit context is `injected`, and failed
  paths are `not_delivered`. `consumed` is reserved for a deliberate client
  acknowledgement; no client emits it by default. Surface values are fixed
  enums. No query, prompt, memory, citation, agent, or harness identifiers
  are included. Local stats expose attempted, returned, and delivered counts
  by surface; they read the flushed telemetry table and can lag the in-memory
  event buffer by one flush interval.
- **`command.invoked`** — CLI commands send only the bounded top-level command
  name to PostHog. Arguments, paths, user-defined names, and other command
  content are never included. The same event is available in the local JSONL
  audit log and, when a telemetry SQLite database with its tables is present,
  the SQLite queue.
- **`source.lifecycle` (#1276)** — emitted at operation boundaries, never once
  per document, message, chunk, or embedding. `phase` is `connect`, `index`,
  `readiness`, `first_recall`, or `freshness`; source identity is represented
  only by fixed source classes and local correlation state. Counts, sizes,
  durations, and freshness lag use bounded buckets; names, roots, URLs,
  identifiers, error text, queries, and content are omitted.

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
- **Bounded wedge context.** Runtime pressure contains fixed bucket labels,
  never raw queue counts, ages, latencies, RSS, CPU percentages, provider
  messages, queue errors, payloads, source names, paths, PIDs, or additional
  stack data. The existing once-per-10-minute `EventLoopLag` rate limit applies
  to the complete event, including its pressure envelope.
- **Process resource privacy.** Resource utilization telemetry sends only the
  documented process-level buckets above, plus the existing platform, version,
  provider, workload, and pressure dimensions. It never sends raw CPU, RSS,
  heap, physical-footprint values, host capacity, host inventory, usernames,
  paths, process lists, environment variables, or memory contents. It is
  emitted only with the existing five-minute heartbeat. Opt-out and the
  per-install identity path are unchanged.
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
| `telemetry.deploymentRole` | `unknown` | `personal` / `service` / `automation` / `development` / `ci` / `unknown` | Explicit deployment role; invalid or absent values are `unknown` |
| `telemetry.installChannel` | `unknown` | `desktop` / `package-manager` / `source` / `container` / `unknown` | Explicit installation provenance; invalid or absent values are `unknown` |
| `memorySearchQaEnabled` | `false` | boolean | Local-only recall QA ledger (never sent) |

Embedding billing rates are configured separately under the canonical
top-level `embedding` section. Rates are USD per million input tokens and are
not secrets:

```yaml
embedding:
  costRates:
    openai: 0.02
    openrouter: 0.004
```

`native`, `llama-cpp`, and `ollama` default to zero cost. An OpenAI-compatible
embedding request whose `base_url` contains `openrouter.ai` is billed using
the OpenRouter rate. Changing rates does not trigger an embedding-index
migration.

**Nesting pitfall (regression-pinned):** the daemon reads the flag via
`loadPipelineConfig` from `yaml.memory.pipelineV2`. A *top-level*
`pipelineV2.telemetryEnabled` key is invisible to the daemon — the original
setup disclosure wrote top-level and the opt-out silently did nothing until
fixed (1d014075). Setup/CLI writers must write into `memory.pipelineV2`.

**Runtime opt-out:** `SIGNET_TELEMETRY_OPTOUT=1` (or `true`) in the daemon or
CLI process environment disables telemetry for that process, including the
daemon collector, CLI command events, and install ping. CI runners,
containers, and scripted environments should set it in every process so
automated daemon boots and CLI invocations don't count as installs or usage.

**Development fleet marker:** `SIGNET_TELEMETRY_ENV=dev` adds
`deployment: dev` to daemon events sent to PostHog and the local audit log,
to CLI `command.invoked` events in that same log, and to native install pings
when the environment is present. Daemon and install-ping version fields report
the library version with a `-dev` suffix. The daemon and CLI `bun run dev`
scripts set this marker automatically; direct source launches can set it
explicitly. The marker is not an opt-out. `SIGNET_TELEMETRY_OPTOUT=1` or
`true` silences daemon, CLI, and install-ping telemetry.

For process-managed deployments, the equivalent explicit overrides are
`SIGNET_TELEMETRY_DEPLOYMENT_ROLE` and `SIGNET_TELEMETRY_INSTALL_CHANNEL`.
Accepted values are the config values above; invalid values are ignored and
resolve to the configured value or `unknown`. No paths, package URLs, process
names, repository names, IP addresses, or memory content are used to infer
either field.

**Disclosure:** `signet setup` tells users telemetry is on by default and
asks whether to disable it, including sharing top-level CLI command names with
PostHog. Declining writes `telemetryEnabled: false`; non-interactive/CI setups
keep the default (enabled).

## The open audit log

Every recorded event is appended as one JSON line to
`<agentsDir>/.daemon/telemetry/events.jsonl` — daemon events and CLI
`command.invoked` lines alike. It is the single inspectable surface for
exactly what was recorded: users can audit the file without trusting the
sink. The CLI always appends `command.invoked` (command name only) locally. When a
PostHog host and key are configured and the workspace has a telemetry SQLite
database with its tables, it also queues the event for best-effort PostHog
delivery, with no daemon round-trip or auth. Fresh workspaces without that
database remain local-only; the JSONL audit log is not replayed into SQLite.
Both local recording and remote delivery are gated on the same
`memory.pipelineV2.telemetryEnabled` flag and
`SIGNET_TELEMETRY_OPTOUT` runtime opt-out.

## Known semantics quirks

- `session.turn` counts turns persisted, while `session.end` is reserved for
  real session termination (#1212). Its collector-derived token and cost
  totals cover the matching usage events.
- `pipeline.embedding` includes a USD `cost`; local providers are free by
  default and remote rates come from `embedding.costRates` (#1201).
- `install.ping` and `install.activated` measure different populations —
  report them as complementary, never summed.
- CLI delivery is best-effort at-least-once within the ten-minute claim
  recovery window. A process crash after a successful PostHog response but
  before the SQLite sent marker is written can resend the batch; a crash
  before the request leaves the claim recoverable after the same window.
- A successful HTTP response marks the claimed batch sent. PostHog can still
  drop individual invalid events while returning `200 OK`, so the local sent
  marker means the batch was accepted by the endpoint, not that every event
  was ingested.
- CI and dev fleets can inflate "user" counts: every automated daemon boot
  with default config is a phantom install. Identify CI as
  `daemon.started` without a matching `install.ping`, set
  `SIGNET_TELEMETRY_OPTOUT=1` in workflows, and set
  `SIGNET_TELEMETRY_ENV=dev` for operator-owned development checkouts.
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

The local daemon also exposes `/api/telemetry/stats` (LLM, embedding, recall,
dreaming, and session aggregates from the local `telemetry_events` table) — see
[public telemetry API reference](https://docs.signetai.sh/api/telemetry-logs/). A local analytics
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
| Unreleased | `dreaming.pass` effect counters and bounded terminal outcomes (#1281) |
| 0.176.0 | Sanitized crash reports: full `error.occurred` payload (truncated, home-stripped message + top-8 stack frames) and rate-limited `EventLoopLag` wedge reports |
| next | `session.turn` + real `session.end` split (#1212): the per-turn event renamed from the old `session.end`; `session.end` now fires only at real terminations, deduped per lifetime; `sessionHash` added to all three session events |
| Unreleased | Previous daemon-exit reconciliation: `daemon.previous_exit` reports bounded `clean`, `error`, or `unrecorded` classification on the next boot (#1255) |
| Unreleased | `recall.performed` with anonymous recall type, result count, latency, and truncation metrics (#1203) |
| Unreleased | Bounded recall attempt and delivery outcomes by surface, without query or prompt content (#1277) |
| Unreleased | First-run activation funnel: `first.remember` / `first.recall`, exactly once per install (#1202) |
| Unreleased | `pipeline.embedding` cost rates and collector-derived session token/cost totals (#1201) |
| Unreleased | Bounded process CPU and memory utilization buckets on the existing daemon heartbeat, with local stats aggregation (#1424) |

Related: #1026 (original rollout), #1200 (IP capture, dev tagging),
#1201-#1207 (event-scoped follow-ups), #1212 (session.end rename — resolved).

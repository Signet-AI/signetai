---
title: "Model Provider Router"
id: model-provider-router
status: approved
informed_by:
  - docs/research/technical/RESEARCH-INFERENCE-CONTROL-PLANE.md
  - docs/research/technical/RESEARCH-COMPETITIVE-SYSTEMS.md
section: "Runtime"
depends_on:
  - signet-runtime
success_criteria:
  - "Signet exposes a shared inference layer that can select among session-backed, API-backed, and local model targets from agent.yaml policy"
  - "The daemon exposes both a Signet-native inference API and an OpenAI-compatible gateway surface backed by the same router"
  - "Daemon-managed workloads such as extraction and synthesis can route through the same policy engine instead of a separate provider selector"
  - "Operators can inspect routing decisions, health, and fallback state from the CLI and daemon status surfaces"
scope_boundary: "Defines Signet's inference control plane, routing schema, and daemon/CLI surfaces; does not require every harness to immediately drop its internal executor implementation"
---

# Model Provider Router

## Problem

Today inference is fragmented. Harnesses and daemon workloads each own
separate model/provider selection paths. That prevents Signet from enforcing a
single privacy policy, fallback strategy, or observability surface.

## Goals

1. Make Signet the inference control plane.
2. Support per-agent rosters of session-backed, API-backed, and local targets.
3. Route by policy and task class, not only by one static provider.
4. Expose both a compatibility gateway and a native RPC.
5. Bring extraction and synthesis under the same routing surface.

## Non-goals

- Replacing every harness runtime implementation in one PR.
- Defining cloud orchestration or distributed scheduling.
- Shipping a separate long-lived router sidecar in v1.

## Architecture

The daemon owns four responsibilities:

1. provider/account/session registry
2. policy evaluation and route explanation
3. execution and fallback orchestration where Signet owns the call
4. compatibility and native API surfaces

Harnesses integrate in one of two ways:

- OpenAI-compatible gateway for broad compatibility
- Signet-native inference RPC for richer routing hints and subtask metadata

## Config contract

`agent.yaml` gains a top-level `inference:` block with:

- `accounts`
- `targets`
- `policies`
- `taskClasses`
- `agents`
- `workloads`

Legacy extraction/synthesis config remains valid and is compiled into an
implicit routing profile so existing installs keep working.

## Required behavior

### Routing modes

- `strict`: explicit ordered chain
- `automatic`: score eligible candidates
- `hybrid`: automatic within a constrained allowlist

### Hard gates

The router must block a target when:

- privacy tier is insufficient
- required capability is missing
- context window is too small
- account/session state is missing or expired
- the route is administratively unavailable

### Execution and fallback

The selected target executes first. If it fails, the router may try later
allowed targets from the resolved fallback chain and must record the attempt
sequence in the route trace.

### Workloads

Daemon-managed workloads use the same router:

- `memory_extraction`
- `session_synthesis`
- `interactive`

When a workload call site does not provide an `agent_id`, the router uses the
workspace default agent context.

## API surface

### Native inference API

The daemon exposes endpoints for:

- listing inference config and runtime state
- explaining a route decision without execution
- executing a routed prompt
- inspecting route health and recent fallback state

### Compatibility gateway

The daemon exposes an OpenAI-compatible gateway for:

- `GET /v1/models`
- `POST /v1/chat/completions`

The gateway may accept Signet-specific metadata headers so compatible harnesses
can pass agent, task-class, privacy-tier, and policy hints.

## CLI surface

The CLI exposes:

- `signet route list`
- `signet route status`
- `signet route explain`
- `signet route test`
- `signet route pin`
- `signet route unpin`

## Integration contracts

### Signet Runtime

This spec extends `signet-runtime`: harnesses remain thin adapters over daemon
contracts, but inference becomes a first-class daemon-exposed contract.

### OpenClaw and Hermes

OpenClaw and Hermes should prefer Signet-owned routing where they can point at
Signet as a provider or call the native inference API. This spec does not block
incremental harness adoption.

## Validation

- Routing decisions are reproducible from config + runtime snapshot.
- CLI explain matches daemon explain.
- Privacy-denied tasks never route to remote targets.
- Gateway and native RPC are backed by the same decision engine.
- Legacy extraction/synthesis behavior remains available through implicit
  routing when explicit routing is absent.

## Implementation progress

This section is an implementation ledger for the approved contract above.
It is intentionally operational, not normative. Update it as work lands so
the spec stays useful as both contract and progress tracker.

### Done

- Shared router core exists in `@signet/core` with:
  - `inference:` config parsing
  - legacy extraction/synthesis -> implicit inference compilation
  - strict / automatic / hybrid policy resolution
  - privacy, capability, context, and basic runtime-availability gates
  - route traces and fallback target ordering
- The daemon owns a new inference router service with:
  - config loading from `agent.yaml`
  - runtime snapshot generation
  - routed execution with ordered fallback attempts
  - workload-provider shims for extraction and session synthesis
- Native inference API exists:
  - `GET /api/inference/status`
  - `GET /api/inference/history`
  - `POST /api/inference/explain`
  - `POST /api/inference/execute`
  - `POST /api/inference/stream`
  - `DELETE /api/inference/requests/:id`
- OpenAI-compatible gateway exists:
  - `GET /v1/models`
  - `POST /v1/chat/completions`
  - streaming chat completions for stream-capable targets
- Daemon-managed workloads can route through the shared router:
  - `interactive`
  - `memory_extraction`
  - `session_synthesis`
- Signet-owned OS surfaces now try the router first and fall back cleanly:
  - `os-chat`
  - `os-agent`
- CLI route tooling exists:
  - `signet route list`
  - `signet route status`
  - `signet route doctor`
  - `signet route explain`
  - `signet route test`
  - `signet route pin`
  - `signet route unpin`
- Docs and tests landed for the initial control-plane wave.

### Partially done

- Config model is present, but simplified:
  - `accounts`, `targets`, `policies`, `taskClasses`, `agents`, and
    `workloads` exist
  - a separate canonical top-level `models:` map does not yet exist
- Provider abstraction is richer at the router layer, but execution still
  largely relies on the existing `LlmProvider` plumbing underneath
- Subscription/session-backed accounts are modeled in schema, but not yet
  implemented as first-class persisted session/quota entities with refresh
  lifecycle
- Runtime state now observes and remembers recent account-scoped auth and
  quota failures in memory:
  - 401/403-style auth failures degrade matching account routes as `expired`
  - 429/quota-style failures degrade matching account routes as
    `rate_limited`
  - subsequent route explanations and executions respect that observed state
    until it expires or a later success clears it
  - this state is not yet persisted across daemon restarts
- Routing decisions use task class, policy, privacy, capability, and basic
  heuristics, but the request contract is not yet as rich as the target
  end state for harness/runtime metadata and subtask semantics
- Local inference telemetry now persists safe routing history through the
  existing opt-in telemetry collector:
  - `inference.route`
  - `inference.execute`
  - `inference.stream`
  - `inference.fallback`
  - prompt bodies, responses, secrets, and session refs are excluded
- `/api/inference/history` exposes recent redacted inference route/fallback
  history for diagnostics users when telemetry is enabled
- CLI support is functional, but still lacks the full override surface
  described in the original plan, especially richer request-shaping flags
- Security hardening is implemented for the current daemon-owned surfaces:
  - explicit target overrides can no longer escape agent rosters
  - inference routes now validate and clamp body/header inputs
  - dedicated inference rate-limit buckets exist for explain, execute, and
    gateway chat completion routes
  - inference execution errors now redact secret-bearing upstream details
    before they reach logs, status snapshots, route traces, or API responses
  - bounded in-flight caps now protect native execute, native stream, gateway
    stream, and total inference concurrency
- Streaming and cancellation are implemented for the current daemon-owned surfaces:
  - OpenAI-compatible gateway streaming is live for stream-capable targets
  - native Signet SSE streaming exists at `/api/inference/stream`
  - active streams can be cancelled via `/api/inference/requests/:id`
  - mid-stream upstream failure now returns partial output plus degraded
    metadata instead of silently truncating

### Deferred / phase 3

These items remain intentionally deferred because the phase 2 hardening wave
focused on making the daemon-owned router safe enough for broader harness
adoption. They should become follow-up specs or sprint briefs rather than
blocking the current router foundation.

- First-class persisted session/account registry behavior:
  - persisted account health records
  - persisted quota/cost ledgers
  - durable expiry / invalidation state transitions
  - refresh or revalidation flows where supported
- Schema and provider-abstraction parity with the full target design:
  - canonical top-level `models:` map with reusable capability metadata
  - richer `RouteRequest` metadata for harness, subtask, tool, and runtime
    context
  - router-native executor contracts beyond the current compatibility shim over
    existing `LlmProvider` plumbing
- Policy-engine hardening beyond observed in-memory state:
  - retry classification taxonomy
  - circuit breaking
  - cooldown / recovery logic
  - durable degraded-state tracking across daemon restarts
- CLI UX parity with the full original plan:
  - richer request-shaping flags for expected tokens, latency budget,
    reasoning depth, and tool requirements
  - decision-trace output that can be shared directly in bug reports without
    additional manual redaction
- Richer cost telemetry:
  - cost estimates and actuals where providers expose them
  - quota ledger reconciliation for subscription/session-backed targets
- Harness adoption outside Signet-owned daemon routes:
  - OpenClaw
  - Hermes
  - OpenCode
  - Pi
- Broader chaos/integration coverage beyond current fixture tests:
  - real subscription session expiry
  - real provider 429 / quota exhaustion
  - local backend loss
  - strict fallback chains under real provider failure

## Phase 2 hardening checklist

This checklist tracks the hardening wave that made the daemon-owned router
safe enough for broad harness adoption work like OpenClaw takeover. Items that
require real harness takeover, persisted session ledgers, or subscription
refresh lifecycles are tracked as phase 3 above rather than blocking this gate.

### 1. Permissions and scope hardening

- [x] Verify `/api/inference/status` remains diagnostics-only in authenticated
  modes.
- [x] Verify `/api/inference/explain`, `/api/inference/execute`, and `/v1/*`
  require explicit admin permission in authenticated modes.
- [x] Enforce agent scope on route requests so scoped tokens cannot route work
  for another agent via body fields or gateway headers.
- [x] Reject policy or explicit target overrides that fall outside the scoped
  agent roster.
- [x] Clamp request fields at the boundary:
  - `maxTokens`
  - latency hints
  - expected token hints
  - explicit target counts
  - prompt preview length
- [x] Add regression tests for:
  - admin-required route execution
  - diagnostics-only status access
  - scoped-agent denial on mismatched `agentId`
  - explicit target override denial when out of policy/scope

### 2. Rate limiting and abuse control

- [x] Add dedicated inference route limiters, separate from existing memory and
  auth mutation limiters.
- [x] Rate-limit these surfaces independently:
  - `/api/inference/explain`
  - `/api/inference/execute`
  - `/v1/chat/completions`
  - `GET /v1/models` remains unthrottled for now, pending evidence of abuse
- [x] Limit by authenticated principal when auth is enabled. In local mode,
  requests intentionally follow Signet's trusted-local policy instead of
  deriving limits from spoofable headers.
- [x] Add bounded concurrency or in-flight request caps for expensive routed
  execution.
- [x] Return explicit `429` responses with stable error shape.
- [x] Add tests proving repeated gateway and execute abuse requests are
  throttled while local diagnostics still work.

### 3. Streaming and cancellation

- [x] Add streaming support to `POST /v1/chat/completions` when the selected
  executor supports streaming.
- [x] Add native streaming support on the Signet RPC side for first-party
  consumers.
- [x] Add a cancellation surface so long-running routed requests can be
  stopped.
- [x] Define restartability rules for streamed requests in v1: once bytes have
  been emitted, Signet does not live-failover to another backend; it returns
  partial output plus degraded metadata. Pre-stream startup failures may still
  fall back to another target.
- [x] Preserve privacy and policy gates for streamed execution exactly as for
  non-streamed execution.
- [x] Add tests for:
  - successful streamed response
  - cancellation during stream
  - provider death mid-stream
  - degraded partial response behavior

### 4. Security hardening

- [x] Enforce request size ceilings for routed prompt bodies and message lists.
- [x] Enforce header size and value normalization for Signet-specific gateway
  headers.
- [x] Reject malformed or unsupported gateway routing hints cleanly.
- [x] Ensure `local_only` privacy requests cannot be widened or bypassed by
  gateway model aliases, explicit targets, or malformed headers.
- [x] Redact secrets, session references, and raw sensitive prompt bodies from
  logs, traces, and error payloads.
- [x] Ensure route traces exposed to users/operators contain decision context
  without leaking secret-bearing configuration.
- [x] Add tests for:
  - oversized prompt rejection
  - malformed header rejection
  - local-only privacy enforcement under hostile override attempts
  - trace redaction

### 5. Session and quota state

- [x] Promote account/session state from schema-only metadata into in-memory
  runtime state with explicit health transitions.
- [x] Track and surface current runtime/account states for configured targets:
  - `ready`
  - `missing`
  - `expired`
  - `rate_limited`
  - degraded but recoverable
- [x] Add structured handling for missing API keys and observed provider
  401/403/429/quota failures.
- [ ] Add first-class refresh/revalidation handling for disconnected CLI auth
  and real subscription session expiry. This is phase 3 because it requires
  real session-backed provider integration, not only fixture/provider
  observation.
- [x] Feed observed auth/rate-limit state back into routing penalties and
  hard blocks for later requests in the same daemon lifetime.
- [x] Add tests for auth-failure and quota-exhaustion fallback behavior.

### 6. Observability and auditability

- [x] Persist routed attempt telemetry locally, at minimum:
  - agent id
  - operation
  - task class
  - effective policy
  - selected target
  - fallback hops
  - failure classification
  - latency
  - token usage
  - privacy gate result
- [x] Expose recent routing failures and fallback history in daemon status or
  diagnostics surfaces.
- [x] Keep external telemetry opt-in only and redact prompt contents by
  default.
- [x] Add tests proving trace and telemetry redaction rules hold.

### Phase 2 exit criteria

Phase 2 is complete for the current daemon-owned surfaces. The router now has:

- scope-safe and rate-limited native/gateway endpoints
- bounded in-flight concurrency for expensive inference work
- streamed and non-streamed execution behind the same routing/privacy gates
- cancellation plus degraded partial-output behavior for mid-stream failures
- observed auth/quota state that can block or degrade routing during the
  current daemon lifetime
- local, redacted telemetry plus `/api/inference/history` for recent failures
  and fallback behavior

The remaining work belongs to phase 3 / harness adoption: durable session
registries, persistent circuit breakers, richer quota ledgers, and runtime
integration for OpenClaw, Hermes, OpenCode, and Pi.

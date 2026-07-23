---
title: "Pipeline Pause Control"
informed_by:
  - docs/research/technical/RESEARCH-PIPELINE-PAUSE-CONTROL.md
success_criteria:
  - "Operators can pause extraction work from the CLI or dashboard without losing later backlog processing"
  - "While paused, new memories still persist and queue for later extraction instead of being dropped"
  - "A successful pause closes background inference admission and aborts or drains every active background provider call"
  - "Resuming restores normal worker startup and backlog draining with no schema migration"
scope_boundary: "Temporary operator control for background pipeline activity only; does not add schedules, per-stage pausing, or new memory semantics"
---

# Pipeline Pause Control

Status: Complete (v2)

Spec metadata:
- ID: `pipeline-pause-control`
- Status: `complete`
- Hard depends on: `memory-pipeline-v2`
- Registry: `docs/specs/INDEX.md`

Related docs:
- `docs/research/technical/RESEARCH-PIPELINE-PAUSE-CONTROL.md`
- `surfaces/cli/src/commands/daemon.ts`
- `surfaces/cli/src/features/daemon.ts`
- `platform/daemon/src/daemon.ts`
- `platform/daemon/src/pipeline/index.ts`
- `platform/daemon/src/memory-config.ts`
- `surfaces/cli/src/features/pipeline-pause.ts`
- `surfaces/cli/src/features/pipeline-pause.test.ts`
- `surfaces/dashboard/src/lib/api.ts`
- `surfaces/dashboard/src/lib/api.pipeline.test.js`
- `surfaces/dashboard/src/lib/components/tabs/PipelineTab.svelte`

## 1) Problem

Users sometimes need Signet to get out of the way for a while. Today the
available switches are too blunt:

- `enabled = false` stops future enqueueing
- `shadowMode = true` still burns extraction resources
- `mutationsFrozen = true` still runs extraction

There is no operator control for "stop the workers now, keep the daemon
alive, and let queued extraction catch up later."

## 2) Goals

1. Add a first-class paused state for the extraction pipeline.
2. Expose it as an obvious CLI and dashboard operator control.
3. Preserve queued work while paused.
4. Surface paused status in daemon observability.

## 3) Delivered capability set

### A) Persisted config flag

Signet now persists `memory.pipelineV2.paused: boolean`, default `false`.

### B) Startup behavior

When `enabled = true` and `paused = true`:

- do not start extraction workers
- do not start synthesis, predictor, embedding-tracker, structural backfill,
  or procedural reconciler background work
- do keep retention-only startup behavior
- do report pipeline mode as `paused`

The live pause transition first closes router admission for extraction,
summary/synthesis, repair, and dreaming inference. Active calls receive an
abort signal (including ACPX subprocess trees), and the endpoint does not
report success until they settle or the bounded quiescence wait expires. The
response reports the active, aborted, remaining, and timeout counts.

### C) CLI control

Add:

- `signet daemon pause`
- `signet daemon resume`
- root aliases `signet pause` and `signet resume`

The shipped implementation now prefers live daemon pause/resume endpoints so
runtime state flips in-place without a daemon restart when the API is
available. The CLI still falls back to the original config-write + restart path
for older daemons or auth-protected setups it cannot control directly, and on
pause still attempts to unload local Ollama models so VRAM is released
promptly.

### D) Dashboard control

The pipeline tab now exposes a pause/resume control that calls the live daemon
API directly, disables itself while a transition is in flight, and refreshes
status after each successful mutation.

### E) Backlog contract

Pause is not disable. New memories still enqueue extraction work while the
pipeline is paused, then drain after resume.

## 4) Non-goals

- no cron-based pause windows
- no per-agent partial pause
- no predictor-specific tuning work beyond what naturally follows from
  extraction workers being offline
- no remote-provider lifecycle control beyond local loopback Ollama unload

## 5) Integration contracts

**Pause <-> Memory Pipeline v2**
- `paused` is orthogonal to `enabled`
- `enabled=false` still wins and means fully disabled

**Pause <-> CLI**
- CLI prefers live daemon pause/resume when available
- CLI falls back to persisted flag write + daemon restart when live control is
  unavailable
- CLI reports whether local Ollama model unload succeeded

**Pause <-> Dashboard**
- the pipeline tab uses the live daemon pause/resume endpoints directly
- the control must guard against duplicate clicks while a transition is active
- successful mutations trigger a fresh status poll so the badge reflects the
  new mode immediately

**Pause <-> Observability**
- `/api/pipeline/status` reports `mode = "paused"` when applicable
- `/api/pipeline/pause` and `/api/pipeline/resume` expose live operator control
  with structured mutation responses
- successful pause responses include a `quiescence` result; `remaining = 0`
  is the observable completion contract

## 6) Validation and tests

- Config parsing preserves explicit `paused: true`
- CLI toggle writes `memory.pipelineV2.paused`
- Pause unloads local loopback Ollama models through the generate API with
  `keep_alive: 0`
- Paused mode reports correctly in status/observability
- Resume clears the flag and restores normal startup path
- Dashboard pause/resume helpers surface structured success and error results
- Router quiescence aborts active background inference, blocks new admission,
  and prevents an aborted target from spawning a fallback provider

---
title: "Daemon Startup Responsiveness"
id: daemon-startup-responsiveness
status: planning
informed_by:
  - docs/research/technical/RESEARCH-DAEMON-STARTUP-RESPONSIVENESS.md
section: "Daemon"
depends_on:
  - "memory-pipeline-v2"
success_criteria:
  - "Daemon startup keeps /health responsive while recovery work runs on large databases"
  - "Watcher-triggered harness sync keeps /health responsive on large multi-agent workspaces"
  - "Startup recovery and embedding coverage queries avoid unbounded synchronous scans on the main thread"
  - "Regression tests cover batched summary-job recovery and duplicate-hash embedding coverage"
  - "CLI start/restart can recover from a stale managed daemon process that still owns the port after health probes fail"
scope_boundary: "Boot-path responsiveness and watcher-triggered harness sync hardening only; does not redesign the full daemon startup pipeline"
draft_quality: "incident-driven planning stub"
---

# Daemon Startup Responsiveness

Spec metadata:
- ID: `daemon-startup-responsiveness`
- Status: `planning`
- Hard depends on: `memory-pipeline-v2`
- Registry: `docs/specs/INDEX.md`

## Problem

Large workspaces can make startup-adjacent recovery and embedding checks heavy
enough to starve the daemon's main thread. When that happens the process may
bind its port yet still fail health probes and control requests.

## Goals

1. Preserve HTTP responsiveness during startup and early background recovery.
2. Batch recovery work that can grow with table size.
3. Batch watcher-triggered harness sync work that scales with agent count.
4. Keep duplicate-hash embedding coverage correct without pathological query
   plans.
5. Recover cleanly when a managed daemon process is still alive but no longer
   answers health checks.
6. Add durable regression guards for this incident class.

## Proposed guardrails

### 1) Batched startup recovery

Recovery of stuck `summary_jobs` should run in bounded batches with event-loop
yields between batches rather than one synchronous startup sweep.

### 2) Shared embedding coverage logic

Queries that answer "does this memory already have an embedding or hash-covered
vector?" should be centralized in one helper module and use index-friendly
`EXISTS` probes.

### 3) Startup responsiveness contract

`/health` responsiveness is treated as a boot contract, not a best-effort
metric. Background recovery may continue after startup, but it must not make
operators blind.

### 4) Watcher sync responsiveness contract

Watcher-triggered identity sync (`syncHarnessConfigs`, per-agent workspace
materialization, generated architecture docs) must avoid long synchronous file
loops on the main thread. Large agent rosters should process in bounded batches
with event-loop yields between batches.

### 5) Managed stale-process cleanup

CLI start/stop/restart flows should not rely solely on successful health
probes to decide whether a daemon exists. If the managed daemon PID is still
alive, the CLI should attempt cleanup before declaring the daemon stopped or
before spawning a replacement.

## Validation

- Recovery helper proves bounded batch behavior.
- Identity sync helper proves batched yields between watcher sync batches.
- Summary worker startup test proves crash recovery is deferred off the
  synchronous start path.
- Duplicate-hash coverage tests prove covered memories are not treated as
  missing and stale source-linked rows are still refreshable.
- CLI regression tests prove restart/stop still clean up a stale managed daemon
  when the health endpoint is wedged.

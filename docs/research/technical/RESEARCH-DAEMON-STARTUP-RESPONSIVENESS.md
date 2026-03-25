---
title: "Daemon Startup Responsiveness Research"
question: "How should Signet keep HTTP health and control routes responsive during daemon startup and large-database recovery work?"
---

# Daemon Startup Responsiveness Research

## Question

How should Signet keep HTTP health and control routes responsive during daemon startup and large-database recovery work?

## Trigger

Issue #331 reported that upgrading from `v0.76.3` to `v0.76.6` on a large
workspace database caused the daemon to bind port `3850` but remain
functionally unresponsive. `/health` timed out and `signet status` hung.

## Current startup shape

`packages/daemon/src/daemon.ts` performs database initialization,
configuration loading, worker startup, and other background boot work before
and around HTTP server readiness.

The failure mode is not necessarily a crash. A synchronous SQLite scan or
recovery loop running on the main thread can monopolize the event loop long
enough that health probes appear dead even though the process is alive.

## High-risk patterns

1. Synchronous startup recovery over large tables.
2. Background loops whose first pass runs immediately after startup and uses
   query shapes that defeat indexes.
3. Duplicate implementations of "is this memory already covered by an
   embedding?" logic drifting into expensive or inconsistent SQL.

## Recommended guardrails

1. Recovery passes that touch large queues must be batched and yield between
   batches.
2. Health responsiveness is a contract: heavy recovery must not monopolize the
   event loop before operators can reach `/health` and repair routes.
3. Duplicate-hash embedding coverage logic should live in one shared helper and
   use index-friendly `EXISTS` checks instead of broad `LEFT JOIN ... OR ...`
   scans.
4. Add regression tests that prove startup recovery is deferred off the
   synchronous constructor path and that duplicate-hash coverage does not
   reintroduce pathological scans or infinite re-embed loops.

## Practical implication

This is not only a performance issue. Startup responsiveness is an
operational reliability requirement because every higher-level control surface
depends on a healthy daemon answering requests promptly.

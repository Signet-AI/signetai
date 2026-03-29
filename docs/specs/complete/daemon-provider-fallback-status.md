---
title: "Daemon Extraction Provider Fallback Visibility"
description: "Persist extraction provider degradation in runtime status and allow hard-failure over silent fallback."
status: "complete"
informed_by: []
success_criteria:
  - "Startup provider fallback or hard-failure is persisted in /api/status and surfaced by signet status"
  - "Operators can set extraction fallbackProvider to none to block rerouting when the configured provider is unavailable"
  - "Unavailable extraction startup state dead-letters queued extraction jobs instead of silently leaving them pending"
scope_boundary: "Covers extraction provider startup resolution and operator visibility only; does not redesign synthesis provider policy"
---

# Daemon Extraction Provider Fallback Visibility

## Context

Issue #320 highlighted that extraction provider fallback warnings only exist
in startup logs. Once the daemon is running, `/api/status` and `signet status`
do not distinguish between the configured provider and a fallback provider.

## Delivered Contract

- Persist extraction runtime resolution with status metadata:
  - `active`
  - `degraded`
  - `blocked`
  - `disabled`
  - `paused`
- Expose the persisted state via `/api/status`.
- Surface degraded/blocked extraction in `signet status`.
- Add `memory.pipelineV2.extraction.fallbackProvider` with `ollama | none`.
- When startup preflight blocks extraction and fallback is disabled or
  unavailable, dead-letter queued extraction jobs with a structured reason.

## Notes

- This is an ops-hardening stub tied to issue #320.
- The feature is additive and backward compatible because the default
  `fallbackProvider` remains `ollama`.

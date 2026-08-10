---
title: "OpenClaw Connector Hardening"
informed_by:
  - docs/research/technical/notebook-dump-2026-02-25.md
success_criteria:
  - "Temporal index entries in MEMORY.md synthesis include a content preview line"
  - "OpenClaw plugin compiles and passes tests against the typed hook interfaces"
  - "Mid-session checkpoint extraction fires after N turns for long-lived sessions"
  - "Rust daemon implements cursor-tracking and summary job parity for session-checkpoint-extract"
scope_boundary: "OpenClaw adapter, TS/Rust daemon hooks, temporal synthesis — no OpenClaw core changes"
---

> **Deprecated context:** The daemon-rs Rust daemon rewrite has been removed. References below to daemon-rs parity or mirroring are historical.


# OpenClaw Connector Hardening

Three targeted improvements to the OpenClaw runtime plugin identified
by Ant (Discord agent) from production use patterns.

## Problem 1 — Temporal Index Content Previews

**Change:** `buildSynthesisIndexBlock` (hooks.ts) now appends a
`summary: <preview>` line under each temporal index entry, using the
existing `trimContent(node.content, 120)` helper.

The synthesis prompt's "do not rewrite" instruction was updated to
cover the two-line format.

## Problem 2 — Type Safety and Backwards Compatibility

**Change:** `openclaw-types.ts` now mirrors the upstream typed hook
interfaces (`PluginHookAgentContext`, `PluginHookBeforePromptBuildEvent`,
etc.) with `& Record<string, unknown>` intersections that preserve access
to undocumented extra fields from older OpenClaw builds.

`resolveCtx()` replaces six ad-hoc field resolution functions with a
single dual-source resolver: typed ctx fields preferred, legacy event
extras as fallback.

Legacy dedup: when both `before_prompt_build` and `before_agent_start`
fire on the same turn without the `messages` field (older OpenClaw),
generation counters (`bpbGen`/`basGen` Maps) ensure only one of the pair
increments the turn counter. Generation-based tracking avoids the
stale-flag problem a `Set` approach has when `before_agent_start` misses
a turn.

## Problem 3 — Mid-Session Extraction for Long-Lived Sessions

**Change:** New `POST /api/hooks/session-checkpoint-extract` endpoint.
The OpenClaw adapter tracks turns per session; after 20 turns it
fire-and-forgets a checkpoint extract without releasing the session claim.

The endpoint remains as a continuity bookkeeping surface, but the retired
summary-worker delivery boundary is no longer used. The daemon retains a full
checkpoint transcript snapshot when it is not shorter than the canonical row,
writes the continuity checkpoint, and resets the live continuity window. It
returns `{ "skipped": true }` and creates no summary job; the transcript is
sent to Dreaming only after a session-end, recovery, or TTL completion marker.
The historical `session_extract_cursors` table remains readable for migration
compatibility but is not advanced by this retired path.

## Delivered

PR #369 (`ant/openclaw-hardening`).

---
title: "OpenClaw Connector Hardening"
informed_by:
  - docs/research/technical/notebook-dump-2026-02-25.md
success_criteria:
  - "Temporal index entries in MEMORY.md synthesis include a content preview line"
  - "OpenClaw plugin compiles and passes tests against the typed hook interfaces"
  - "Mid-session checkpoint extraction fires after N turns for long-lived sessions"
  - "Rust daemon implements cursor-tracking parity for session-checkpoint-extract"
scope_boundary: "OpenClaw adapter, TS/Rust daemon hooks, temporal synthesis — no OpenClaw core changes"
---

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
fire on the same turn without the `messages` field (older OpenClaw), a
`bpbFired: Set<string>` flag ensures only one of the pair increments the
turn counter.

## Problem 3 — Mid-Session Extraction for Long-Lived Sessions

**Change:** New `POST /api/hooks/session-checkpoint-extract` endpoint.
The OpenClaw adapter tracks turns per session; after 20 turns it
fire-and-forgets a checkpoint extract without releasing the session claim.

Delta tracking via `session_extract_cursors` table (migration 049 in TS
daemon, 033 in Rust daemon). The cursor is advanced AFTER
`enqueueSummaryJob` succeeds so a crash causes redundant re-extraction
rather than a silent data-loss window.

Rust daemon implements cursor read/advance parity; summary job queueing
is Phase 5 (same TODO already present in Rust `session_end`).

## Delivered

PR #369 (`ant/openclaw-hardening`).

---
title: "Explicit Recall Surface Alignment"
id: explicit-recall-surface-alignment
status: approved
informed_by:
  - "docs/research/technical/RESEARCH-OBSIDIAN-VAULT-RECALL-EVAL.md"
  - "docs/research/market/memory-benchmark-comparison.md"
section: "Runtime"
depends_on:
  - "memory-pipeline-v2"
  - "signet-runtime"
success_criteria:
  - "TypeScript explicit recall uses one canonical retrieval engine and one canonical response contract across API, CLI, MCP, and harness consumers"
  - "Prompt-submit recall remains a lightweight injection path and does not absorb explicit recall product concerns"
  - "Legacy or duplicate TypeScript recall helpers are either removed or reduced to thin wrappers around the canonical recall path"
  - "Consumer renderers preserve useful recall metadata instead of flattening results into source-less snippet lists"
scope_boundary: "TypeScript recall surfaces only: explicit recall APIs, CLI, MCP, and harness consumers. Excludes Rust parity work and excludes changes to the underlying retrieval model beyond wrapper consolidation and response shaping."
draft_quality: "repo-audit planning draft"
---

# Explicit Recall Surface Alignment

## Problem

Signet's TypeScript recall behavior is split across too many surfaces that
share some plumbing but diverge in orchestration and presentation:

1. `/api/memory/recall` exposes the richest retrieval path through
   `hybridRecall()`.
2. `handleUserPromptSubmit()` uses recall differently because prompt-submit
   is a hot-path injection surface with confidence gates, dedup, and
   fallback channels.
3. `/api/hooks/recall` is a harness-oriented recall surface that currently
   wraps the same engine but still acts like a separate product boundary.
4. CLI, MCP, and connector consumers flatten results differently and often
   throw away metadata such as source labels, scores, type, and provenance.
5. `packages/daemon/src/hooks.ts` still contains an older `handleRecall()`
   helper that appears to be legacy logic instead of a live source of truth.

The result is not six different retrieval engines, but it is still a
fragmented recall product:

- one strong engine,
- one prompt-submit orchestration path,
- several renderers and wrappers,
- at least one likely-dead helper,
- too many places where useful metadata gets discarded.

This makes recall harder to evolve because every improvement risks landing in
the wrong layer.

## Goals

1. Establish one canonical TypeScript explicit recall engine.
2. Establish one canonical explicit recall response contract.
3. Keep prompt-submit recall intentionally small, fast, and distinct from
   explicit recall.
4. Reduce or remove duplicate helper logic that does not own real product
   behavior.
5. Make explicit recall consumers preserve useful metadata instead of turning
   rich results into anonymous bullet lists.

## Non-goals

- No Rust parity work in this spec.
- No retrieval-model redesign, re-ranking redesign, or graph search redesign.
- No attempt to make prompt-submit into a rich query product.
- No new memory types, schema changes, or pipeline extraction changes.
- No deep-memory-search or LLM-escalation work.

## Current surface inventory

### Keep as primary building blocks

| Surface | File | Role |
|---|---|---|
| `hybridRecall()` | `packages/daemon/src/memory-search.ts` | Canonical explicit recall engine |
| prompt-submit orchestration | `packages/daemon/src/hooks.ts` | Hot-path injection control flow, not a rich query surface |
| temporal fallback helpers | `packages/daemon/src/temporal-fallback.ts` | Supporting continuity fallback |
| transcript fallback helpers | `packages/daemon/src/session-transcripts.ts` | Supporting continuity fallback |
| `/api/memory/recall` | `packages/daemon/src/daemon.ts` | Canonical explicit recall API |

### Keep, but thin down

| Surface | File | Current issue |
|---|---|---|
| `/api/hooks/recall` | `packages/daemon/src/daemon.ts` | Useful harness entry point, but should remain a thin wrapper |
| CLI `signet recall` | `packages/cli/src/commands/memory.ts` | Loses too much structure in display |
| MCP `memory_search` | `packages/daemon/src/mcp/tools.ts` | Returns raw text payload without a stronger recall contract |
| OpenClaw `/recall` rendering | `packages/connector-openclaw/src/index.ts` | Flattens results into plain content bullets |

### Likely remove or collapse

| Surface | File | Current issue |
|---|---|---|
| `handleRecall()` | `packages/daemon/src/hooks.ts` | Looks like legacy standalone recall logic rather than a live source of truth |
| ad hoc formatter duplication | multiple consumers | Rich metadata is repeatedly discarded in slightly different ways |

## Proposed architecture

### 1) Canonical explicit recall engine

`packages/daemon/src/memory-search.ts` remains the only retrieval engine for
explicit TypeScript recall.

`hybridRecall()` already owns:

- keyword + vector merge,
- filtering,
- scoping,
- reranking hooks,
- graph/traversal support,
- supplementary context,
- expansion behavior.

This spec does not replace that engine. It treats it as the source of truth.

### 2) Canonical explicit recall API

`/api/memory/recall` becomes the canonical API surface for explicit recall.

Other explicit recall surfaces should:

- wrap it,
- render it,
- or constrain it for a specific caller,

but should not grow separate retrieval behavior unless that difference is
required by an explicit contract.

### 3) Prompt-submit remains separate

Prompt-submit recall stays in `handleUserPromptSubmit()` and remains a
distinct product boundary:

- lightweight injection only,
- confidence-gated,
- fallback-friendly,
- deduplicated,
- budget-limited.

Prompt-submit is not the place for the richer "query product" behavior. It
is allowed to use recall, but it should not become recall's main
presentation layer.

### 4) Fallbacks remain supporting channels

Temporal and transcript fallbacks remain valuable, but only as fallback
channels when structured memory is weak or missing. They should not grow
into peer retrieval engines that compete with `hybridRecall()`.

## Contract decisions

### A) Retrieval source of truth

- **Source of truth:** `hybridRecall()`
- **Not a source of truth:** CLI formatting, MCP formatting, connector
  formatting, prompt-submit injection formatting

### B) Explicit recall source of truth

- **Source of truth:** `/api/memory/recall`
- **Thin wrapper candidate:** `/api/hooks/recall`
- **Alias only:** `/api/memory/search`

### C) Prompt-submit source of truth

- **Source of truth:** `handleUserPromptSubmit()`
- It may call `hybridRecall()`, but it is not responsible for becoming the
  canonical explicit recall experience.

## Consolidation plan

### Phase 1, dead-weight audit

1. Confirm whether `handleRecall()` in `packages/daemon/src/hooks.ts` is
   actually used anywhere meaningful.
2. Remove it if dead, or demote it to a thin wrapper if it still serves a
   compatibility role.
3. Document any remaining call sites that still bypass the canonical recall
   path.

### Phase 2, explicit recall response contract

Define a canonical response contract for explicit recall that all TypeScript
consumers can rely on. This does not require changing the retrieval engine,
only tightening the product contract around it.

The contract should preserve at least:

- result ordering,
- score,
- source,
- type,
- date/provenance,
- supplementary-result distinction,
- no-hit behavior.

The contract may later grow richer shaped sections for explicit recall, but
that presentation belongs outside prompt-submit.

### Phase 3, consumer alignment

Refit the following consumers to preserve useful metadata and stop flattening
everything into anonymous snippets:

1. CLI `signet recall`
2. MCP `memory_search`
3. OpenClaw `/recall`
4. any harness-oriented recall formatting that currently strips source and
   provenance

### Phase 4, wrapper discipline

Keep `/api/hooks/recall` only if it has a real harness-oriented purpose:

- different auth/session behavior,
- stricter wrapper semantics,
- harness compatibility surface.

If it does not need its own contract, it should stay visibly thin.

## Validation

- `handleRecall()` is either removed or proven necessary with documented
  call sites.
- `/api/memory/recall` remains the authoritative explicit recall endpoint.
- `/api/hooks/recall` does not diverge into its own retrieval engine.
- CLI, MCP, and connector recall displays expose source labels and preserve
  useful metadata from the canonical response.
- Prompt-submit injection remains lightweight and separate from explicit
  recall shaping.

## Success metrics

1. One obvious TypeScript engine owns explicit recall behavior.
2. One obvious TypeScript API owns explicit recall response semantics.
3. Prompt-submit stays fast and small.
4. Consumer surfaces stop collapsing recall into metadata-free bullets.
5. Future recall changes can be made in one place and seen predictably
   across wrappers.

## Open decisions

1. Whether `/api/hooks/recall` should remain a public compatibility surface
   long-term or collapse entirely into `/api/memory/recall`.
2. Whether the canonical explicit recall response contract should stay raw
   JSON-first or also define a higher-level shaped presentation contract for
   CLI/MCP consumers.
3. Whether explicit recall should expose a first-class "summary / sources /
   gaps / no-hit" product contract at the API layer or only in selected
   renderers.

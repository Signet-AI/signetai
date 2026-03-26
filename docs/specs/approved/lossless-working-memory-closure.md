---
title: "Lossless Working Memory Closure"
status: approved
informed_by:
  - "docs/research/technical/RESEARCH-LCM-ACP.md"
  - "docs/specs/planning/LCM-PATTERNS.md"
  - "docs/specs/approved/memory-md-temporal-head.md"
  - "docs/specs/approved/lossless-working-memory-runtime.md"
success_criteria:
  - "Temporal node drill-down is available by id and returns parent/child lineage, linked memories, and transcript context without flooding the main MEMORY.md body"
  - "Concurrent same-agent MEMORY.md writes are lease-safe and retry-safe, and busy head writes do not suppress future regeneration"
  - "Compaction artifacts participate in the same temporal DAG and condensation path as session summaries, with harness fidelity and degraded modes explicitly documented"
  - "Prompt-time retrieval keeps structured distillation primary while transcript retrieval stays a searchable, embeddable fallback and deep-history substrate"
scope_boundary: "Closes the runtime and documentation gaps around lossless working memory, and mirrors touched daemon hook contracts into daemon-rs in the same work wave. Full daemon-rs cutover remains a separate program."
---

# Lossless Working Memory Closure

## Why this exists

The base temporal-head and working-memory runtime specs establish the
architecture, but they still leave room for partial implementations that
technically point in the right direction while missing critical operator
surfaces.

This closure spec makes the missing pieces mandatory. The intended user
experience is not "roughly LCM-shaped." It is a complete working system.

## Hard Requirements

### 1. Temporal drill-down is mandatory

`MEMORY.md` may stay concise, but it must not strand the agent at the
surface layer.

The runtime must expose a temporal expansion path that accepts a temporal
node id and returns:

- the selected node
- parent lineage
- child lineage
- linked memory rows when they exist
- transcript context when it exists for that lineage

This surface may be exposed through API, MCP, or both, but the contract
must exist and the returned shape must preserve `agent_id` scoping.

### 2. Merge-safe head writes are mandatory

Same-agent concurrent writers must not silently clobber `MEMORY.md`.

The runtime must provide:

- a shared head record or equivalent lock target
- active lease / ownership metadata
- refusal on active conflicts rather than blind overwrite
- retry-safe behavior so a temporary busy head does not suppress the
  next valid synthesis attempt

A busy write is not a terminal failure. It is a deferred write.

Temporal scoping must be just as strict for storage keys:

- transcript persistence must be unique by `agent_id + session_key`
- summary retry uniqueness must be unique by `agent_id + session_key`
- no temporal write path may assume `session_key` is globally unique

### 3. Compaction is part of the same memory system

Compaction artifacts are not auxiliary notes and are not allowed to fork
into a separate continuity path.

Hard requirements:

- compaction output is stored as a first-class temporal node
- compaction nodes can coexist beside session summary nodes for the same
  session lineage
- temporal condensation may consume summary and compaction roots alike
- prompt dedup / continuity bookkeeping resets correctly after
  compaction so stale injected context can be reconsidered

### 4. Transcript fallback stays secondary

Structured distillation remains the primary retrieval surface.

Transcript retrieval is required, but only as:

- a fallback when structured traversal has not caught up yet
- a deep-history substrate when transcript-specific lookup is needed
- an expansion substrate when drilling through temporal lineage

Transcript searchability and embeddability are required capabilities,
not justification for promoting transcripts to the default prompt-time
source of truth.

### 5. Harness fidelity must be explicit

Every harness must map to the same ideal runtime model, and the docs must
say exactly where fidelity is full versus degraded.

The compatibility contract must explicitly state:

- which lifecycle hooks each harness supports
- whether live prompt-submit transcript capture exists
- whether pre-compaction exists
- whether post-compaction exists
- what degraded behavior applies when a hook surface is unavailable

No docs may overclaim full lifecycle parity when the runtime does not yet
wire the required hook events.

## Required Harness Outcomes

### OpenCode

Reference full-fidelity path:

- session-start
- user-prompt-submit
- pre-compaction
- compaction-complete
- session-end

### OpenClaw plugin path

Must support the full temporal model as the flagship harness:

- prompt-time continuity
- pre-compaction capture
- post-compaction artifact persistence
- session-end continuity
- compatibility with the same shared `MEMORY.md` head as other harnesses

### Claude Code

Allowed degraded mode:

- session-start
- user-prompt-submit
- pre-compaction
- session-end

If no post-compaction event exists, docs must say so explicitly.

### Codex

Allowed degraded mode:

- session-start
- user-prompt-submit
- session-end

If no compaction lifecycle hooks exist, docs must say so explicitly.

### OpenClaw legacy path

Compatibility-only mode:

- manual context/remember/recall may remain available
- it is not considered full lossless-working-memory parity

## Documentation Requirements

The following documents must stay aligned with the shipped runtime:

- `docs/API.md`
- `docs/HOOKS.md`
- `docs/HARNESSES.md`
- `docs/specs/INDEX.md`
- `docs/specs/dependencies.yaml`

Required documentation coverage:

- transcript fallback is secondary, not primary
- `MEMORY.md` is the merge-safe temporal head
- temporal drill-down surfaces are documented
- harness fidelity matrix is documented
- compaction parity and degraded modes are documented

## Rust Parity Requirement

This closure spec does not require full daemon-rs cutover, but it does
require parity for every daemon hook contract touched by the work.

That means:

- request/response shape changes must be mirrored into `packages/daemon-rs/`
- fallback and scoping semantics must be mirrored for the touched paths
- parity tests or route-local regressions must land in the same PR when
  practical

Broader Rust daemon completion remains tracked by the separate parity and
cutover specs, but hook-surface drift is not allowed here.

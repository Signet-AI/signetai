---
title: "Memory content safety"
status: approved
---

# Memory Content Safety

## Problem

Memories, native harness artifacts, transcripts, and summaries are retained as
source-backed evidence but are later projected into recall, reranking,
Dreaming, `MEMORY.md`, and aggregate prompts. Stored content is untrusted
input at every one of those boundaries. A malicious instruction must not become
trusted context merely because it was saved successfully.

## Contract

1. A deterministic, versioned policy scans content for high-confidence prompt
   injection, exfiltration, credential-harvesting, malicious-shell, tool
   directive, and invisible-Unicode patterns.
2. The policy returns `clean`, `tainted`, or `blocked`. Only `clean` content is
   context eligible. Invisible Unicode is retained as evidence but is
   ineligible until the source is replaced by a clean capture.
3. The original content, source path, timestamps, ownership, and provenance are
   never rewritten or deleted by the scan. A separate agent-scoped safety ledger
   records the policy version, reasons, status, and context eligibility.
4. Remember writes, native-artifact indexing, transcript/summary writes, and
   source-chunk embedding writes register an assessment. Migration backfill
   assesses existing rows without changing their content.
5. Recall authorizes memory IDs before reranking, dampening, summaries,
   hydration, or access tracking. The authorization gate and every native
   artifact/source-chunk fallback reject non-eligible content; legacy rows are
   scanned on read when no ledger row exists.
   Other derived LLM stages, including prospective hints, daily reflections,
   and artifact sentence generation, must also reject non-eligible source
   content before constructing a provider prompt.
6. Dreaming, `MEMORY.md`, harness identity synchronization, and temporal
   expansion use the same eligibility decision. Blocked source records remain
   auditable through source/memory inspection and diagnostics, but are omitted
   from ordinary prompt projections.
7. Prompt-facing MCP memory and knowledge projections replace non-eligible
   `content` fields with an explicit withheld notice while retaining the
   assessment metadata. User-facing HTTP inspection exposes the assessment
   without treating a
   blocked row as deleted. Diagnostics expose bounded, agent-scoped status and
   reason counts without returning raw content.

## False-positive boundary

The policy is intentionally high-confidence. Ordinary technical prose, quoted
shell examples, security guidance, non-English text, and emoji remain clean
when they are descriptive or defensive. A direct imperative payload remains
ineligible even if it is embedded in a larger technical record.

## Non-goals

- silently deleting, redacting, or rewriting immutable evidence;
- treating query metadata as a substitute for scanning stored content;
- claiming that a clean scan proves content is factual or safe for every
  downstream use;
- replacing provenance, agent scoping, or permission checks.

## Verification

- Core policy tests cover every threat family plus technical, shell-example,
  security-discussion, Unicode, and emoji false positives.
- Migration tests cover fresh databases, idempotent reruns, and backfill.
- Daemon tests prove blocked remembered content remains inspectable but is
  absent from recall, native fallback, source chunks, and Dreaming evidence.
- Recall tests cover authorization before reranking and summary stages, while
  derived LLM-stage tests prove blocked content is not sent to prospective
  hints, daily reflections, or artifact-sentence providers.
- Route tests cover the memory inspection and diagnostics response shapes.

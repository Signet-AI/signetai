---
title: "MEMORY.md Rolling Window Lineage Research"
question: "How should Signet keep a one-month rolling MEMORY.md with one sentence per session while treating markdown summary/transcript/compaction artifacts as canonical historical content?"
---

# MEMORY.md Rolling Window Lineage Research

## Question

How should Signet keep a one-month rolling `MEMORY.md` with one sentence per
session while treating markdown summary/transcript/compaction artifacts as
canonical historical content?

## Trigger

High-frequency usage can exceed 50 sessions/day. Current synthesis can omit or
truncate in-window visibility and over-rely on tool expansion surfaces.

## Findings

1. Top-N sampling and preview truncation can hide in-window sessions.
2. Source-of-truth ambiguity appears when markdown and DB both claim historical
   content ownership.
3. Runtime telemetry (timing/ranking/access counters) is DB-native and should
   not be forced into markdown round-trips.
4. Compaction timing creates late-link metadata that clashes with immutable
   content artifacts unless mutability boundaries are explicit.
5. Plain file drill-down should remain viable without temporal expand tooling.

## Direction

1. Treat markdown summary/transcript/compaction artifacts as canonical history.
2. Treat `MEMORY.md` as a rebuildable projection, not canonical history.
3. Keep DB authoritative for runtime telemetry and graph state.
4. Require workspace-root-relative Obsidian wikilinks for lineage.
5. Use immutable content artifacts plus a mutable session manifest for
   late-arriving linkage (for example compaction paths).
6. Define deterministic hash scope, sanitization versioning, UTC window
   semantics, and re-index/tombstone behavior.

## Planning scope implied

A planning spec should lock:

- authority split (markdown history vs DB telemetry/graph)
- artifact immutability and manifest mutability boundaries
- exact rolling-window inclusion semantics in UTC
- machine-checkable sentence quality floor
- checksum and sanitizer determinism contracts
- crash recovery state model for partial writes
- re-index and privacy-removal/tombstone handling

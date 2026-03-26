---
title: "macOS SQLite Runtime Discovery Research"
question: "How should Signet select a SQLite runtime on macOS so Bun can load sqlite-vec without requiring a daemon runtime switch?"
---

# macOS SQLite Runtime Discovery Research

## Question

How should Signet select a SQLite runtime on macOS so Bun can load
`sqlite-vec` without requiring a daemon runtime switch?

## Trigger

Issue #336 reported a macOS install where the daemon ran under Bun,
`sqlite-vec` failed to load, `vec_embeddings` was never created, and
hybrid recall silently degraded to keyword-only.

## Findings

1. The core failure is not "Bun can never use sqlite-vec". Bun exposes
   `Database.setCustomSQLite()`, which allows swapping out Apple's
   system SQLite before the first connection opens.
2. The current daemon already attempts a macOS fix by checking
   Homebrew SQLite dylib paths, but that is too narrow. Users without
   Homebrew SQLite in the expected location still fall back to Apple's
   system SQLite.
3. A user-provided dylib inside `$SIGNET_PATH` or an explicit
   environment override is a viable recovery path and works with Bun's
   current API surface.
4. Switching the daemon to Node would be a much larger architecture
   change than the bug requires. The daemon is still Bun-shaped and
   directly imports `bun:sqlite`.

## Decision

Treat this as a macOS runtime discovery problem, not a daemon-runtime
replacement problem.

Preferred resolution order on macOS:

1. `SIGNET_SQLITE_PATH` explicit override, authoritative when set
2. `$SIGNET_WORKSPACE/libsqlite3.dylib` workspace-local fallback using
   the active workspace resolution chain
3. Homebrew SQLite dylib paths

If none are present, the daemon should emit an explicit warning that
vector search may degrade to keyword-only and point users to the
supported fixes.

## Implications

- Keep Bun as the daemon runtime.
- Add a regression test around path resolution order.
- Improve degraded-mode reporting so missing vector support is not
  effectively silent.

---
title: "macOS SQLite Runtime Discovery"
id: macos-sqlite-runtime-discovery
status: planning
informed_by:
  - docs/research/technical/RESEARCH-MACOS-SQLITE-RUNTIME-DISCOVERY.md
section: "CLI/Daemon"
depends_on:
  - "signet-runtime"
success_criteria:
  - "On macOS, the daemon can discover a custom SQLite dylib via explicit override, workspace-local fallback, or Homebrew path before opening the first Bun connection"
  - "When no compatible dylib is available, Signet surfaces an explicit warning and embedding health guidance instead of silently degrading"
  - "Regression tests lock the macOS SQLite discovery order and degraded-mode messaging"
scope_boundary: "Daemon-side SQLite runtime selection and observability only. Does not switch the daemon from Bun to Node and does not replace sqlite-vec."
draft_quality: "incident-driven stub for issue #336"
---

# macOS SQLite Runtime Discovery

## Problem

On macOS, Bun may use Apple's system SQLite, which can disable dynamic
extension loading. When that happens, `sqlite-vec` never loads and
hybrid search falls back to keyword-only. The daemon already checks
Homebrew SQLite paths, but users without that exact layout still fail.

## Goals

1. Keep Bun as the daemon runtime.
2. Broaden macOS SQLite runtime discovery beyond hardcoded Homebrew
   paths.
3. Surface explicit operator guidance when vector search cannot load.
4. Add regression tests so future refactors do not silently remove the
   fallback chain.

## Non-goals

- Rewriting the daemon to Node.
- Replacing `sqlite-vec`.
- Bundling a first-party SQLite dylib in this change.

## Proposed approach

Resolve a custom SQLite dylib on macOS in this order:

1. `SIGNET_SQLITE_PATH` as an authoritative explicit override, fail
   closed if it is set but missing
2. `$SIGNET_WORKSPACE/libsqlite3.dylib` using the active workspace
   resolution chain (`SIGNET_PATH` → stored workspace config →
   default `~/.agents`)
3. `/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib`
4. `/usr/local/opt/sqlite/lib/libsqlite3.dylib`

If a candidate exists, call `Database.setCustomSQLite()` before the
first `Database` instance is created. If no candidate exists, emit a
warning that clearly explains why vector search may degrade and how to
fix it.

## Guardrails

- Unit test the discovery order and non-darwin no-op behavior.
- Add embedding-health messaging that points macOS users to the
  supported fixes when `vec_embeddings` is unavailable.

## Open decisions

1. Whether Signet should eventually bundle a known-good SQLite dylib
   for macOS installs.
2. Whether the future doctor command should check for this condition
   proactively.

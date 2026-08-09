---
title: "Packages and data flow"
description: "Repository package boundaries and Signet end-to-end data flow."
---

## Package Overview

Signet is organized as a bun workspace monorepo under `signetai/`.
The repository is grouped by developer intent:

- `platform/` contains the core runtime substrate.
- `surfaces/` contains human-facing applications.
- `integrations/` contains external harness integrations, grouped by tool.
- `libs/` contains reusable developer libraries.
- `plugins/` contains Signet-native plugins.
- `dist/` contains assembled shipping artifacts.
- `runtimes/` contains separate runtime ecosystems.
- `web/` contains the marketing site and Cloudflare workers.
- `memorybench/` contains the benchmark harness, providers, reports, and UI.

See [Repository Map](https://github.com/Signet-AI/signetai/blob/main/docs/REPO_MAP.md) for the full path map. The important
ownership boundary is unchanged: `@signet/core` owns types and data; the
daemon owns runtime behavior; connectors own install-time harness integration;
runtime plugins and adapters live beside the tool they extend.

`@signet/core` lives in `platform/core/`. It is the shared foundation and
defines TypeScript
interfaces, the SQLite wrapper, hybrid search, manifest parsing, and
constants. Every other package imports from core; core imports from
nothing internal.

`@signet/daemon` lives in `platform/daemon/`. It is the background service
and runs the Hono HTTP
server on port 3850, the pipeline workers, the file watcher, and the
retention and maintenance workers. It targets bun directly, which
gives it access to `bun:sqlite` and JSX for the dashboard.

`@signet/cli` lives in `surfaces/cli/`. It is the user-facing tool and
handles setup, config
editing, daemon lifecycle, secrets, and skills. It targets Node for
broad compatibility, but runs fine under bun.

`signet-dashboard` lives in `surfaces/dashboard/`. It is built to static
assets and served by the daemon.

`@signet/connector-base` lives in `libs/connector-base/` and provides the abstract `BaseConnector` class
that all platform connectors extend. It re-exports shared utilities
(block injection, skill symlinking) so connector implementations stay
thin.

`@signet/connector-claude-code`, `@signet/connector-opencode`,
`@signet/connector-openclaw`, and the other `@signet/connector-*`
packages live under `integrations/<tool>/connector/`. They are concrete
install-time platform adapters. Each implements `install`, `uninstall`,
`isInstalled`, and `getConfigPath`.

`@signet/sdk` lives in `libs/sdk/`. It is the embedding library for third-party apps that want
to call the daemon [HTTP API](/api/) without shelling out to the [CLI](/cli/).

`@signet/opencode-plugin` lives in `integrations/opencode/plugin/`. It
is the runtime plugin for OpenCode and
provides memory tools and session lifecycle hooks that call the daemon
API during OpenCode sessions.

`@signetai/signet-memory-openclaw` lives in
`integrations/openclaw/memory-adapter/`. It is the runtime adapter for OpenClaw.
It bridges OpenClaw's plugin interface to the daemon API for memory
operations during conversations.

`@signet/desktop` lives in `surfaces/desktop/`. It is the Electron desktop
application and provides the native desktop UI, menu bar tray, bundled daemon
runtime, quick actions, and notifications. `@signet/tray` lives in
`surfaces/tray/` and is a shared tray/menu state utility package only.

Predictor-related tables and diagnostics remain in the schema for future
scoring work, but there is no shipped `platform/predictor/` sidecar package in
the current tree.

`@signet/native` lives in `platform/native/` and provides Rust/NAPI bindings for SIMD vector operations
(cosine similarity, normalization) used by the daemon for fast
embedding math. Targets bun/node.

`signetai` lives in `dist/signetai/`. It is the npm/Bun wrapper that downloads,
verifies, and exposes the same compiled Signet binary used by the curl
installer.

`@signet/web` lives in `web/marketing/`. It is the Astro marketing site
deployed to Cloudflare Pages. Web workers live under `web/workers/<worker>/`.

---

## End-to-End Data Flow

The path from a conversation event to a searchable memory is:

```
Harness hook fires (session-start / user-prompt / session-end)
    → connector calls daemon HTTP API
    → /api/hooks/remember enqueues memory_jobs row (type: extract)
    → inline entity linker runs synchronously at write time
      (no LLM — links candidate proper nouns to existing same-agent entities)
    → extraction worker leases job, calls LLM for facts + entities
    → decision worker evaluates each fact against existing memories
    → controlled writes: new memories inserted via txIngestEnvelope
    → hints worker generates hypothetical future queries per memory,
      indexes them in FTS5 for prospective matching
    → graph persistence: entities and relations written in a
      separate transaction
    → embeddings prefetched outside write lock, stored atomically
    → memory_history records every proposal (shadow or applied)
    → /api/memory/recall runs traversal-primary search:
      graph traversal produces the base candidate pool,
      flat FTS5/vector search fills remaining slots,
      structured evidence shaping balances lexical, semantic,
      prospective hint, and traversal evidence,
      currentness shaping dampens grouped claim-key superseded structured facts,
      predictor score slots remain nullable until a scorer is wired in
```

The database is the source of truth. The daemon's file watcher is
responsible for syncing agent config changes to harness-specific
files (CLAUDE.md, AGENTS.md). That flow is independent from the
memory pipeline:

```
User edits $SIGNET_WORKSPACE/AGENTS.md
    → chokidar detects change
    → 2s debounced sync: regenerate ~/.claude/CLAUDE.md etc.
    → 5s debounced git commit: auto-commit with timestamp
```

---

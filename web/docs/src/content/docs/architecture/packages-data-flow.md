---
title: "Packages and data flow"
description: "Repository ownership and the current evidence-to-retrieval path."
---

Use this page to locate the owner of a runtime concern. The repository map is the source for the package inventory; this page records the boundaries that matter to architecture work.

## Ownership

- `platform/core` (`@signet/core`) owns shared types, migrations, SQLite access, search, and identity primitives.
- `platform/daemon` (`@signet/daemon`) owns the HTTP API, authorization, orchestration, background lifecycle, and durable transitions.
- `surfaces/cli` (`@signet/cli`), `surfaces/dashboard` (`signet-dashboard`), desktop, and tray packages are clients or operator surfaces.
- `integrations/<tool>` owns harness connectors, plugins, and adapters for external tools.
- `libs` owns reusable developer libraries such as `@signet/sdk`; it is not a second daemon or database owner.
- `dist` assembles shipping artifacts. `web` owns public web packages. `memorybench` owns benchmark code.

The daemon and core are the runtime owners. Clients and integrations authenticate, validate at their boundary, transport requests, and render results; they do not implement independent memory, authorization, or database transitions.

## Current data flow

```text
harness, CLI, dashboard, or connector
  -> daemon boundary
  -> agent-scoped evidence and durable state
  -> derived FTS, vector, document, and optional hint indexes
  -> bounded, authorized recall
  -> evidence-backed context

completed episodic evidence
  -> Dreaming selection
  -> audited ontology operations
  -> scoped semantic state and retrieval augmentation
```

Evidence capture and semantic maintenance are separate. Dreaming is the sole automatic writer of semantic truth. Indexes, embeddings, caches, and projections remain derived and rebuildable.

See [Pipeline and storage](/architecture/pipeline-storage/) for persistence and lifecycle boundaries.

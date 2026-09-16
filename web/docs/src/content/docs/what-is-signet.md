---
title: "What Is Signet"
description: "A local-first memory and context layer for AI agents."
---

Signet is a local-first memory and context layer for AI agents. A daemon owns the workspace and exposes the same memory to the CLI, dashboard, and connected agent harnesses.

## The mental model

```text
agent or user → Signet daemon → workspace
                              ├─ evidence and memories
                              ├─ search indexes
                              └─ scoped structured knowledge
```

- **Workspace:** Local configuration, evidence, memories, and database.
- **Daemon:** The service that owns durable state and serves requests.
- **Interfaces:** The `signet` CLI, dashboard, and harness connectors use the same workspace.
- **Recall:** Hybrid keyword and vector search returns context within the caller's agent and visibility scope.
- **Sources:** Connected or imported material is retained with provenance and indexed for retrieval.

Signet records explicit memories and source evidence first. Indexes, embeddings, and structured knowledge make that evidence easier to retrieve and remain linked to the evidence they derive from.

## Start here

- [Quickstart](/quickstart/) for the install-to-recall path.
- [Memory and search](/memory/) for persistence and retrieval.
- [Sources](/sources/) for connected and imported knowledge.
- [Knowledge architecture](/knowledge-architecture/) for evidence and structured knowledge.
- [Architecture](/architecture/) for implementation details.

---
title: "What Is Signet"
description: "A plain-language explanation of what Signet does, where it runs, and why you might use it."
---

Signet is a local-first daemon and workspace that gives AI agents persistent memory, source-aware context, and controlled access to tools and secrets.

It sits between an AI harness and the data an agent needs over time. The harness provides the interaction surface. A model provides reasoning. Signet keeps the workspace, serves memory and source recall, connects lifecycle hooks, and runs the background services that make the state usable across sessions.

## What Signet provides today

### A daemon and workspace

The Signet daemon is a background service. It provides the HTTP API, MCP server, dashboard, file watchers, harness synchronization, and memory and source workers. It runs locally by default at `http://localhost:3850` and can also run on a trusted server for remote harness connectors.

The workspace is the directory Signet operates on. It contains configuration and identity files, the SQLite memory database, daemon logs, skills, and other runtime data. Signet resolves it in this order:

1. `SIGNET_PATH`
2. `SIGNET_WORKSPACE`
3. the saved workspace selection in `$XDG_CONFIG_HOME/signet/workspace.json`
4. `~/.agents`

Read [Set up Signet](/getting-started/setup/) for the workspace created by the setup wizard.

### Persistent memory and recall

Signet can save memories through the CLI, a connected harness, or the daemon API. A saved memory is immediately written as episodic evidence. Keyword search is available from the synchronous full-text index; semantic search uses embeddings when an embedding provider is configured and available.

Recall combines keyword, vector, structured, and optional knowledge-graph search, then applies the caller's agent and project scope before returning content. The result is a bounded set of context for the current task, not an unfiltered dump of the workspace.

Signet keeps the exact saved record separate from derived search and knowledge state:

- Episodic evidence includes saved memories, transcripts, summaries, notes, imported documents, and source artifacts.
- Derived state includes embeddings, full-text indexes, entities, aspects, claims, and relationships used to search and organize that evidence.
- Dreaming can read the evidence and apply audited semantic changes. It does not rewrite the original evidence.

Read [Memory System](/memory/) for the write, recall, and lifecycle details.

### Read-only sources and document indexing

Sources let Signet recall from knowledge that already has a canonical home. Current source paths include Obsidian vaults, Discord, GitHub repositories, and durable file imports.

Signet stores source-owned artifacts and retrieval chunks, but does not write back to an Obsidian vault, Discord, or GitHub source. Source results remain marked as source-backed, retain provenance, and can be removed by source without deleting the original files or remote records.

This distinction matters: connecting a source does not turn the source into an ordinary Signet memory, and a recall snippet is not a replacement for inspecting the canonical source.

Read [Sources](/sources/) for supported connectors, imports, provenance, and removal behavior.

### Harness integrations

Signet connects to AI harnesses through plugins, hooks, MCP tools, and connector packages. Current public integrations include Claude Code, Codex, OpenCode, OpenClaw, Hermes Agent, Pi, and Oh My Pi.

A harness can use Signet for session lifecycle events, prompt-time context, memory tools, source recall, and synchronization of managed identity files. A remote connector can run on another machine and send authenticated requests to the daemon that owns the workspace.

Read [Harnesses](/harnesses/) for the integration list and [Remote Harness Connectors](/remote-connectors/) for cross-machine setup.

### Secrets and policy boundaries

The bundled `signet.secrets` plugin stores secret values in an encrypted local store. Signet exposes names and references rather than raw values. When a command needs a secret, the daemon can resolve the reference, inject the value into the subprocess environment, and redact it from returned output.

Authentication and agent scope are separate controls. Local mode is convenient for a single user. Team and hybrid modes require bearer authentication for shared or remote access, and API keys can be scoped to an agent or connector.

Read [Secrets](/secrets/) and [Authentication](/auth/) before exposing a daemon beyond localhost.

### CLI, dashboard, and operations

The `signet` CLI covers setup, daemon lifecycle, memory, sources, secrets, connectors, status, logs, and synchronization. The dashboard is a supplementary visual interface for browsing memory and ontology state, managing sources and secrets, editing configuration, and inspecting daemon activity.

The daemon also runs optional background work, including source indexing, retention, maintenance, and Dreaming. These workers use the same workspace and obey the configured scope, provider, and mutation controls.

Read [Install](/getting-started/install/), [Dashboard](/dashboard/), and [Operate your installation](/getting-started/operate/) for the practical paths.

## How the pieces relate

An ordinary session looks like this:

```text
AI harness or CLI
        │  hooks, recall, memory writes, source requests
        ▼
Signet daemon
        │  scope checks, API/MCP, workers, provider calls
        ▼
Signet workspace
        ├─ configuration and identity files
        ├─ SQLite evidence and audit history
        ├─ source-owned artifacts and retrieval indexes
        └─ derived search and knowledge state
```

The daemon is the boundary between a harness and the workspace. It accepts a memory write, source request, or recall query; checks the applicable agent and permission boundary; reads or writes the relevant state; and returns the result to the caller.

During background processing, Signet can use a configured inference provider to turn selected evidence into derived semantic state. That processing is optional and configurable. The evidence remains available so derived state can be inspected, rebuilt, or corrected.

## What Signet is not

- Signet is not an LLM. It does not replace the model that reasons or writes responses. It coordinates memory, context, sources, tools, and configured provider calls around that model.
- Signet is not an AI harness. Claude Code, Codex, OpenCode, OpenClaw, Hermes Agent, Pi, and Oh My Pi remain the interaction surfaces. Signet integrates with them.
- Signet is not a hosted chat product. Its primary deployment is a daemon and workspace you run and operate. A daemon may be placed on another machine for trusted remote connectors, but that is still your deployment.
- Signet is not the canonical home of every document it can recall. Connected sources remain authoritative in their own systems. Signet stores an indexed, provenance-preserving view for recall.
- Signet is not a guarantee that derived memory is always correct. Its value is that the evidence, provenance, scope, and audit paths remain available when the derived view needs review.

## Ownership and deployment

A default installation is local-first:

- the daemon binds to localhost and does not require authentication in `local` mode;
- the workspace and its SQLite state are on the machine running Signet;
- the workspace can be inspected and backed up, and `signet git` can synchronize the workspace with a remote repository;
- `$SIGNET_WORKSPACE/.secrets/` contains encrypted secrets and should not be committed or shared casually.

For a remote or shared deployment, bind the daemon deliberately and use `hybrid` or `team` authentication with scoped API keys. Remote harness connectors send requests to the daemon over the configured network path. The daemon may also send selected content to remote inference or embedding providers when those providers are configured. Use local or built-in providers when that data should stay on the daemon machine, and review provider configuration before enabling background processing.

Signet does not make a canonical source file portable by copying ownership of it into the database. Back up both the workspace state and the source systems you depend on. Treat the database, indexes, and ontology as Signet-managed state that can be rebuilt or repaired from retained evidence where the relevant source is still available.

Read [Self-hosting](/self-hosting/) for service and network deployment details.

## Start here

- [Quickstart](/quickstart/): understand the main memory, source, and recall concepts.
- [Install](/getting-started/install/): install the CLI and native daemon.
- [Set up Signet](/getting-started/setup/): create a workspace and connect a harness.
- [Your first session](/getting-started/first-session/): save, recall, and inspect memory.
- [Sources](/sources/): connect Obsidian, Discord, GitHub, or imported files.
- [Dashboard](/dashboard/): browse and operate a running daemon visually.
- [Operate your installation](/getting-started/operate/): manage services, auth, backups, and troubleshooting.

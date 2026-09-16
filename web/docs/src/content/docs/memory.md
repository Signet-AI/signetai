---
title: "Memory System"
description: "Save, find, change, and remove native memory in Signet."
---

Signet is a local-first memory and context layer for AI agents.

## Choose the right kind of context

- **Native memory** — save a durable fact, preference, decision, rule, or other small piece of agent-scoped evidence. Start with [`signet memory remember`](/cli/).
- **Documents** — ingest a text, URL, or file into linked searchable chunks. See [Documents](/documents/).
- **Connected sources** — recall from an Obsidian vault, Web page, Discord guild, or GitHub repository without copying the source into native memory. See [Sources](/sources/).
- **Durable transcript imports** — preserve exported agent sessions as source-backed evidence with resumable import jobs. See [Sources: agent transcript imports](/sources/#agent-transcript-imports).

## Save and recall native memory

Native memory is owned by Signet and written by the daemon. Save a memory through the Dashboard or your client integration. A successful save is immediately available as episodic evidence. Embedding is best effort, so keyword recall still works when an embedding provider is unavailable.

Recall returns a bounded, permission-checked result set. It can combine keyword, vector, structured, and graph evidence.

Native memory content and type are immutable once written as episodic evidence. Metadata can be curated through the mutation flow. Dreaming may later derive audited semantic claims and links; it does not replace the original evidence.

## Change or forget memory

Use the Dashboard or client integration to:

- modify content, type, importance, tags, pinned state, or owner metadata;
- preview a forget operation before executing a batch;
- provide a reason for every mutation;
- use a version check when concurrent edits matter.

Forget is a soft delete. Deleted memories disappear from recall and list results but remain as tombstones for the default **30 days**. During that window, recover them with a reason. After the window, retention archives the memory to cold storage, removes its graph links and embeddings, and hard-deletes the tombstone; recovery is no longer possible.

Pinned memories require `force: true` for batch forget. A batch forget does not support `if_version`; use the version-guarded single-memory delete when needed.

## Retention defaults

The retention worker runs every **6 hours**. Each sweep is capped at **500 rows per step** (`batchLimit`) to bound write latency.

| Data | Default retention |
|---|---:|
| Soft-deleted memory tombstones | 30 days |
| Memory history events | 180 days |
| Completed pipeline jobs | 14 days |
| Dead-letter pipeline jobs | 30 days |

These are built-in worker defaults, not `agent.yaml` settings.

## Scope and lifecycle

Native memory records agent-scoped evidence that Signet owns. Source files and service data remain canonical in their connected source, while source-backed results retain their provenance in recall. Session transcripts use the dedicated session-search path; exported transcripts use the durable import workflow on [Sources](/sources/).

All durable memory changes pass through the daemon and its database-owner process.

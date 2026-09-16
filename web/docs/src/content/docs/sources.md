---
title: "Sources"
description: "Connect read-only knowledge bases and import durable evidence into Signet."
---

Signet is a local-first memory and context layer for AI agents.

## Choose the right kind of context

- **Native memory** — save a small durable fact or decision that Signet owns. See [Memory](/memory/).
- **Documents** — ingest text, URLs, or files into linked searchable chunks. See [Documents](/documents/).
- **Connected sources** — read from an Obsidian vault, Web page, Discord guild, or GitHub repository while the original remains canonical.
- **Durable transcript imports** — import Signet-exported session JSONL as resumable, provenance-bearing evidence.

## Connect a source

Open the [Dashboard](/dashboard/) and choose **Sources**. Select **Connect** for Obsidian, GitHub, or Discord, or **Import** for files or a public Web page.

| Source | Required input |
|---|---|
| Obsidian | Absolute vault path |
| GitHub | `owner/repo` or `owner/*` |
| Discord | Guild ID and bot-token secret reference |
| Web page | Public `http(s)` URL |

Signet reads connected sources and does not edit them. Obsidian files, Discord data, GitHub resources, and Web content remain source-backed recall rather than native memories. Store service tokens as Signet secret references, never as raw source configuration.

Connected sources refresh in place. Unchanged content is skipped, overlapping scans are coalesced, and removed files are soft-deleted from source artifacts while their source-owned chunks are purged. Renames are treated as delete plus add.

## Import files

Use **Import → Files**, select files, choose duplicate handling, and select **Import & index**. Supported inputs include text, Markdown, JSON, HTML, CSV, and AnyDoc formats: `doc`, `docx`, `docm`, `odt`, `rtf`, `pdf`, `ppt`, `pptx`, `ppsx`, `odp`, `epub`, `xls`, `xlsx`, `xlsm`, and `ods`.

The limits are **25 files per batch**, **25 MiB per file**, and **100 MiB per batch**. Results are reported per file. Choose one duplicate action:

- **Skip duplicate** keeps the existing import.
- **Replace and re-index** replaces it and queues indexing again.
- **Import as a new source** retains a second source for the same content.

File imports create one read-only `import` source per file. Signet stores normalized content and provenance for indexing, but does not write to the original file or retain raw upload bytes.

## Import durable agent transcripts

Use the durable Sources job for transcript JSONL, not the synchronous document importer. The supported format is Signet export schema `signet-export`, version `1`: one object per line with `source`, `id`, `harness`, `agent_id`, `session_key`, `project`, `timestamp`, exact `message_count`, and typed `messages`. Message roles are `user`, `assistant`, `system`, `tool`, and `unknown`.

The selected `--agent` owns the import; an embedded `agent_id` does not change scope. Whitespace, multiline content, roles, projects, timestamps, and provenance are retained exactly. The daemon retains raw bytes and resumes checksummed uploads.

```bash
signet sources import ./sessions.jsonl --kind transcripts --schema signet --agent my-agent --json
signet sources imports status <job-id> --agent my-agent --watch --json
```

Limits are **one active job/file**, **25 records per database batch**, **8 MiB per canonical batch**, **16 MiB per record**, **4 MiB per message**, and **50,000 messages**. Each nonblank line becomes exactly one of `imported`, `duplicate`, or `rejected`; blank lines are counted separately. Replaying the same identity and content is a duplicate; changing content for the same identity is rejected as a conflict.

Jobs move through `staging → inventorying → queued → running`, may be `paused`, and finish as `completed`, `completed_with_rejections`, or `cancelled`. Restarts recover leases and byte checkpoints. Import completion nudges Dreaming, but Dreaming consumption remains a separate delivery and review path.

This workflow is different from live hook transcripts. Hooks capture live session activity for session continuity and dedicated transcript search; they do not turn the session into a durable imported source. Use durable imports when an exported transcript must remain attributable, resumable, and purgeable as source evidence.

## Remove a source safely

Ordinary source removal through the Dashboard or daemon removes the source configuration and purges Signet-owned artifacts, graph rows, chunks, and embeddings. Source files and external services are untouched.

`signet sources remove <sourceId>` tries the daemon first. If the daemon is unavailable, it falls back to **config-only removal** and prints a warning: already-indexed database rows were not purged. Reconnect to the daemon and remove the source again to complete the purge.

Imported transcript sources have an additional archival/provenance rule. Removing one purges imported evidence, indexes, and consumption rows, while bounded audit tombstones and routing derived knowledge through unsupported/stale review preserve the import's provenance. Do not treat imported-source removal as ordinary connector cleanup.

For transcript upload details and migration notes, see the [durable transcript import reference](/api/documents-sources/#durable-transcript-imports). For provider-specific options, use the [Sources API reference](/api/documents-sources/).

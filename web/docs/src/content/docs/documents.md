---
title: "Documents"
description: "Ingest text, URLs, and files into linked searchable chunks."
---

Signet is a local-first memory and context layer for AI agents.

## Choose the right kind of context

- **Native memory** — save a small durable item Signet owns. See [Memory](/memory/).
- **Documents** — ingest content into linked `document_chunk` memories for search.
- **Connected sources** — read from a source that keeps its own canonical files or service data. See [Sources](/sources/).
- **Durable transcript imports** — preserve exported sessions through the durable Sources job. See [Sources: agent transcript imports](/sources/#agent-transcript-imports).

## Submit a document

Use the document ingestion flow for `text`, `url`, or `file` source types. Text includes `content`; URL submissions include `url` and are fetched by the worker. A new submission is recorded as `queued`; processing continues in the background.

URL and file submissions deduplicate by source URL within the same agent and project scope while the existing document is not `failed` or `deleted`. A duplicate returns the existing document's real status and does not invent a generic `processing` state.

For endpoint fields and response schemas, use [Documents and sources API](/api/documents-sources/).

### Poll and inspect

Treat `201`/`queued` as acknowledgement, not completion. Poll `GET /api/documents/:id` until `status` is `done` or `failed`. On `done`, call `GET /api/documents/:id/chunks` to inspect count, ordered `chunk_index`, content, and provenance. On `failed`, use the error to correct the input or worker configuration, then resubmit.

## Follow the document lifecycle

```text
queued → extracting → chunking → embedding → indexing → done
```

The worker reports `queued`, `extracting`, `chunking`, `embedding`, `indexing`, `done`, `failed`, and `deleted`. Deletion marks the document `deleted` and stops further writes after the current bounded step.

Completed chunks use `type: "document_chunk"` and link to the document with a sequential `chunk_index`. Identical chunk content may be shared by documents in the same agent/project scope.

## Control chunking

The worker splits content by characters with overlap and skips whitespace-only chunks.

| Setting | Default | Accepted range |
|---|---:|---:|
| Chunk size | 2,000 characters | 200–50,000 |
| Chunk overlap | 200 characters | 0–10,000 |
| Worker interval | 10,000 ms | 1,000–300,000 ms |
| Maximum content | 10 MiB | 1 KiB–100 MiB |

Configure these under `memory.pipelineV2.documents` in `agent.yaml`:

```yaml
memory:
  pipelineV2:
    documents:
      chunkSize: 2000
      chunkOverlap: 200
      workerIntervalMs: 10000
      maxContentBytes: 10485760
```

The daemon validates and clamps values on configuration load. Document settings use the `memory.pipelineV2.documents` namespace; flat document keys remain accepted within that namespace. Changes affect future ingestion. Delete and resubmit a document to apply new chunking to existing content.

## Delete a document

Document deletion is daemon-backed. It marks the document `deleted` and completes any still-pending document-ingest job. The response is `{ deleted, memoriesRemoved }`; it soft-deletes only linked memories no longer referenced by another non-deleted document. Shared chunks remain through other live documents, so `memoriesRemoved` is the number actually removed, not necessarily the document's chunk count.

For connected sources and imported transcript sources, use [Sources](/sources/) and its source-specific lifecycle rules.

For worker behavior and exact request permissions, see [Documents and sources API](/api/documents-sources/) and [Pipeline](/pipeline/).

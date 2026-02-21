Document Ingest
===============

The document ingest subsystem lets you push arbitrary text content or URLs
into Signet's memory store. Documents are split into overlapping chunks,
each chunk is embedded and written as a `document_chunk` memory, and the
whole set is linked back to the originating document record. Once indexed,
chunks participate in hybrid search alongside any other memory type.

This doc covers the ingest API, processing lifecycle, chunking mechanics,
and worker configuration. For full endpoint signatures and auth details,
see `docs/API.md`.


Source Types
------------

Every document submission declares a `source_type`:

- `text` — raw string content supplied directly in the request body.
- `url` — a remote URL the daemon fetches and extracts text from.
- `file` — a local or remote file path (URL field used for path reference).

For `url` sources, content is fetched at processing time by the worker,
not at submission time. The title field is also populated from the page
`<title>` if not supplied in the request.


API Endpoints
-------------

### POST /api/documents

Submits a document for ingestion. The document is written to the database
with status `queued` and a background job is enqueued immediately.

Request body:

```json
{
  "source_type": "text",
  "title": "Optional title",
  "content": "The full document text.",
  "content_type": "text/plain",
  "metadata": { "arbitrary": "key-value pairs" }
}
```

For `url` source type, replace `content` with `url`:

```json
{
  "source_type": "url",
  "url": "https://example.com/article",
  "title": "Optional override title"
}
```

Response on success (`201 Created`):

```json
{ "id": "<uuid>", "status": "queued" }
```

If the same URL is already tracked in a non-failed, non-deleted state,
the endpoint returns the existing record instead of creating a duplicate:

```json
{ "id": "<existing-uuid>", "status": "done", "deduplicated": true }
```

### GET /api/documents

Lists all documents, ordered by creation date descending.

Query parameters:

- `status` — filter by lifecycle status (e.g. `?status=done`).
- `limit` — page size, default `50`, maximum `500`.
- `offset` — pagination offset, default `0`.

Response:

```json
{
  "documents": [ /* document rows */ ],
  "total": 42,
  "limit": 50,
  "offset": 0
}
```

### GET /api/documents/:id

Returns the full document row for the given ID, including status, chunk
count, memory count, error message if any, and raw metadata.

Returns `404` if the ID is not found.

### GET /api/documents/:id/chunks

Returns all memory entries linked to a document, ordered by chunk index.
Only returns chunks where `is_deleted = 0`.

Response:

```json
{
  "chunks": [
    {
      "id": "<memory-uuid>",
      "content": "chunk text...",
      "type": "document_chunk",
      "created_at": "2025-01-01T00:00:00.000Z",
      "chunk_index": 0
    }
  ],
  "count": 7
}
```

### DELETE /api/documents/:id

Soft-deletes the document and all linked memories. Requires a `reason`
query parameter (`?reason=outdated`). Each linked memory gets its
`is_deleted` flag set to `1` and a deletion event is appended to
`memory_history`. The document row is set to status `deleted`.

Response:

```json
{ "deleted": true, "memoriesRemoved": 7 }
```


Status Lifecycle
----------------

A document moves through these statuses during processing:

```
queued → extracting → chunking → embedding → indexing → done
```

At any stage the worker may transition the document to `failed` if an
unrecoverable error occurs. Deleted documents land in `deleted` status
after a DELETE request.

| Status       | Meaning                                              |
|--------------|------------------------------------------------------|
| `queued`     | Job enqueued, worker has not picked it up yet.       |
| `extracting` | Fetching remote content (URL sources only).          |
| `chunking`   | Splitting content into chunks.                       |
| `embedding`  | Requesting embedding vectors for each chunk.         |
| `indexing`   | Final writes — memory records and FTS index update.  |
| `done`       | All chunks embedded and indexed.                     |
| `failed`     | Processing error. See `error` field on the document. |
| `deleted`    | Document removed via DELETE endpoint.                |

Status transitions are written inside write transactions so reads always
see a consistent state.


Chunking Strategy
-----------------

Text is split into fixed-size windows with a configurable overlap. The
overlap ensures that context spanning a chunk boundary is not silently
dropped at retrieval time.

The splitter is character-based, not token-based. Given `chunkSize = 2000`
and `chunkOverlap = 200`:

- Chunk 0 covers characters `0..2000`.
- Chunk 1 covers characters `1800..3800`.
- Chunk 2 covers characters `3600..5600`.
- And so on until the end of the document.

Documents shorter than `chunkSize` are stored as a single chunk. Empty
chunks (whitespace only) are skipped and do not produce memory entries.

Default values:

| Parameter           | Default | Min  | Max        |
|---------------------|---------|------|------------|
| `documentChunkSize` | `2000`  | `200`| `50000`    |
| `documentChunkOverlap` | `200` | `0` | `10000`    |
| `documentMaxContentBytes` | `10 MB` | `1 KB` | `100 MB` |

See the Configuration section below for how to override these.


Document-to-Memory Linking
--------------------------

Each chunk that passes the dedup check becomes an entry in the `memories`
table with `type = "document_chunk"`. Two join tables connect the pieces:

- `document_memories` — links a `document_id` to a `memory_id` with the
  chunk's sequential `chunk_index`. This is the primary join for retrieval
  by document.
- `embeddings` — stores the vector blob for each chunk, keyed on
  `content_hash`. If two documents share identical chunk text they will
  share the same embedding row.

Deduplication happens at the chunk level: before writing a new memory the
worker checks whether a non-deleted memory with the same content hash is
already linked to the document. Matching chunks are silently skipped.

Tags on chunk memories take the form `document:<title>`, making it easy to
filter hybrid search results by source document.


Worker Model
------------

`startDocumentWorker()` runs a polling loop inside the daemon process. It
shares the same lease-based job table (`memory_jobs`) used by the
extraction worker. The job type is `document_ingest`.

On each tick the worker:

1. Atomically claims one pending job by setting its status to `leased`
   and incrementing `attempts`.
2. Looks up the associated document row.
3. Runs it through the full `extracting → chunking → embedding → indexing`
   sequence, updating document status at each stage.
4. Marks the job `completed` and the document `done`.

If processing throws, the job is retried up to `workerMaxRetries` times
(default `3`). After exhausting retries the job moves to `dead` and the
document to `failed`.

Embedding calls are intentionally made *outside* write transactions to
avoid holding a SQLite write lock during network I/O. Each chunk's memory
write is its own short transaction.

The worker is started alongside the extraction pipeline in
`packages/daemon/src/pipeline/index.ts` and stops cleanly when the daemon
shuts down.


Configuration
-------------

Document worker settings live under the `pipeline` key in `agent.yaml`
(or the equivalent daemon config). All values are validated and clamped
on load.

```yaml
pipeline:
  documentChunkSize: 2000          # chars per chunk
  documentChunkOverlap: 200        # overlap between adjacent chunks
  documentWorkerIntervalMs: 10000  # polling interval in milliseconds
  documentMaxContentBytes: 10485760  # max fetched content for URL sources
```

`documentWorkerIntervalMs` controls how frequently the worker polls for
new jobs. The minimum is `1000 ms`; the maximum is `300000 ms` (5 min).

Changes to chunk size do not retroactively re-chunk existing documents.
To re-process a document with new chunk settings, delete it and resubmit.

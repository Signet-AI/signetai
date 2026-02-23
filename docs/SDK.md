---
title: "SDK"
description: "Integration SDK for third-party applications."
order: 11
section: "Reference"
---

@signet/sdk
===

`@signet/sdk` is a typed TypeScript HTTP client for the Signet daemon API.
It has no native dependencies — no SQLite, no `@signet/core` — making it
suitable for embedding in any Node.js, Bun, or browser environment that
can reach the daemon over HTTP.

Install with:

```bash
bun add @signet/sdk
# or
npm install @signet/sdk
```


Basic Usage
---

```typescript
import { SignetClient } from "@signet/sdk";

const signet = new SignetClient({ daemonUrl: "http://localhost:3850" });

await signet.remember("User prefers dark mode");
const results = await signet.recall("user preferences");
```

All methods return promises and throw typed errors on failure. The client
is safe to instantiate once and reuse across the lifetime of your process.


Configuration
---

`SignetClient` accepts an optional config object:

```typescript
interface SignetClientConfig {
  daemonUrl?: string;    // Default: "http://localhost:3850"
  timeoutMs?: number;    // Per-request timeout in ms. Default: 10000
  retries?: number;      // Retry attempts for GET requests. Default: 2
  token?: string;        // Bearer token for authenticated daemon modes
  actor?: string;        // Sets x-signet-actor header (e.g. agent name)
  actorType?: string;    // Sets x-signet-actor-type header
}
```

`token`, `actor`, and `actorType` are sent as request headers on every
call. Only GET requests are retried; POST/PATCH/DELETE are not, since
they are not idempotent by default. Retry backoff is linear at 500ms
intervals.


Client Methods
---

### Memory

**`remember(content, opts?)`** — Save a memory to the daemon.

```typescript
const result = await signet.remember("Prefers TypeScript over JavaScript", {
  type: "preference",
  importance: 0.9,
  tags: "language,tooling",
  pinned: false,
  mode: "sync",         // "auto" | "sync" | "async"
  idempotencyKey: "pref-ts-001",
});
// result.id — assigned memory ID
// result.deduped — true if an existing memory was reused
```

**`recall(query, opts?)`** — Hybrid search across memories using both
vector similarity and keyword matching.

```typescript
const { results, stats } = await signet.recall("language preferences", {
  limit: 10,
  type: "preference",
  importance_min: 0.5,
  minScore: 0.3,
  since: "2025-01-01T00:00:00Z",
});
// results[n].score — relevance score
// results[n].source — "hybrid" | "vector" | "keyword"
// stats.searchTime — milliseconds
```

**`getMemory(id)`** — Fetch a single memory record by ID.

```typescript
const memory = await signet.getMemory("mem_abc123");
// Returns a full MemoryRecord including version, access_count, etc.
```

**`listMemories(opts?)`** — List memories with optional pagination and
type filter.

```typescript
const { memories, stats } = await signet.listMemories({
  limit: 50,
  offset: 0,
  type: "preference",
});
// stats.total — total count across all pages
// stats.critical — count of pinned/critical memories
```

**`modifyMemory(id, patch)`** — Update a memory's content or metadata.
Requires a `reason` field for audit trail purposes. Supports optimistic
concurrency via `ifVersion`.

```typescript
const result = await signet.modifyMemory("mem_abc123", {
  content: "Prefers Bun over Node.js for new projects",
  importance: 0.95,
  reason: "Updated based on conversation",
  ifVersion: 3,  // fails with version_conflict if current version differs
});
// result.status — "updated" | "no_changes" | "version_conflict" | ...
```

**`forgetMemory(id, opts)`** — Soft-delete a single memory. Pinned
memories require `force: true`.

```typescript
await signet.forgetMemory("mem_abc123", {
  reason: "No longer relevant",
  force: false,
  ifVersion: 4,
});
// result.status — "deleted" | "pinned_requires_force" | "version_conflict"
```

**`batchForget(opts)`** — Bulk soft-delete with a two-phase preview/execute
flow. Call with `mode: "preview"` first to see what would be deleted and
receive a `confirmToken`. Pass that token back with `mode: "execute"` to
commit.

```typescript
// Phase 1: preview
const preview = await signet.batchForget({
  mode: "preview",
  query: "outdated project notes",
  type: "note",
});
// preview.confirmToken — pass this to the execute call

// Phase 2: execute
const result = await signet.batchForget({
  mode: "execute",
  query: "outdated project notes",
  type: "note",
  confirm_token: preview.confirmToken,
  reason: "Cleaning up stale notes",
});
// result.deleted — number actually deleted
// result.pinned — number skipped due to pinning
```

**`batchModify(patches, opts?)`** — Apply multiple memory patches in one
request. Each patch requires a `reason`.

```typescript
const { results } = await signet.batchModify([
  { id: "mem_1", importance: 0.8, reason: "Recalibrate importance" },
  { id: "mem_2", tags: "archived", reason: "Tag for archival" },
]);
```

**`getHistory(memoryId, opts?)`** — Retrieve the full audit trail for a
memory: all create, update, and delete events.

```typescript
const { history } = await signet.getHistory("mem_abc123", { limit: 20 });
// history[n].event — event type string
// history[n].old_content / new_content — diff
// history[n].changed_by — actor identity
```

**`recoverMemory(id, opts?)`** — Restore a soft-deleted memory.

```typescript
const result = await signet.recoverMemory("mem_abc123", {
  reason: "Accidentally deleted",
});
// result.status — "recovered" | "not_found" | "not_deleted"
// result.retentionDays — how long before permanent deletion
```


### Jobs

**`getJob(jobId)`** — Check the status of an async pipeline job. When
`remember` is called with `mode: "async"`, the response includes a job
ID that you can poll here.

```typescript
const job = await signet.getJob("job_xyz");
// job.status — "pending" | "leased" | "retry_scheduled" | "done" | "dead"
// job.last_error — error message if the job failed
```


### Documents

Documents are ingested content units (text, URLs, or files). The daemon
chunks and embeds them, then links the resulting memories back to the
source document.

**`createDocument(opts)`** — Ingest a new document.

```typescript
const result = await signet.createDocument({
  source_type: "text",
  content: "Full text of a design doc...",
  title: "Q1 Architecture Proposal",
  content_type: "text/plain",
  metadata: { project: "signet", version: "2.0" },
});
// result.id — document ID
// result.deduplicated — true if the same content already exists
```

**`getDocument(id)`** — Fetch a document record including chunk and
memory counts.

**`listDocuments(opts?)`** — List documents with status filter and
pagination.

```typescript
const { documents } = await signet.listDocuments({
  status: "processed",
  limit: 20,
  offset: 0,
});
```

**`getDocumentChunks(id)`** — Get the individual chunks that were
extracted from a document during ingestion.

```typescript
const { chunks } = await signet.getDocumentChunks("doc_abc");
// chunks[n].chunk_index — ordering within the document
// chunks[n].content — raw chunk text
```

**`deleteDocument(id, reason)`** — Delete a document and remove all
associated memories.

```typescript
const result = await signet.deleteDocument("doc_abc", "Project closed");
// result.memoriesRemoved — count of memories cleaned up
```


### Health and Status

**`health()`** — Lightweight liveness check. Returns uptime, PID,
version, and port. Suitable for polling.

**`status()`** — Full daemon status including pipeline V2 configuration,
embedding provider details, and an overall health score.

**`diagnostics(domain?)`** — Health scoring by subsystem. Pass a domain
string (e.g. `"memory"`, `"pipeline"`) to scope the report, or omit it
for a full system diagnostic. The response shape is open-ended and may
vary by daemon version.


### Auth

Auth methods are only relevant when the daemon runs in a mode that
requires token-based access.

**`createToken(opts)`** — Generate a signed auth token scoped to a role,
project, agent, or user. Requires the calling token to have sufficient
privileges.

```typescript
const { token, expiresAt } = await signet.createToken({
  role: "reader",
  scope: { project: "signet", agent: "my-bot" },
  ttlSeconds: 3600,
});
```

**`whoami()`** — Inspect the claims of the currently configured token.

```typescript
const { authenticated, claims } = await signet.whoami();
```


Error Handling
---

All errors thrown by `SignetClient` are instances of `SignetError` or
one of its subclasses, exported from `@signet/sdk`.

- `SignetApiError` — The daemon responded with a non-2xx status. Has
  `.status` (HTTP code) and `.body` (parsed response). The message is
  taken from the `error` field of the response body when present.
- `SignetNetworkError` — Fetch failed at the network level (connection
  refused, DNS failure, etc.). Has `.cause` pointing to the underlying
  `Error`.
- `SignetTimeoutError` — A subclass of `SignetNetworkError` raised when
  a request exceeds `timeoutMs`.

```typescript
import { SignetApiError, SignetNetworkError } from "@signet/sdk";

try {
  await signet.getMemory("mem_nonexistent");
} catch (err) {
  if (err instanceof SignetApiError && err.status === 404) {
    // memory not found — handle gracefully
  } else if (err instanceof SignetNetworkError) {
    // daemon unreachable
  } else {
    throw err;
  }
}
```

GET requests are retried up to `retries` times (default 2) on network
errors. API errors (4xx/5xx responses) are never retried.


React Hooks
---

`@signet/sdk/react` (imported from `react.tsx`) ships React bindings
built on top of `SignetClient`. They require React 18+ and must be used
inside a `SignetProvider`.

```typescript
import { SignetProvider, useSignet, useMemorySearch, useMemory }
  from "@signet/sdk/react";
```

**`SignetProvider`** — Wrap your app or subtree. Runs a health check on
mount and exposes `connected` and `error` via context.

```tsx
<SignetProvider config={{ daemonUrl: "http://localhost:3850" }}>
  <App />
</SignetProvider>
```

You can also pass a pre-constructed `client` instance if you need to
share it outside React.

**`useSignet()`** — Access the raw context: `{ client, connected, error }`.
Throws if called outside a `SignetProvider`.

**`useMemorySearch(query, opts?)`** — Reactive recall. Re-runs whenever
`query` changes. Returns `{ data, loading, error }`. Pass `null` to
suppress the search.

```tsx
const { data: results, loading } = useMemorySearch("user preferences", {
  limit: 5,
  type: "preference",
});
```

**`useMemory(id)`** — Fetch a single memory by ID reactively. Returns
`{ data, loading, error }`. Pass `null` to suppress.

```tsx
const { data: memory, error } = useMemory(selectedId);
```

Both hooks clean up in-flight requests on unmount via `AbortController`.


Examples
---

### Chat agent saving conversation memories

A pattern for agents that summarize and retain information across
sessions. Call `remember` after each assistant turn with a condensed
takeaway.

```typescript
import { SignetClient } from "@signet/sdk";

const signet = new SignetClient({
  daemonUrl: "http://localhost:3850",
  actor: "chat-agent",
  actorType: "llm",
});

async function onAssistantTurn(userMessage: string, reply: string) {
  const summary = extractKeyFact(userMessage, reply);
  if (!summary) return;

  await signet.remember(summary, {
    type: "conversation",
    importance: 0.7,
    mode: "async",   // non-blocking — pipeline runs in background
  });
}

async function buildSystemPrompt(topic: string): Promise<string> {
  const { results } = await signet.recall(topic, { limit: 5 });
  const context = results.map((r) => `- ${r.content}`).join("\n");
  return `Relevant context:\n${context}`;
}
```


### Coding agent injecting recalled context

A pattern for code-generation agents that need to surface relevant
architectural notes or preferences before producing output.

```typescript
import { SignetClient } from "@signet/sdk";
import { SignetApiError } from "@signet/sdk";

const signet = new SignetClient({ daemonUrl: "http://localhost:3850" });

async function getContextForTask(taskDescription: string): Promise<string[]> {
  try {
    const { results } = await signet.recall(taskDescription, {
      limit: 8,
      importance_min: 0.6,
      minScore: 0.4,
    });
    return results.map((r) => r.content);
  } catch (err) {
    if (err instanceof SignetApiError) {
      console.warn("Signet unavailable, proceeding without context");
      return [];
    }
    throw err;
  }
}

async function generateCode(task: string): Promise<string> {
  const context = await getContextForTask(task);
  const prompt = context.length > 0
    ? `Context:\n${context.join("\n")}\n\nTask: ${task}`
    : `Task: ${task}`;

  return callLLM(prompt);
}
```

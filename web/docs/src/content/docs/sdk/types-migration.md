---
title: "Helpers, types, and migration"
description: "Use helper methods, TypeScript types, error contracts, and migration guidance."
---

## Helper Methods

Convenience methods that combine multiple operations.

**`waitForJob(jobId, opts?)`** — Poll job until completion.

```typescript
const job = await signet.waitForJob("job-123", {
  timeout: 60_000,  // 1 minute timeout
  interval: 500,    // Poll every 500ms
});
// job.status — "completed" | "failed" | "done" | "dead"
// job.result — job result (if completed)
```

**`createAndIngestDocument(opts)`** — Create and wait for ingestion.

```typescript
const doc = await signet.createAndIngestDocument({
  source_type: "url",
  url: "https://example.com/article",
  title: "Example Article",
});
// Document is fully ingested and ready
// doc.status — "done"
```

**`recallOrThrow(query, opts?)`** — Recall that throws if no results.

```typescript
try {
  const { results, meta } = await signet.recallOrThrow("user preferences", {
    type: "preference",
    limit: 5,
    minScore: 0.5, // applied at the daemon response boundary; also checked locally
    agentId: "my-agent",
  });
  // Guaranteed to have at least one result
  // meta.totalReturned matches the filtered result count
} catch (err) {
  console.log("No preferences found");
}
```

**`getMemoryOrThrow(id)`** — Get memory with 404 handling.

```typescript
const memory = await signet.getMemoryOrThrow("mem-abc-123");
// Throws if not found
```

**`getDocumentOrThrow(id)`** — Get document with 404 handling.

```typescript
const doc = await signet.getDocumentOrThrow("doc-123");
// Throws if not found
```

**`batchModifyWithProgress(patches, onProgress?)`** — Batch modify with progress.

```typescript
const result = await signet.batchModifyWithProgress(
  [
    { id: "m1", reason: "fix typo", content: "corrected" },
    { id: "m2", reason: "update", content: "updated" },
  ],
  (progress) => {
    console.log(`${progress.done}/${progress.total} complete`);
  },
);
// result.success — successful modifications
// result.failed — failed modifications
```

## Error Handling

All methods throw `SignetApiError` for HTTP failures and `SignetNetworkError`
for connection issues.

```typescript
import { SignetApiError, SignetNetworkError } from "@signet/sdk";

try {
  await signet.remember("important fact");
} catch (err) {
  if (err instanceof SignetApiError) {
    console.error(`API error ${err.status}: ${err.message}`);
    // err.status — HTTP status code
    // err.endpoint — failing endpoint
    // err.details — additional error details
  } else if (err instanceof SignetNetworkError) {
    console.error(`Network error: ${err.message}`);
    // Daemon unreachable
  } else {
    throw err;
  }
}
```

## TypeScript Support

The SDK is written in TypeScript and provides full type definitions.

```typescript
import type {
  MemoryRecord,
  RecallResponse,
  JobStatus,
  DocumentRecord,
  ConnectorRecord,
  TaskRecord,
  SessionRecord,
  // ... and 100+ more types
} from "@signet/sdk";
```

All types are exported from the main entry point and can be imported directly.

## Migration Guide

### Upgrading from 0.x to 1.0

**No breaking changes** — The 1.0 SDK is fully backward compatible with 0.x.

Key improvements in 1.0:
- 148 daemon endpoints covered (vs. ~25 in 0.x)
- Comprehensive helper methods
- Full TypeScript coverage
- Improved error types
- Better documentation

To upgrade:

```bash
npm install @signet/sdk@latest
```

No code changes required. All existing method signatures remain unchanged.

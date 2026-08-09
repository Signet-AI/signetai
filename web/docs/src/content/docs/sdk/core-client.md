---
title: "Core client"
description: "Use client methods, jobs, sessions, scheduling, Git, secrets, and typed errors."
---

## Client Methods

### Memory

**`remember(content, opts?)`** — Save a memory to the daemon.

```typescript
const result = await signet.remember("Prefers TypeScript over JavaScript", {
  type: "preference",
  importance: 0.9,
  tags: "language,tooling",
  pinned: false,
  occurredAt: "2026-05-13T18:00:00Z",
  reviewAfter: "2026-08-03T00:00:00.000Z",
  mode: "sync",         // "auto" | "sync" | "async"
  idempotencyKey: "pref-ts-001",
});
// result.id — assigned memory ID
// result.deduped — true if an existing memory was reused
```

**`recall(query, opts?)`** — Hybrid search across memories using both
vector similarity and keyword matching.

A good default posture is:

- start with `query`
- add `limit`, `project`, or `expand` when you need more control
- reach for the other filters only when you know why you want them

```typescript
const { results, query, method, meta } = await signet.recall("language preferences", {
  project: "/home/user/myapp",
  limit: 10,
  time: { start: "2026-05-13T00:00:00Z", end: "2026-05-14T00:00:00Z" },
  expand: true,
  scope: "world:alpha",
});
// Omitted limits are sent as 10; request limits are bounded to 1..100
// scope is an exact daemon memory-scope string; use agentId/sessionKey for isolation
// meta.timings?.stages — daemon-side recall stages and durations
// meta.temporal — resolved temporal window when date recall is active
```

You can refine further when needed:

```typescript
const result = await signet.recall("language preferences", {
  keywordQuery: "\"language preferences\" OR tooling",
  project: "/home/user/myapp",
  type: "preference",
  importance_min: 0.5,
  minScore: 0.3,
  since: "2025-01-01T00:00:00Z",
  until: "2026-01-01T00:00:00Z",
});
// result.results[n].score — relevance score
// result.results[n].source — "hybrid" | "vector" | "keyword" | "llm_summary"
// result.results[n].supplementary — true for supporting context like summary cards
// result.query — normalized query used by the daemon
// result.method — "hybrid" | "keyword"
// result.meta.totalReturned — result count after client-side minScore filtering
// result.meta.timings — present when the daemon returns recall stage timings
```

`recall()` and `recallOrThrow()` use the canonical Signet request builder, so
they share default, bound, alias, omission, session, agent, scope, and aggregate
semantics with runtime integrations. `minScore` is applied client-side by the
SDK after the daemon returns recall results and is never included in daemon
JSON. This keeps the API contract honest while preserving compatibility for
existing SDK callers that already rely on score thresholding.

Explicit aggregate recall is available through the same method:

```typescript
const aggregate = await signet.recall("what did we decide about onboarding?", {
  aggregate: true,
  aggregateBudget: "small",
  saveAggregate: false,
});
// aggregate.results[0] — synthesized aggregate row when evidence exists
// aggregate.aggregate?.queries — recall queries used during aggregation
// aggregate.aggregate?.usage — provider-reported token/cost totals when available
// aggregate.meta.timings?.stages — aggregate planning/synthesis timings
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
// job.status — "pending" | "leased" | "retry_scheduled" | "failed" | "completed" | "done" | "dead"
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
// result.jobId — optional job id for async ingest tracking
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

## Error Handling

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

## Examples

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
    const { results, meta } = await signet.recall(taskDescription, {
      limit: 8,
      importance_min: 0.6,
      minScore: 0.4,
    });
    console.log(`recall returned ${meta.totalReturned} usable results`);
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

## Sessions & Bypass

Manage active sessions and per-session bypass mode.

**`listSessions()`** — List all active sessions with bypass status.

```typescript
const sessions = await signet.listSessions();
// sessions[n].key — session identifier
// sessions[n].bypassed — whether hooks are disabled for this session
// sessions[n].createdAt — session start time
```

**`getSession(key)`** — Get details for a specific session.

```typescript
const session = await signet.getSession("sess-abc-123");
console.log(session.bypassed); // true | false
```

**`setSessionBypass(key, enabled)`** — Toggle bypass mode for a session.

```typescript
// Enable bypass (disable all hooks for this session)
await signet.setSessionBypass("sess-abc-123", true);

// Disable bypass (re-enable hooks)
await signet.setSessionBypass("sess-abc-123", false);
```

Bypass mode is useful for:
- Running one-off commands without triggering memory extraction
- Testing without polluting the knowledge base
- Performing maintenance operations that shouldn't create memories

## Tasks & Scheduling

Create, manage, and run scheduled tasks (cron jobs, one-off tasks).

**`listTasks()`** — List all configured tasks.

```typescript
const { tasks, presets } = await signet.listTasks();
// tasks[n].cron_expression — cron schedule
// tasks[n].enabled — whether task is active
// presets — built-in cron presets (e.g. "@hourly")
```

**`createTask(opts)`** — Create a new scheduled task.

```typescript
const task = await signet.createTask({
  name: "Daily Summary",
  prompt: "Generate daily summary of memories",
  cronExpression: "0 9 * * *",  // Daily at 9 AM
  harness: "claude-code",       // "claude-code" | "codex" | "opencode"
  workingDirectory: "/home/user/project",
  skillName: "reporter",
  skillMode: "inject",          // "inject" | "slash"
});
// task.id — assigned task ID
// task.nextRunAt — ISO timestamp for next scheduled run
```

**`getTask(id)`** — Fetch a single task by ID.

```typescript
const { task, runs } = await signet.getTask("task-abc-123");
console.log(task.name, runs[0]?.status);
```

**`updateTask(id, opts)`** — Update task configuration.

```typescript
await signet.updateTask("task-abc-123", {
  cronExpression: "0 10 * * *",  // Change to 10 AM
  enabled: false,  // Disable the task
});
```

**`deleteTask(id)`** — Delete a task.

```typescript
await signet.deleteTask("task-abc-123");
```

**`runTask(id)`** — Trigger immediate task execution.

```typescript
const run = await signet.runTask("task-abc-123");
// run.runId — run identifier
// run.status — "running"
```

**`listTaskRuns(id)`** — Get execution history for a task.

```typescript
const runs = await signet.listTaskRuns("task-abc-123", {
  limit: 10,
  offset: 0,
});
// runs.runs[n].status — execution outcome
// runs.runs[n].started_at — when run started
// runs.runs[n].completed_at — when run finished
// runs.total — total run count
// runs.hasMore — whether additional pages exist
```

## Git Synchronization

Manage automatic git sync with remote repositories.

**`getGitStatus()`** — Get current sync status.

```typescript
const status = await signet.getGitStatus();
// status.branch — current branch name
// status.ahead — commits not pushed
// status.behind — commits not pulled
// status.last_sync — timestamp of last successful sync
// status.conflicts — any merge conflicts
```

**`gitPull()`** — Pull from remote.

```typescript
const result = await signet.gitPull();
// result.success — true if pull succeeded
// result.commits — number of commits pulled
// result.conflicts — any conflicts detected
```

**`gitPush()`** — Push to remote.

```typescript
const result = await signet.gitPush();
// result.success — true if push succeeded
// result.commits — number of commits pushed
```

**`gitSync()`** — Pull then push (sync).

```typescript
const result = await signet.gitSync();
// Combines pull + push in one call
// Handles merge automatically
```

**`getGitConfig()`** — Get git sync configuration.

```typescript
const config = await signet.getGitConfig();
// config.remote — configured remote (if any)
// config.branch — branch to sync
// config.autoSync — whether auto-sync is enabled
// config.syncInterval — sync interval in seconds
```

**`updateGitConfig(opts)`** — Configure git sync.

```typescript
await signet.updateGitConfig({
  remote: "git@github.com:user/memories.git",
  branch: "main",
  autoSync: true,
  syncInterval: 300,
});
```

## Secrets Management

Store secrets securely, list names, and inject values into subprocesses.
Ordinary SDK calls do not retrieve raw secret values. The `signet.secrets`
core plugin owns these helpers and keeps compatibility with the local
encrypted store plus 1Password import flow.

**`listSecrets()`** — List all secret names (not values).

```typescript
const { secrets } = await signet.listSecrets();
// secrets[n] — secret name (e.g., "OPENAI_API_KEY")
```

**`storeSecret(name, value)`**: Store a secret.

```typescript
await signet.storeSecret("ANTHROPIC_API_KEY", "sk-ant-...");
```

**`deleteSecret(name)`** — Delete a secret.

```typescript
await signet.deleteSecret("OLD_API_KEY");
```

**`execWithSecrets(opts)`** — Run command with secrets injected as env vars.

```typescript
const result = await signet.execWithSecrets("curl https://api.openai.com/v1/models", {
  OPENAI_API_KEY: "OPENAI_API_KEY",  // Bare name maps to local://OPENAI_API_KEY
});
// result.stdout — command output
// result.stderr — error output
// result.code: process exit code
```

### 1Password Integration

**`connectOnePassword(token)`**: Connect to 1Password using service account.

```typescript
await signet.connectOnePassword("ops_...");
```

**`listOnePasswordVaults()`**: List available 1Password vaults.

```typescript
const { vaults } = await signet.listOnePasswordVaults();
// vaults[n].id — vault identifier
// vaults[n].name — vault name
```

**`import1PasswordSecrets(opts)`** — Import secrets from 1Password.

```typescript
await signet.import1PasswordSecrets({
  vaults: ["Private"],
  prefix: "OP",
  overwrite: false,
});
```

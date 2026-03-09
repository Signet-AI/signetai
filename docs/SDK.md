---
title: "SDK"
description: "Integration SDK for third-party applications."
order: 11
section: "Reference"
---

@signet/sdk
===

`@signet/sdk` is a typed TypeScript HTTP client for the Signet [[daemon]]
[[api|API]]. It has no native dependencies — no SQLite, no `@signet/core` —
making it suitable for embedding in any Node.js, Bun, or browser environment
that can reach the daemon over HTTP.

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
call (see [[auth]] for token details). Only GET requests are retried;
POST/PATCH/DELETE are not, since they are not idempotent by default. Retry backoff is linear at 500ms
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


Vercel AI SDK Integration
---

`@signet/sdk/ai-sdk` provides tool definitions and context injection
compatible with the Vercel AI SDK (`ai` package from sdk.vercel.ai).
Requires `zod` as a peer dependency (already present if you use the AI
SDK).

**`memoryTools(client)`** — Returns an object of tool definitions
(`memory_search`, `memory_store`, `memory_modify`, `memory_forget`)
that can be passed directly to the `tools` parameter of `generateText`
or `streamText`.

```typescript
import { SignetClient } from "@signet/sdk";
import { memoryTools } from "@signet/sdk/ai-sdk";
import { generateText } from "ai";

const signet = new SignetClient();
const tools = await memoryTools(signet);

const result = await generateText({
  model: yourModel,
  tools,
  prompt: "What do you know about the user's coding preferences?",
});
```

Each tool is a standard Vercel AI SDK tool with `description`,
`parameters` (zod schema), and `execute` function.

**`getMemoryContext(client, userMessage, opts?)`** — Convenience helper
that runs a recall search and formats the results as a markdown string
suitable for injecting into a system prompt.

```typescript
import { getMemoryContext } from "@signet/sdk/ai-sdk";

const context = await getMemoryContext(signet, userMessage, {
  limit: 5,
  minScore: 0.3,
});
// Returns "" if no results, or "## Relevant Memories\n- ..." otherwise
```


OpenAI SDK Integration
---

`@signet/sdk/openai` provides tool definitions and a dispatcher
compatible with OpenAI's function calling format.

**`memoryToolDefinitions()`** — Returns an array of OpenAI-format tool
definitions (`memory_search`, `memory_store`, `memory_modify`,
`memory_forget`) ready for the `tools` parameter of
`openai.chat.completions.create`.

```typescript
import { memoryToolDefinitions, executeMemoryTool } from "@signet/sdk/openai";

const tools = memoryToolDefinitions();

const response = await openai.chat.completions.create({
  model: "gpt-4o",
  tools,
  messages,
});
```

**`executeMemoryTool(client, toolName, args)`** — Dispatches a tool call
to the corresponding `SignetClient` method. Pass the function name and
parsed arguments from an OpenAI tool call response.

```typescript
for (const call of response.choices[0].message.tool_calls ?? []) {
  const result = await executeMemoryTool(
    signet,
    call.function.name,
    JSON.parse(call.function.arguments),
  );
}
```


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


Sessions & Bypass
---

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


Tasks & Scheduling
---

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

Git Synchronization
---

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


Secrets Management
---

Store and retrieve secrets securely (integrates with 1Password).

**`listSecrets()`** — List all secret names (not values).

```typescript
const secrets = await signet.listSecrets();
// secrets[n] — secret name (e.g., "OPENAI_API_KEY")
```

**`getSecret(name)`** — Retrieve a secret value.

```typescript
const apiKey = await signet.getSecret("OPENAI_API_KEY");
console.log(apiKey);  // "sk-proj-..."
```

**`setSecret(name, value)`** — Store a secret.

```typescript
await signet.setSecret("ANTHROPIC_API_KEY", "sk-ant-...");
```

**`deleteSecret(name)`** — Delete a secret.

```typescript
await signet.deleteSecret("OLD_API_KEY");
```

**`execWithSecrets(opts)`** — Run command with secrets injected as env vars.

```typescript
const result = await signet.execWithSecrets({
  command: "curl https://api.openai.com/v1/models",
  secrets: {
    OPENAI_API_KEY: "OPENAI_API_KEY",  // Maps to stored secret
  },
});
// result.stdout — command output
// result.stderr — error output
// result.exit_code — process exit code
```

### 1Password Integration

**`connect1Password(opts)`** — Connect to 1Password using service account.

```typescript
await signet.connect1Password({
  token: "ops_...",  // 1Password service account token
});
```

**`list1PasswordVaults()`** — List available 1Password vaults.

```typescript
const vaults = await signet.list1PasswordVaults();
// vaults[n].id — vault identifier
// vaults[n].name — vault name
```

**`import1PasswordSecrets(opts)`** — Import secrets from 1Password.

```typescript
await signet.import1PasswordSecrets({
  vault: "Private",
  items: [
    { item: "API Keys", field: "OpenAI", secret_name: "OPENAI_API_KEY" },
    { item: "API Keys", field: "Anthropic", secret_name: "ANTHROPIC_API_KEY" },
  ],
});
```


Skills Marketplace
---

Browse, install, and manage agent skills from skills.sh.

**`listSkills()`** — List installed skills.

```typescript
const skills = await signet.listSkills();
// skills[n].name — skill name
// skills[n].version — installed version
// skills[n].description — skill description
// skills[n].source — installation source (local | registry)
```

**`browseSkills(opts?)`** — Browse available skills from marketplace.

```typescript
const available = await signet.browseSkills({
  category: "development",
  limit: 20,
});
// available[n].name — skill name
// available[n].description — skill description
// available[n].author — skill author
// available[n].downloads — download count
```

**`searchSkills(query)`** — Search for skills by keyword.

```typescript
const results = await signet.searchSkills("git workflow");
// results[n].name — matching skill
// results[n].relevance — search score
```

**`getSkill(name)`** — Get details for a specific skill.

```typescript
const skill = await signet.getSkill("git-workflow");
// skill.name — skill name
// skill.readme — full documentation
// skill.examples — usage examples
// skill.dependencies — required dependencies
```

**`installSkill(opts)`** — Install a skill from marketplace or URL.

```typescript
await signet.installSkill({
  name: "code-review",  // From registry
  // OR
  url: "https://github.com/user/custom-skill",  // From git
});
```

**`uninstallSkill(name)`** — Remove an installed skill.

```typescript
await signet.uninstallSkill("old-workflow");
```


Hooks & Synthesis
---

Session lifecycle hooks for context injection and memory extraction.

**Session Lifecycle Hooks**

**`sessionStart(opts)`** — Inject context at session start.

```typescript
await signet.sessionStart({
  project: "/home/user/myapp",
  harness: "claude-code",
  session_key: "sess-abc-123",
});
```

**`userPromptSubmit(opts)`** — Load context before each user prompt.

```typescript
const context = await signet.userPromptSubmit({
  prompt: "How do I implement authentication?",
  project: "/home/user/myapp",
  session_key: "sess-abc-123",
});
// context.memories — relevant memories
// context.documents — relevant documents
// context.custom_instructions — synthesized instructions
```

**`sessionEnd(opts)`** — Extract memories at session end.

```typescript
await signet.sessionEnd({
  session_key: "sess-abc-123",
  project: "/home/user/myapp",
  summary: "Implemented JWT authentication with refresh tokens",
});
```

**Memory Operation Hooks**

**`rememberHook(opts)`** — Save memory via hook (with session context).

```typescript
await signet.rememberHook({
  content: "User prefers functional components over class components",
  type: "preference",
  session_key: "sess-abc-123",
});
```

**`recallHook(opts)`** — Recall via hook (with session context).

```typescript
const results = await signet.recallHook({
  query: "component preferences",
  session_key: "sess-abc-123",
});
```

**Compaction Hooks**

**`preCompaction(opts)`** — Get instructions before context compaction.

```typescript
const instructions = await signet.preCompaction({
  session_key: "sess-abc-123",
  tokens_used: 95000,
  tokens_max: 100000,
});
// instructions.guidance — what to preserve in summary
```

**`compactionComplete(opts)`** — Save compaction summary.

```typescript
await signet.compactionComplete({
  session_key: "sess-abc-123",
  summary: "Discussed React hooks patterns and authentication implementation",
  preserved_memories: ["mem-1", "mem-2"],
});
```

**Synthesis Hooks**

**`getSynthesisConfig()`** — Get MEMORY.md synthesis configuration.

```typescript
const config = await signet.getSynthesisConfig();
// config.enabled — whether synthesis is enabled
// config.frequency — how often to run
```

**`requestSynthesis(opts)`** — Request MEMORY.md synthesis.

```typescript
await signet.requestSynthesis({
  project: "/home/user/myapp",
  reason: "Major architectural decisions made",
});
```

**`completeSynthesis(opts)`** — Save synthesized MEMORY.md.

```typescript
await signet.completeSynthesis({
  project: "/home/user/myapp",
  content: "# Project Memory\n\n...",
  session_key: "sess-abc-123",
});
```


Connectors
---

Manage external data source connectors (filesystem, APIs, databases).

**`listConnectors()`** — List all registered connectors.

```typescript
const connectors = await signet.listConnectors();
// connectors[n].id — connector identifier
// connectors[n].provider — connector type (filesystem, github, etc.)
// connectors[n].status — "active" | "error" | "paused"
// connectors[n].last_sync — last successful sync time
```

**`createConnector(opts)`** — Register a new connector.

```typescript
const connector = await signet.createConnector({
  provider: "filesystem",
  config: {
    path: "/home/user/notes",
    file_patterns: ["*.md", "*.txt"],
  },
  sync_interval: 300,  // Sync every 5 minutes
});
// connector.id — assigned connector ID
```

**`getConnector(id)`** — Get connector details.

```typescript
const connector = await signet.getConnector("conn-abc-123");
console.log(connector.status, connector.last_sync);
```

**`syncConnector(id)`** — Trigger incremental sync.

```typescript
await signet.syncConnector("conn-abc-123");
// Syncs only new/changed files since last sync
```

**`fullSyncConnector(id)`** — Trigger full re-sync.

```typescript
await signet.fullSyncConnector("conn-abc-123");
// Re-ingests all files (useful after config changes)
```

**`deleteConnector(id)`** — Delete a connector.

```typescript
await signet.deleteConnector("conn-abc-123");
```

**`checkConnectorHealth(id)`** — Check connector health status.

```typescript
const health = await signet.checkConnectorHealth("conn-abc-123");
// health.status — "healthy" | "degraded" | "failed"
// health.last_error — recent error message (if any)
// health.metrics — connector-specific metrics
```


Analytics & Telemetry
---

Query usage analytics and performance metrics.

**`getTelemetryEvents(opts?)`** — Query telemetry events.

```typescript
const events = await signet.getTelemetryEvents({
  event: "llm.generate",
  since: "2025-01-01T00:00:00Z",
  limit: 100,
});
// events.enabled — false when telemetry is disabled
// events.events — event list
```

**`getTelemetryStats(opts?)`** — Get aggregated telemetry stats.

```typescript
const stats = await signet.getTelemetryStats({ since: "2025-01-01T00:00:00Z" });
if (stats.enabled) {
  console.log(stats.llm.calls, stats.pipelineErrors);
}
```

**`exportTelemetry(opts?)`** — Export telemetry as NDJSON text.

```typescript
const ndjson = await signet.exportTelemetry({ limit: 1000 });
// ndjson — raw newline-delimited JSON string
```

**`getUsageAnalytics()`** — Get usage counters.

```typescript
const usage = await signet.getUsageAnalytics();
// usage.memories_created — total memories created
// usage.memories_recalled — recall operations performed
// usage.documents_ingested — documents processed
// usage.queries_total — total queries made
```

**`getErrorAnalytics()`** — Get recent error events.

```typescript
const errors = await signet.getErrorAnalytics({
  since: "2025-01-01T00:00:00Z",
  limit: 100,
});
// errors[n].timestamp — when error occurred
// errors[n].operation — which operation failed
// errors[n].error — error message
// errors[n].stack — stack trace (if available)
```

**`getLatencyAnalytics()`** — Get latency histograms.

```typescript
const latency = await signet.getLatencyAnalytics();
// latency.embedding_ms — embedding latency stats
// latency.recall_ms — recall latency stats
// latency.extraction_ms — extraction latency stats
```

**`getLogAnalytics()`** — Get structured log entries.

```typescript
const logs = await signet.getLogAnalytics({
  level: "warn",
  since: "2025-01-01T00:00:00Z",
  limit: 50,
});
// logs[n].timestamp — log timestamp
// logs[n].level — log level
// logs[n].message — log message
// logs[n].metadata — structured metadata
```

**`getMemorySafetyAnalytics()`** — Get mutation diagnostics.

```typescript
const safety = await signet.getMemorySafetyAnalytics();
// safety.mutations_total — total mutation operations
// safety.mutations_blocked — blocked mutations (frozen mode, etc.)
// safety.conflicts_detected — concurrent modification conflicts
```

**`getContinuityAnalytics()`** — Get session continuity scores over time.

```typescript
const continuity = await signet.getContinuityAnalytics({
  since: "2025-01-01T00:00:00Z",
});
// continuity[n].timestamp — measurement time
// continuity[n].project — project path
// continuity[n].score — continuity score (0-1)
// continuity[n].memories_injected — context size
```

**`getLatestContinuity()`** — Get latest continuity score per project.

```typescript
const latest = await signet.getLatestContinuity();
// latest[n].project — project path
// latest[n].score — latest continuity score
// latest[n].timestamp — when measured
```


Knowledge Graph
---

Query the knowledge graph (entities, aspects, attributes).

**`listEntities()`** — List knowledge entities.

```typescript
const entities = await signet.listEntities({
  limit: 50,
  type: "person",  // Optional: filter by entity type
});
// entities[n].id — entity identifier
// entities[n].name — entity name
// entities[n].type — entity type
// entities[n].mention_count — number of times mentioned
```

**`getEntity(id)`** — Get entity details.

```typescript
const entity = await signet.getEntity("ent-abc-123");
// entity.id — entity identifier
// entity.name — entity name
// entity.type — entity type
// entity.created_at — when entity was created
// entity.metadata — entity-specific metadata
```

**`pinEntity(id)`** — Pin an entity (keep in working context).

```typescript
await signet.pinEntity("ent-abc-123");
```

**`unpinEntity(id)`** — Unpin an entity.

```typescript
await signet.unpinEntity("ent-abc-123");
```

**`listPinnedEntities()`** — List all pinned entities.

```typescript
const pinned = await signet.listPinnedEntities();
// pinned[n].id — entity ID
// pinned[n].name — entity name
// pinned[n].pinned_at — when pinned
```

**`getEntityHealth()`** — Get entity graph health metrics.

```typescript
const health = await signet.getEntityHealth();
// health.total_entities — total entity count
// health.singleton_entities — entities with single mention
// health.orphaned_entities — entities with no relationships
// health.avg_mentions — average mentions per entity
```

**`getEntityAspects(id)`** — Get aspects for an entity.

```typescript
const aspects = await signet.getEntityAspects("ent-abc-123");
// aspects[n].id — aspect identifier
// aspects[n].name — aspect name
// aspects[n].mention_count — times this aspect mentioned
```

**`getEntityAttributes(entityId, aspectId)`** — Get attributes for an aspect.

```typescript
const attrs = await signet.getEntityAttributes("ent-abc", "asp-xyz");
// attrs[n].key — attribute key
// attrs[n].value — attribute value
// attrs[n].confidence — confidence score
```

**`getEntityDependencies(id)`** — Get entity dependency graph.

```typescript
const deps = await signet.getEntityDependencies("ent-abc-123");
// deps.related — related entities
// deps.depends_on — entities this depends on
// deps.depended_by — entities depending on this
```

**`getKnowledgeStats()`** — Get knowledge graph statistics.

```typescript
const stats = await signet.getKnowledgeStats();
// stats.total_entities — entity count
// stats.total_aspects — aspect count
// stats.total_attributes — attribute count
// stats.total_mentions — mention count
```

**`getTraversalStatus()`** — Get graph traversal cache status.

```typescript
const status = await signet.getTraversalStatus();
// status.last_update — when cache was last updated
// status.cache_size — cache size in bytes
// status.hit_rate — cache hit rate
```

**`getConstellation()`** — Get constellation visualization data.

```typescript
const constellation = await signet.getConstellation({
  dimensions: 2,  // 2D or 3D projection
  limit: 100,  // Max entities to include
});
// constellation.nodes — entity nodes
// constellation.edges — relationship edges
// constellation.positions — UMAP positions
```


Repair & Maintenance
---

Repair actions for broken state and maintenance operations.

**`requeueDeadJobs()`** — Requeue dead-letter jobs.

```typescript
const result = await signet.requeueDeadJobs();
// result.requeued — number of jobs requeued
// result.failed — jobs that couldn't be requeued
```

**`releaseStaleLeases()`** — Release stale job leases.

```typescript
const result = await signet.releaseStaleLeases();
// result.released — number of leases released
```

**`checkFtsConsistency()`** — Check/repair FTS consistency.

```typescript
const result = await signet.checkFtsConsistency();
// result.inconsistencies — found inconsistencies
// result.repaired — whether repairs were made
```

**`triggerRetentionSweep()`** — Trigger retention policy sweep.

```typescript
await signet.triggerRetentionSweep();
// Removes memories past retention period
```

**`getEmbeddingGaps()`** — Count unembedded memories.

```typescript
const gaps = await signet.getEmbeddingGaps();
// gaps.total — total memories without embeddings
// gaps.by_type — breakdown by memory type
```

**`reembedMissing()`** — Re-embed memories without vectors.

```typescript
const result = await signet.reembedMissing({
  batch_size: 100,
});
// result.processed — memories re-embedded
// result.failed — failures
```

**`resyncVectorIndex()`** — Resync entire vector index.

```typescript
await signet.resyncVectorIndex();
// Rebuilds vector index from scratch
```

**`cleanOrphanedEmbeddings()`** — Remove orphaned embeddings.

```typescript
const result = await signet.cleanOrphanedEmbeddings();
// result.removed — orphaned embeddings deleted
```

**`getDedupStats()`** — Get deduplication statistics.

```typescript
const stats = await signet.getDedupStats();
// stats.duplicates_found — duplicate groups detected
// stats.space_saved — bytes saved by deduplication
```

**`deduplicateMemories()`** — Deduplicate memories.

```typescript
const result = await signet.deduplicateMemories({
  min_similarity: 0.95,
  mode: "execute",  // "preview" | "execute"
});
// result.duplicates_found — duplicates detected
// result.merged — memories merged (execute mode)
```

**`reclassifyEntities()`** — Re-classify entities with updated rules.

```typescript
const result = await signet.reclassifyEntities();
// result.reclassified — entities updated
// result.removed — invalid entities removed
```

**`pruneChunkGroups()`** — Prune chunk_group entities.

```typescript
const result = await signet.pruneChunkGroups();
// result.pruned — chunk groups removed
```

**`pruneSingletonEntities()`** — Prune singleton extracted entities.

```typescript
const result = await signet.pruneSingletonEntities();
// result.pruned — singleton entities removed
```

**`structuralBackfill()`** — Backfill missing relational data.

```typescript
const result = await signet.structuralBackfill();
// result.backfilled — records updated
```


Cross-Agent Messaging
---

Presence and messaging for multi-agent coordination.

**`listPresence()`** — List active agent sessions.

```typescript
const presence = await signet.listPresence();
// presence[n].agent_id — agent identifier
// presence[n].session_key — session key
// presence[n].project — current project
// presence[n].last_seen — last activity timestamp
```

**`updatePresence(opts)`** — Update agent presence.

```typescript
await signet.updatePresence({
  agent_id: "agent-abc",
  session_key: "sess-123",
  project: "/home/user/myapp",
});
```

**`removePresence(sessionKey)`** — Remove agent presence.

```typescript
await signet.removePresence("sess-123");
```

**`listMessages(opts)`** — List cross-agent messages.

```typescript
const messages = await signet.listMessages({
  agent_id: "agent-abc",
  limit: 20,
  include_sent: true,
});
// messages[n].from_agent_id — sender
// messages[n].to_agent_id — recipient
// messages[n].type — message type
// messages[n].content — message content
// messages[n].timestamp — when sent
```

**`sendMessage(opts)`** — Send message to another agent.

```typescript
await signet.sendMessage({
  from_agent_id: "agent-abc",
  to_agent_id: "agent-xyz",
  type: "question",
  content: "Have you seen the latest architecture decisions?",
});
```

**`streamEvents()`** — SSE stream of cross-agent events.

```typescript
const stream = await signet.streamEvents();
stream.onmessage = (event) => {
  const msg = JSON.parse(event.data);
  console.log(`[${msg.type}] ${msg.from_agent_id}: ${msg.content}`);
};
```


Predictor Training
---

Train and query the predictive memory scorer.

**`getPredictorStatus()`** — Get predictor status.

```typescript
const status = await signet.getPredictorStatus();
// status.enabled — whether predictor is enabled
// status.model_loaded — whether model is loaded
// status.training_runs — number of training runs
// status.last_training — last training timestamp
```

**`getPredictorComparisons()`** — Get recent comparisons.

```typescript
const comparisons = await signet.getPredictorComparisons({
  limit: 50,
});
// comparisons[n].entity_id — entity compared
// comparisons[n].baseline_score — baseline relevance
// comparisons[n].predictor_score — predicted relevance
// comparisons[n].actual_relevance — ground truth
```

**`getComparisonsByProject(project)`** — Get comparisons for a project.

```typescript
const comparisons = await signet.getComparisonsByProject("/home/user/myapp");
```

**`getComparisonsByEntity(entityId)`** — Get comparisons for an entity.

```typescript
const comparisons = await signet.getComparisonsByEntity("ent-abc-123");
```

**`listTrainingRuns()`** — List training runs.

```typescript
const runs = await signet.listTrainingRuns();
// runs[n].id — run identifier
// runs[n].timestamp — when run occurred
// runs[n].epochs — number of epochs
// runs[n].final_loss — training loss
// runs[n].accuracy — validation accuracy
```

**`getTrainingPairsCount()`** — Count available training pairs.

```typescript
const count = await signet.getTrainingPairsCount();
// count.total — total training pairs
// count.positive — positive examples
// count.negative — negative examples
```

**`trainPredictor(opts)`** — Trigger training run.

```typescript
const run = await signet.trainPredictor({
  epochs: 10,
  learning_rate: 0.001,
  batch_size: 32,
});
// run.id — training run ID
// run.status — "running" | "completed" | "failed"
```

**`exportTrainingTelemetry()`** — Export training telemetry.

```typescript
const data = await signet.exportTrainingTelemetry({
  since: "2025-01-01T00:00:00Z",
});
// data — NDJSON telemetry events
```


Timeline Export
---

Export entity event timelines.

**`getTimeline(id)`** — Get entity timeline.

```typescript
const events = await signet.getTimeline("ent-abc-123");
// events[n].timestamp — event timestamp
// events[n].event_type — event type
// events[n].description — event description
// events[n].metadata — event metadata
```

**`exportTimeline(id)`** — Export timeline with metadata.

```typescript
const exported = await signet.exportTimeline("ent-abc-123", {
  format: "json",  // "json" | "csv"
  include_metadata: true,
});
// exported.data — exported timeline data
// exported.format — export format
// exported.generated_at — export timestamp
```


Pipeline & Diagnostics
---

Monitor pipeline status and system diagnostics.

**`getPipelineStatus()`** — Get pipeline worker status.

```typescript
const status = await signet.getPipelineStatus();
// status.extraction — extraction worker status
// status.ingestion — document ingestion status
// status.graph — knowledge graph status
// status.retention — retention worker status
// status.jobs_pending — pending job count
```

**`getDiagnostics(domain?)`** — Get health diagnostics.

```typescript
const all = await signet.getDiagnostics();
// all.overall_score — overall health score (0-100)
// all.domains — per-domain breakdown

const embeddings = await signet.getDiagnostics("embeddings");
// embeddings.score — embeddings health score
// embeddings.issues — detected issues
// embeddings.recommendations — repair recommendations
```


Config & Identity
---

Read and write daemon configuration and identity files.

**`getConfig()`** — Read daemon configuration.

```typescript
const config = await signet.getConfig();
// config — parsed agent.yaml contents
```

**`setConfig(opts)`** — Write daemon configuration.

```typescript
await signet.setConfig({
  content: yaml.stringify(newConfig),
  reason: "Updated embedding model",
});
```

**`getIdentity()`** — Read identity files.

```typescript
const identity = await signet.getIdentity({
  files: ["AGENTS.md", "USER.md"],
});
// identity.AGENTS.md — file contents
// identity.USER.md — file contents
```


Embeddings
---

Monitor embedding status and health.

**`getEmbeddingStatus()`** — Get embedding processing status.

```typescript
const status = await signet.getEmbeddingStatus();
// status.provider — "native" | "ollama" | "openai" | "none"
// status.model — embedding model name
// status.available — provider availability
// status.base_url — provider URL
// status.checkedAt — last check timestamp
```

**`getEmbeddingHealth()`** — Get embedding health metrics.

```typescript
const health = await signet.getEmbeddingHealth();
// health.totalMemories — total memories
// health.embeddedCount — memories with vectors
// health.unembeddedCount — memories missing vectors
// health.coveragePercent — embedding coverage
```

**`getEmbeddingProjection(opts)`** — Get UMAP projection for visualization.

```typescript
const projection = await signet.getEmbeddingProjection({
  dimensions: 2,  // 2D or 3D
});
if (projection.status === "ready") {
  // projection.nodes[n].id — memory ID
  // projection.nodes[n].x, .y, .z — coordinates
  // projection.edges — graph edges
}
// projection.status may also be "computing" or "error"
```


Helper Methods
---

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
  const { results } = await signet.recallOrThrow("user preferences", {
    type: "preference",
    limit: 5,
  });
  // Guaranteed to have at least one result
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


Error Handling
---

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


TypeScript Support
---

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


Migration Guide
---

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

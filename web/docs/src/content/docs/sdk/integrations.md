---
title: "SDK integrations"
description: "Integrate Signet with React, Vercel AI SDK, OpenAI SDK, connectors, and hooks."
---

## React Hooks

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
  aggregate: true,
  aggregateBudget: "small",
});
```

**`useMemory(id)`** — Fetch a single memory by ID reactively. Returns
`{ data, loading, error }`. Pass `null` to suppress.

```tsx
const { data: memory, error } = useMemory(selectedId);
```

Both hooks clean up in-flight requests on unmount via `AbortController`.

## Vercel AI SDK Integration

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
The `memory_search` tool accepts `aggregate`, `aggregateBudget`, and
`saveAggregate` for explicit aggregate recall.

**`getMemoryContext(client, userMessage, opts?)`** — Convenience helper
that runs a recall search and formats the results as a markdown string
suitable for injecting into a system prompt.

```typescript
import { getMemoryContext } from "@signet/sdk/ai-sdk";

const context = await getMemoryContext(signet, userMessage, {
  limit: 5,
  minScore: 0.3,
});
// Returns "" if no results survive score filtering,
// or "## Relevant Memories\n- ..." otherwise
```

## OpenAI SDK Integration

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

## Hooks & Synthesis

Session lifecycle hooks for context injection and memory extraction.

**Session Lifecycle Hooks**

**`sessionStart(opts)`** — Inject context at session start.

```typescript
await signet.sessionStart({
  project: "/home/user/myapp",
  harness: "claude-code",
  sessionKey: "sess-abc-123",
});
```

**`userPromptSubmit(opts)`** — Load context before each user prompt.

```typescript
const context = await signet.userPromptSubmit({
  prompt: "How do I implement authentication?",
  project: "/home/user/myapp",
  sessionKey: "sess-abc-123",
});
// context.context — injected prompt context
```

**`sessionEnd(opts)`** — Extract memories at session end.

```typescript
await signet.sessionEnd({
  sessionKey: "sess-abc-123",
  project: "/home/user/myapp",
  summary: "Implemented JWT authentication with refresh tokens",
});
```

**Memory Operation Hooks**

**`hookRemember(opts)`** — Save memory via hook (with session context).

```typescript
await signet.hookRemember({
  content: "User prefers functional components over class components",
  type: "preference",
  sessionKey: "sess-abc-123",
  runtimePath: "plugin",
});
```

`rememberHook(opts)` remains available as a deprecated compatibility alias.

**`hookRecall(opts)`** — Recall via hook (with session context).

```typescript
const result = await signet.hookRecall({
  query: "component preferences",
  project: "/home/user/myapp",
  type: "preference",
  tags: "ui,components",
  since: "2026-01-01T00:00:00Z",
  sessionKey: "sess-abc-123",
  runtimePath: "plugin",
});
// result.results — recall rows
// result.memories — deprecated alias of result.results
// result.count — deprecated alias of result.results.length
// result.meta.noHits — true when recall succeeded but found nothing
// result.bypassed — true when the session is bypassed
// result.internal — true for no-hook internal calls
```

`recallHook(opts)` remains available as a deprecated compatibility alias.

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

## Connectors

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

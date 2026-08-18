---
title: "SDK integrations"
description: "Use React, AI SDK, OpenAI, lifecycle hooks, and connectors through the current SDK surface."
---

## React

`@signet/sdk/react` provides `SignetProvider`, `useSignet`, `useMemorySearch`, and `useMemory`.

```tsx
import { SignetProvider, useMemorySearch } from "@signet/sdk/react";

function Preferences() {
  const { data, loading, error } = useMemorySearch("user preferences", {
    limit: 5,
    type: "preference",
  });
  if (loading) return <p>Loading…</p>;
  if (error) return <p>{error.message}</p>;
  return <ul>{data?.map((memory) => <li key={memory.id}>{memory.content}</li>)}</ul>;
}

export function App() {
  return <SignetProvider config={{ daemonUrl: "http://localhost:3850" }}><Preferences /></SignetProvider>;
}
```

`useMemorySearch(null)` and `useMemory(null)` suppress their request. `SignetProvider` checks `health()` on mount and exposes `connected` and `error` through `useSignet()`.

## Vercel AI SDK and OpenAI tools

The SDK exports four memory tools: `memory_search`, `memory_store`, `memory_modify`, and `memory_forget`.

```typescript
import { SignetClient } from "@signet/sdk";
import { memoryTools } from "@signet/sdk/ai-sdk";
import { generateText } from "ai";

const client = new SignetClient();
const result = await generateText({ model, tools: await memoryTools(client), prompt: "Find relevant preferences." });
```

For OpenAI function calling, use `memoryToolDefinitions()` to construct the tool list and `executeMemoryTool(client, name, parsedArgs)` to dispatch a returned function call. Both adapters use camelCase arguments such as `aggregateBudget`, `sessionKey`, and `agentId` because they call the TypeScript client, not the raw daemon wire schema.

## Lifecycle hooks

The SDK uses camelCase request fields. The daemon may accept compatibility wire aliases, but SDK callers should use the exported TypeScript shape.

```typescript
import { SignetClient } from "@signet/sdk";

const client = new SignetClient();
await client.sessionStart({ sessionKey: "session-123", harness: "my-harness", project: "/workspace/app" });
const context = await client.userPromptSubmit({ sessionKey: "session-123", prompt: "Review the migration", project: "/workspace/app" });
await client.sessionEnd({ sessionKey: "session-123", harness: "my-harness", transcript: "…", project: "/workspace/app" });
await client.preCompaction({ sessionKey: "session-123", context: "Current session summary", project: "/workspace/app" });
await client.compactionComplete({ sessionKey: "session-123", summary: "Compacted summary", project: "/workspace/app" });
await client.requestSynthesis({ project: "/workspace/app" });
```

`sessionEnd` requires `sessionKey` and `harness`; it does not take a `summary` field. Synthesis is Dreaming-owned and manifest-gated; callers request a run with `requestSynthesis` and must not submit generated MEMORY.md content.

## Connectors

```typescript
const created = await client.createConnector({
  provider: "filesystem",
  displayName: "Project notes",
  settings: { rootPath: "/workspace/notes" },
});

await client.syncConnector(created.id);
const health = await client.getConnectorHealth(created.id);
```

Supported `createConnector` providers are `filesystem`, `github-docs`, and `gdrive`. Use `settings`, not retired `config`, and use `getConnectorHealth`, not `checkConnectorHealth`.

---
title: "SDK integrations"
description: "React, Vercel AI SDK, and OpenAI adapter contracts."
---

`@signet/sdk/react` exports `SignetProvider`, `useSignet`, `useMemorySearch`, and `useMemory`. The provider accepts `client` or `config`, calls `health()` on mount, and exposes `{ client, connected, error }`. Hooks return `{ data, loading, error }`; null/empty query or ID suppresses a request.

```tsx
<SignetProvider config={{ daemonUrl: "http://localhost:3850" }}><App /></SignetProvider>
```

`memoryTools(client)` from `@signet/sdk/ai-sdk` is async (it loads `zod`) and returns `memory_search`, `memory_store`, `memory_modify`, and `memory_forget`. Search supports `query`, `limit`, `type`, `aggregate`, `aggregateBudget`, `saveAggregate`, `sessionKey`, `agentId`, and `includeRecalled`. `getMemoryContext(client, message, options)` returns Markdown context or an empty string.

`memoryToolDefinitions()` from `@signet/sdk/openai` returns four OpenAI function definitions. Dispatch parsed calls with `executeMemoryTool(client, name, args)`. It validates required values and `aggregateBudget` (`small`, `medium`, `large`). Unknown tools throw `SignetError`. Both adapters use camelCase SDK arguments, not raw wire aliases.

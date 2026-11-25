---
title: "SDK"
description: "Typed TypeScript client for the Signet daemon."
---

`@signet/sdk` is the typed HTTP client for the Signet daemon. Its core entry is browser-safe and does not import Node or the core barrel. The Node entry adds target resolution, credential storage, refresh, and durable delivery:

| Import | Surface |
|---|---|
| `@signet/sdk` | `SignetClient`, errors, and public types |
| `@signet/sdk/node` | `resolveTarget`, `NodeTransport`, `createNodeClient`, registry, login store, and outbox |
| `@signet/sdk/react` | React provider and memory hooks |
| `@signet/sdk/ai-sdk` | Vercel AI SDK adapters |
| `@signet/sdk/openai` | OpenAI function-tool adapters |

```bash
bun add @signet/sdk
# or
npm install @signet/sdk
```

## In this section

- [SDK quickstart](/sdk/getting-started/): construct the client and make a first memory call.
- [Core client](/sdk/core-client/): memory operations, auth, and queued secret execution.
- [SDK integrations](/sdk/integrations/): React, AI SDK, OpenAI, lifecycle hooks, and connectors.
- [Operations SDK](/sdk/operations/): plugins, skills, telemetry, repair, configuration, and embeddings.
- [Knowledge and agents](/sdk/knowledge-agents/): knowledge graph and cross-agent coordination.
- [Helpers, types, and migration](/sdk/types-migration/): supported helpers, exported types, errors, and version guidance.

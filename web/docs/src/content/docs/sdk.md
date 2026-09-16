---
title: "SDK"
description: "Typed TypeScript HTTP client for the Signet daemon."
---

`@signet/sdk` is a typed HTTP client for a running Signet daemon. It is transport-only and does not open SQLite. `@signet/core` owns shared core contracts and recall helpers; it is not the daemon client, and the packages are not interchangeable.

## Install

```bash
bun add @signet/sdk
```

## Public entry points

| Import | Contract |
|---|---|
| `@signet/sdk` | `SignetClient`, errors, transport type, and public types |
| `@signet/sdk/react` | `SignetProvider`, `useSignet`, `useMemorySearch`, `useMemory` |
| `@signet/sdk/ai-sdk` | Vercel AI SDK memory tools and context helper |
| `@signet/sdk/openai` | OpenAI function-tool definitions and dispatcher |

## Reference

- [Getting started](/sdk/getting-started/)
- [Core client](/sdk/core-client/)
- [Knowledge and agents](/sdk/knowledge-agents/)
- [Integrations](/sdk/integrations/)
- [Operations](/sdk/operations/)
- [Helpers, types, and migration](/sdk/types-migration/)

Generated declarations shipped with each release are the complete type reference. Import client classes, errors, and SDK response/input types from `@signet/sdk`; import core-only contracts from `@signet/core`.

---
title: "SDK"
description: "Typed TypeScript HTTP client for the Signet daemon."
---

`@signet/sdk` is a typed HTTP client for a running Signet daemon. It is transport-only and does not open SQLite. `@signet/core` owns shared core contracts and recall helpers; it is not the daemon client, and the packages are not interchangeable.

## Workspace development

`@signet/sdk` is currently a workspace-only package. It is not included in the
release workflow and is not published to npm, so do not use `npm install` or
`bun add` for a public application. In this repository, use the workspace
package and build it with `bun run --filter '@signet/sdk' build`.

The React and adapter entry points have optional peer dependencies. Install
`react` (18 or newer) when using `@signet/sdk/react`, and `zod` (3 or newer)
when using `@signet/sdk/ai-sdk` (the adapter loads it when `memoryTools()` is
called). `@signet/sdk/openai` has no adapter-specific peer dependency. The
workspace manifest currently uses version `0.226.6` for source development;
that is not a public SDK release or an installable registry version.

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

---
title: "SDK"
description: "Integration SDK for third-party applications."
---

Integration SDK for third-party applications.

`@signet/sdk` is a typed TypeScript HTTP client for the Signet [Daemon](/daemon/)
[API](/api/). It has no native dependencies — no SQLite, no `@signet/core` —
making it suitable for embedding in any Node.js, Bun, or browser environment
that can reach the daemon over HTTP.

Install with:

```bash
bun add @signet/sdk
# or
npm install @signet/sdk
```

## In this section

- [SDK quickstart](/sdk/getting-started/)
  Install, configure, and make the first typed Signet SDK calls.
- [Core client](/sdk/core-client/)
  Use client methods, jobs, sessions, scheduling, Git, secrets, and typed errors.
- [SDK integrations](/sdk/integrations/)
  Integrate Signet with React, Vercel AI SDK, OpenAI SDK, connectors, and hooks.
- [Operations SDK](/sdk/operations/)
  Use plugin diagnostics, skills, analytics, repair, pipeline, config, and embedding APIs.
- [Knowledge and agents](/sdk/knowledge-agents/)
  Use knowledge graph, cross-agent messaging, predictor, and timeline APIs.
- [Helpers, types, and migration](/sdk/types-migration/)
  Use helper methods, TypeScript types, error contracts, and migration guidance.

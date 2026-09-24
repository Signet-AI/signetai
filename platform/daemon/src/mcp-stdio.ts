#!/usr/bin/env node

export {};

// Keep the runtime behind a dynamic import. Bun's Node-targeted bundler can
// otherwise evaluate the MCP SDK's Zod schemas before Zod's cyclic exports
// have initialized, yielding `Class2 is not a constructor` under Node.
const { runMcpStdio } = await import("./mcp-stdio-runtime.js");
await runMcpStdio();

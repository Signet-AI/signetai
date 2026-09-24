#!/usr/bin/env node

export {};

// The MCP handshake may remain available when the optional tokenizer asset is
// absent; ordinary daemon startup must still fail closed on that dependency.
process.env.SIGNET_MCP_STDIO = "1";

// Keep the runtime behind a dynamic import. Bun's Node-targeted bundler can
// otherwise evaluate the MCP SDK's Zod schemas before Zod's cyclic exports
// have initialized, yielding `Class2 is not a constructor` under Node.
const { runMcpStdio } = await import("./mcp-stdio-runtime.js");
await runMcpStdio();

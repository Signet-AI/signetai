#!/usr/bin/env node

import { z } from "zod";
import { runMcpStdio } from "./mcp-stdio-runtime.js";

// Keep Zod's bundled module initializer ahead of the MCP SDK's schema module.
// Bun's Node-target bundle otherwise evaluates that module before Zod's lazy
// exports are initialized, so `custom()` fails before the handshake.
void z.object({});

await runMcpStdio();

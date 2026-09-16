#!/usr/bin/env node
/**
 * Signet MCP Server — stdio transport
 *
 * Standalone entry point that exposes Signet memory tools over stdin/stdout.
 * Designed to be spawned as a subprocess by AI harnesses (Claude Code, OpenCode).
 *
 * The daemon must be running — tool handlers call the daemon's HTTP API.
 */

import { z } from "zod";
import { runMcpStdio } from "./mcp-stdio-runtime.js";

// Keep Zod's bundled module initializer ahead of the MCP SDK's schema module.
// Bun's Node-target bundle otherwise evaluates that module before Zod's lazy
// exports are initialized, so `custom()` fails before the handshake.
void z.object({});

await runMcpStdio();

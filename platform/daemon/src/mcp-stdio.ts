#!/usr/bin/env node
/**
 * Signet MCP Server — stdio transport
 *
 * Standalone entry point that exposes Signet memory tools over stdin/stdout.
 * Designed to be spawned as a subprocess by AI harnesses (Claude Code, OpenCode).
 *
 * The daemon must be running — tool handlers call the daemon's HTTP API.
 */
import { runMcpStdio } from "./mcp-stdio-runtime.js";

await runMcpStdio();

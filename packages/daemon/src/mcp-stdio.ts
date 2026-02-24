#!/usr/bin/env node
/**
 * Signet MCP Server — stdio transport
 *
 * Standalone entry point that exposes Signet memory tools over stdin/stdout.
 * Designed to be spawned as a subprocess by AI harnesses (Claude Code, OpenCode).
 *
 * The daemon must be running — tool handlers call the daemon's HTTP API.
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createMcpServer } from "./mcp/tools.js";

const DAEMON_URL = process.env.SIGNET_DAEMON_URL
	?? `http://${process.env.SIGNET_HOST ?? "localhost"}:${process.env.SIGNET_PORT ?? "3850"}`;

const server = createMcpServer({
	daemonUrl: DAEMON_URL,
	version: "0.1.0",
});

const transport = new StdioServerTransport();
await server.connect(transport);

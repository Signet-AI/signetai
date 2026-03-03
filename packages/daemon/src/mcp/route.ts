/**
 * MCP Streamable HTTP route for the Signet daemon.
 *
 * Mounts a /mcp endpoint on the Hono app that serves MCP tool calls
 * using the web-standard Streamable HTTP transport. Stateless mode —
 * each request gets a fresh server + transport instance.
 */

import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { Hono } from "hono";
import { createMcpServer } from "./tools.js";

export function mountMcpRoute(app: Hono): void {
	// POST /mcp — main MCP message endpoint
	// GET /mcp — SSE stream for server-initiated notifications
	// DELETE /mcp — session termination
	app.all("/mcp", async (c) => {
		const transport = new WebStandardStreamableHTTPServerTransport({
			sessionIdGenerator: undefined, // stateless
			enableJsonResponse: true,
		});

		const harness = c.req.query("harness") ?? c.req.header("x-signet-harness") ?? undefined;
		const workspace = c.req.query("workspace") ?? c.req.header("x-signet-workspace") ?? undefined;
		const channel = c.req.query("channel") ?? c.req.header("x-signet-channel") ?? undefined;

		const server = await createMcpServer({
			context: {
				harness,
				workspace,
				channel,
			},
		});
		await server.connect(transport);

		try {
			const response = await transport.handleRequest(c.req.raw);
			return response;
		} finally {
			await transport.close();
			await server.close();
		}
	});
}

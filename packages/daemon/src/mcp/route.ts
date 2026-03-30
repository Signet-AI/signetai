/**
 * MCP Streamable HTTP route for the Signet daemon.
 *
 * Mounts a /mcp endpoint on the Hono app that serves MCP tool calls
 * using the web-standard Streamable HTTP transport. Stateless mode —
 * each request gets a fresh server + transport instance.
 *
 * Proxy tools from installed MCP servers are included when the shared
 * proxy runtime is initialized (see mcp/proxy-runtime.ts). Tool lists
 * are pre-cached at init time so registration here stays synchronous.
 */

import type { Hono } from "hono";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { createMcpServer } from "./tools.js";
import { getProxyRuntime, getProxyToolCache } from "./proxy-runtime.js";

export function mountMcpRoute(app: Hono): void {
	// POST /mcp — main MCP message endpoint
	// GET /mcp — SSE stream for server-initiated notifications
	// DELETE /mcp — session termination
	app.all("/mcp", async (c) => {
		const transport = new WebStandardStreamableHTTPServerTransport({
			sessionIdGenerator: undefined, // stateless
			enableJsonResponse: true,
		});

		const proxyRuntime = getProxyRuntime() ?? undefined;
		const proxyToolCache = proxyRuntime !== undefined ? getProxyToolCache() : undefined;
		const server = createMcpServer({ proxyRuntime, proxyToolCache });
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

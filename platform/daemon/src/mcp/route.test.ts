import { describe, expect, it } from "bun:test";
import { Hono } from "hono";
import { mountMcpRoute } from "./route.js";

function makeApp(): Hono {
	const app = new Hono();
	mountMcpRoute(app);
	return app;
}

const streamableHeaders = {
	Accept: "application/json, text/event-stream",
	"Content-Type": "application/json",
};

describe("MCP route", () => {
	it("passes parsed Bun/Hono JSON bodies to the streamable HTTP transport", async () => {
		const res = await makeApp().request("/mcp", {
			method: "POST",
			headers: streamableHeaders,
			body: JSON.stringify({
				jsonrpc: "2.0",
				id: 1,
				method: "initialize",
				params: {
					protocolVersion: "2024-11-05",
					capabilities: {},
					clientInfo: { name: "route-test", version: "0.1.0" },
				},
			}),
		});

		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.result.serverInfo.name).toBe("signet");
	});

	it("returns the SDK parse-error shape for malformed JSON", async () => {
		const res = await makeApp().request("/mcp", {
			method: "POST",
			headers: streamableHeaders,
			body: "{",
		});

		expect(res.status).toBe(400);
		expect(await res.json()).toEqual({
			jsonrpc: "2.0",
			error: { code: -32700, message: "Parse error: Invalid JSON" },
			id: null,
		});
	});
});

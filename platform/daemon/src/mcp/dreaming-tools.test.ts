import { afterEach, describe, expect, it, mock } from "bun:test";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { DREAMING_CAPABILITY_IDS } from "../pipeline/dreaming-capabilities";
import { createDreamingMcpServer } from "./dreaming-tools";

interface RegisteredTool {
	readonly handler: (
		args: Record<string, unknown>,
	) => Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }>;
}

function tools(server: McpServer): Record<string, RegisteredTool> {
	const internal = server as unknown as { readonly _registeredTools?: Record<string, RegisteredTool> };
	if (!internal._registeredTools) throw new Error("MCP server internals unavailable in test");
	return internal._registeredTools;
}

function tool(server: McpServer, name: string): RegisteredTool {
	const registered = tools(server)[name];
	if (!registered) throw new Error(`Missing registered tool: ${name}`);
	return registered;
}

function mockFetch(capture: { url?: string; method?: string; body?: string }): void {
	globalThis.fetch = mock(async (input: string | URL | Request, init?: RequestInit) => {
		capture.url = typeof input === "string" ? input : input.toString();
		capture.method = init?.method ?? "GET";
		capture.body = init?.body as string;
		return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "Content-Type": "application/json" } });
	}) as unknown as typeof fetch;
}

describe("Dreaming MCP tools", () => {
	const originalFetch = globalThis.fetch;

	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	it("exposes only the scoped conceptual Dreaming surface", () => {
		const server = createDreamingMcpServer({
			daemonUrl: "http://localhost:3850",
			agentId: "agent-a",
			passId: "pass-a",
			version: "test",
		});
		expect(Object.keys(tools(server)).sort()).toEqual([...DREAMING_CAPABILITY_IDS].sort());
	});

	it("pins all reads and writes to the configured agent rather than accepting an agent id from the model", async () => {
		const server = createDreamingMcpServer({
			daemonUrl: "http://localhost:3850",
			agentId: "agent-a",
			passId: "pass-a",
			version: "test",
		});
		const capture: { url?: string; method?: string; body?: string } = {};
		mockFetch(capture);

		await tool(server, "search_entities").handler({ query: "Atlas" });
		expect(capture.url).toBe("http://localhost:3850/api/dream/tools/search_entities");
		expect(JSON.parse(capture.body ?? "{}")).toMatchObject({
			agentId: "agent-a",
			passId: "pass-a",
			input: { query: "Atlas" },
		});

		await tool(server, "apply_ontology_ops").handler({
			operations: [{ operation: "create_entity", payload: { name: "Atlas" } }],
		});
		expect(capture.method).toBe("POST");
		expect(capture.url).toBe("http://localhost:3850/api/dream/tools/apply_ontology_ops");
		expect(JSON.parse(capture.body ?? "{}")).toMatchObject({ agentId: "agent-a", actor: "dreaming-acpx" });
	});

	it("preserves a retryable capability response for an ACPX caller", async () => {
		globalThis.fetch = mock(
			async () =>
				new Response(JSON.stringify({ ok: false, retryable: true, retryFrom: 20, error: "writer failed" }), {
					status: 503,
					headers: { "Content-Type": "application/json" },
				}),
		) as unknown as typeof fetch;
		const server = createDreamingMcpServer({ daemonUrl: "http://localhost:3850", agentId: "agent-a", version: "test" });

		const result = await tool(server, "apply_ontology_ops").handler({ operations: [] });

		expect(result.isError).toBe(true);
		expect(result.content[0]?.text).toContain('"retryFrom":20');
	});
});

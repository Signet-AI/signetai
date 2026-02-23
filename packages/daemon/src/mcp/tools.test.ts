/**
 * Tests for MCP tool definitions.
 *
 * Tool handlers call the daemon HTTP API, so we mock global fetch.
 */

import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { createMcpServer } from "./tools.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface RegisteredTool {
	handler: (args: Record<string, unknown>) => Promise<unknown>;
	enabled: boolean;
}

type InternalMcpServer = McpServer & {
	_registeredTools: Record<string, RegisteredTool>;
};

async function callTool(
	server: McpServer,
	name: string,
	args: Record<string, unknown>,
): Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }> {
	const internal = server as unknown as InternalMcpServer;
	const tool = internal._registeredTools[name];
	if (!tool) {
		throw new Error(`Tool ${name} not found`);
	}
	return tool.handler(args) as Promise<{
		content: Array<{ type: string; text: string }>;
		isError?: boolean;
	}>;
}

function getToolNames(server: McpServer): string[] {
	const internal = server as unknown as InternalMcpServer;
	return Object.keys(internal._registeredTools);
}

function mockFetch(
	status: number,
	body: unknown,
	capture?: { url?: string; method?: string; body?: string },
): void {
	globalThis.fetch = mock(
		async (input: string | URL | Request, init?: RequestInit) => {
			if (capture) {
				capture.url = typeof input === "string" ? input : input.toString();
				capture.method = init?.method ?? "GET";
				capture.body = init?.body as string;
			}
			return new Response(JSON.stringify(body), {
				status,
				headers: { "Content-Type": "application/json" },
			});
		},
	) as typeof fetch;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createMcpServer", () => {
	let server: McpServer;
	const originalFetch = globalThis.fetch;

	beforeEach(() => {
		server = createMcpServer({
			daemonUrl: "http://localhost:3850",
			version: "0.0.1-test",
		});
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	it("creates server with correct info", () => {
		expect(server).toBeDefined();
		expect(server.server).toBeDefined();
	});

	it("registers all 6 tools", () => {
		const names = getToolNames(server);
		expect(names).toContain("memory_search");
		expect(names).toContain("memory_store");
		expect(names).toContain("memory_get");
		expect(names).toContain("memory_list");
		expect(names).toContain("memory_modify");
		expect(names).toContain("memory_forget");
		expect(names.length).toBe(6);
	});

	describe("memory_search", () => {
		it("calls recall endpoint with correct params", async () => {
			const cap: { url?: string; body?: string } = {};
			mockFetch(200, { results: [{ id: "1", content: "test", score: 0.9 }] }, cap);

			const result = await callTool(server, "memory_search", {
				query: "test query",
				limit: 5,
			});

			expect(cap.url).toBe("http://localhost:3850/api/memory/recall");
			const body = JSON.parse(cap.body ?? "{}");
			expect(body.query).toBe("test query");
			expect(body.limit).toBe(5);
			expect(result.isError).toBeUndefined();
		});

		it("returns error on fetch failure", async () => {
			mockFetch(500, "Internal Server Error");

			const result = await callTool(server, "memory_search", {
				query: "failing query",
			});

			expect(result.isError).toBe(true);
			expect(result.content[0].text).toContain("Search failed");
		});
	});

	describe("memory_store", () => {
		it("calls remember endpoint", async () => {
			const cap: { body?: string } = {};
			mockFetch(200, { id: "abc-123", deduped: false }, cap);

			const result = await callTool(server, "memory_store", {
				content: "Remember this fact",
				importance: 0.8,
			});

			const body = JSON.parse(cap.body ?? "{}");
			expect(body.content).toBe("Remember this fact");
			expect(body.importance).toBe(0.8);
			expect(result.isError).toBeUndefined();
		});

		it("prepends tags when provided", async () => {
			const cap: { body?: string } = {};
			mockFetch(200, { id: "abc-456" }, cap);

			await callTool(server, "memory_store", {
				content: "tagged memory",
				tags: "foo,bar",
			});

			const body = JSON.parse(cap.body ?? "{}");
			expect(body.content).toBe("[foo,bar]: tagged memory");
		});
	});

	describe("memory_get", () => {
		it("calls GET with correct id", async () => {
			const cap: { url?: string } = {};
			mockFetch(200, { id: "abc", content: "hello" }, cap);

			const result = await callTool(server, "memory_get", { id: "abc" });
			expect(cap.url).toBe("http://localhost:3850/api/memory/abc");
			expect(result.isError).toBeUndefined();
		});
	});

	describe("memory_list", () => {
		it("passes query params correctly", async () => {
			const cap: { url?: string } = {};
			mockFetch(200, { memories: [], total: 0 }, cap);

			await callTool(server, "memory_list", { limit: 10, type: "fact" });
			expect(cap.url).toContain("limit=10");
			expect(cap.url).toContain("type=fact");
		});
	});

	describe("memory_modify", () => {
		it("calls PATCH with correct body", async () => {
			const cap: { method?: string; body?: string } = {};
			mockFetch(200, { status: "updated" }, cap);

			await callTool(server, "memory_modify", {
				id: "abc",
				content: "updated content",
				reason: "fixing typo",
			});

			expect(cap.method).toBe("PATCH");
			const body = JSON.parse(cap.body ?? "{}");
			expect(body.content).toBe("updated content");
			expect(body.reason).toBe("fixing typo");
		});
	});

	describe("memory_forget", () => {
		it("calls DELETE with reason in body", async () => {
			const cap: { method?: string; body?: string } = {};
			mockFetch(200, { status: "forgotten" }, cap);

			await callTool(server, "memory_forget", {
				id: "abc",
				reason: "no longer relevant",
			});

			expect(cap.method).toBe("DELETE");
			const body = JSON.parse(cap.body ?? "{}");
			expect(body.reason).toBe("no longer relevant");
		});

		it("returns error on 503 (mutations frozen)", async () => {
			mockFetch(503, { error: "Mutations are frozen" });

			const result = await callTool(server, "memory_forget", {
				id: "abc",
				reason: "test",
			});

			expect(result.isError).toBe(true);
			expect(result.content[0].text).toContain("Forget failed");
		});
	});
});

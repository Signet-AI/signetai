/**
 * Tests for MCP tool definitions.
 *
 * Tool handlers call the daemon HTTP API, so we mock global fetch.
 */

import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createMcpServer, refreshMarketplaceProxyTools } from "./tools.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface RegisteredTool {
	handler: (args: Record<string, unknown>) => Promise<unknown>;
	enabled: boolean;
}

function getRegisteredTools(server: McpServer): Record<string, RegisteredTool> {
	const internal = server as unknown as {
		readonly _registeredTools?: Record<string, RegisteredTool>;
	};
	if (!internal._registeredTools) {
		throw new Error("MCP server internals unavailable in test");
	}
	return internal._registeredTools;
}

async function callTool(
	server: McpServer,
	name: string,
	args: Record<string, unknown>,
): Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }> {
	const tool = getRegisteredTools(server)[name];
	if (!tool) {
		throw new Error(`Tool ${name} not found`);
	}
	return tool.handler(args) as Promise<{
		content: Array<{ type: string; text: string }>;
		isError?: boolean;
	}>;
}

function getToolNames(server: McpServer): string[] {
	return Object.keys(getRegisteredTools(server));
}

function mockFetch(status: number, body: unknown, capture?: { url?: string; method?: string; body?: string }): void {
	globalThis.fetch = mock(async (input: string | URL | Request, init?: RequestInit) => {
		if (capture) {
			capture.url = typeof input === "string" ? input : input.toString();
			capture.method = init?.method ?? "GET";
			capture.body = init?.body as string;
		}
		return new Response(JSON.stringify(body), {
			status,
			headers: { "Content-Type": "application/json" },
		});
	}) as unknown as typeof fetch;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createMcpServer", () => {
	let server: McpServer;
	const originalFetch = globalThis.fetch;

	beforeEach(async () => {
		server = await createMcpServer({
			daemonUrl: "http://localhost:3850",
			version: "0.0.1-test",
			enableMarketplaceProxyTools: false,
		});
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	it("creates server with correct info", () => {
		expect(server).toBeDefined();
		expect(server.server).toBeDefined();
	});

	it("registers all MCP tools", () => {
		const names = getToolNames(server);
		expect(names).toContain("memory_search");
		expect(names).toContain("memory_store");
		expect(names).toContain("memory_get");
		expect(names).toContain("memory_list");
		expect(names).toContain("memory_modify");
		expect(names).toContain("memory_forget");
		expect(names).toContain("memory_feedback");
		expect(names).toContain("knowledge_expand");
		expect(names).toContain("knowledge_expand_session");
		expect(names).toContain("lcm_expand");
		expect(names).toContain("agent_peers");
		expect(names).toContain("agent_message_send");
		expect(names).toContain("agent_message_inbox");
		expect(names).toContain("mcp_server_list");
		expect(names).toContain("mcp_server_search");
		expect(names).toContain("mcp_server_call");
		expect(names).toContain("mcp_server_enable");
		expect(names).toContain("mcp_server_disable");
		expect(names).toContain("mcp_server_scope_get");
		expect(names).toContain("mcp_server_scope_set");
		expect(names).toContain("mcp_server_policy_get");
		expect(names).toContain("mcp_server_policy_set");
		expect(names).toContain("secret_list");
		expect(names).toContain("secret_exec");
		expect(names).toContain("session_bypass");
		expect(names.length).toBe(25);
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

	describe("memory_feedback", () => {
		it("posts ratings with optional path and reward payload", async () => {
			const cap: { method?: string; body?: string } = {};
			mockFetch(200, { ok: true, recorded: 2 }, cap);

			await callTool(server, "memory_feedback", {
				session_key: "sess-1",
				agent_id: "default",
				ratings: { mem1: 1, mem2: -0.5 },
				paths: {
					mem1: {
						entity_ids: ["ent-a", "ent-b"],
						aspect_ids: ["asp-a"],
						dependency_ids: ["dep-a"],
					},
				},
				rewards: {
					mem1: {
						forward_citation: 1,
						update_after_retrieval: 0.5,
						downstream_creation: 0,
						dead_end: 0,
					},
				},
			});

			expect(cap.method).toBe("POST");
			const body = JSON.parse(cap.body ?? "{}");
			expect(body.sessionKey).toBe("sess-1");
			expect(body.agentId).toBe("default");
			expect(body.feedback.mem1).toBe(1);
			expect(body.paths.mem1.entity_ids[0]).toBe("ent-a");
			expect(body.rewards.mem1.forward_citation).toBe(1);
		});
	});

	describe("cross-agent tools", () => {
		it("agent_peers calls presence endpoint with defaults", async () => {
			const cap: { url?: string } = {};
			mockFetch(200, { sessions: [], count: 0 }, cap);

			await callTool(server, "agent_peers", {});
			expect(cap.url).toContain("/api/cross-agent/presence?");
			expect(cap.url).toContain("agent_id=default");
			expect(cap.url).toContain("include_self=false");
		});

		it("agent_message_send posts message payload", async () => {
			const cap: { method?: string; body?: string } = {};
			mockFetch(200, { message: { id: "m1" } }, cap);

			await callTool(server, "agent_message_send", {
				from_agent_id: "alpha",
				to_agent_id: "beta",
				type: "assist_request",
				content: "Can you review this approach?",
			});

			expect(cap.method).toBe("POST");
			const body = JSON.parse(cap.body ?? "{}");
			expect(body.fromAgentId).toBe("alpha");
			expect(body.toAgentId).toBe("beta");
			expect(body.type).toBe("assist_request");
			expect(body.content).toContain("review this approach");
		});

		it("agent_message_send maps ACP fields when via=acp", async () => {
			const cap: { method?: string; body?: string } = {};
			mockFetch(200, { message: { id: "m-acp" } }, cap);

			await callTool(server, "agent_message_send", {
				from_agent_id: "alpha",
				content: "Can you sanity-check this release?",
				via: "acp",
				acp_base_url: "https://acp.example.com",
				acp_target_agent_name: "peer-helper",
				acp_timeout_ms: 7000,
			});

			expect(cap.method).toBe("POST");
			const body = JSON.parse(cap.body ?? "{}");
			expect(body.via).toBe("acp");
			expect(body.acp.baseUrl).toBe("https://acp.example.com");
			expect(body.acp.targetAgentName).toBe("peer-helper");
			expect(body.acp.timeoutMs).toBe(7000);
		});

		it("agent_message_inbox calls messages endpoint", async () => {
			const cap: { url?: string } = {};
			mockFetch(200, { items: [], count: 0 }, cap);

			await callTool(server, "agent_message_inbox", {
				agent_id: "beta",
				limit: 25,
			});

			expect(cap.url).toContain("/api/cross-agent/messages?");
			expect(cap.url).toContain("agent_id=beta");
			expect(cap.url).toContain("limit=25");
		});
	});

	describe("mcp_server_list", () => {
		it("calls marketplace tools endpoint", async () => {
			const cap: { url?: string } = {};
			mockFetch(200, { count: 0, tools: [], servers: [] }, cap);

			await callTool(server, "mcp_server_list", { refresh: true });
			expect(cap.url).toBe("http://localhost:3850/api/marketplace/mcp/tools?refresh=1");
		});
	});

	describe("mcp_server_call", () => {
		it("calls routed tool endpoint with mapped payload", async () => {
			const cap: { method?: string; body?: string } = {};
			mockFetch(200, { success: true, result: { ok: true } }, cap);

			await callTool(server, "mcp_server_call", {
				server_id: "playwright",
				tool: "navigate",
				args: { url: "https://example.com" },
			});

			expect(cap.method).toBe("POST");
			const body = JSON.parse(cap.body ?? "{}");
			expect(body.serverId).toBe("playwright");
			expect(body.toolName).toBe("navigate");
			expect(body.args.url).toBe("https://example.com");
		});
	});

	describe("mcp management tools", () => {
		it("mcp_server_search calls search endpoint", async () => {
			const cap: { url?: string } = {};
			mockFetch(200, { query: "sum", count: 1, results: [] }, cap);

			await callTool(server, "mcp_server_search", {
				query: "sum",
				limit: 3,
				refresh: true,
				promote: false,
			});

			expect(cap.url).toContain("/api/marketplace/mcp/search?");
			expect(cap.url).toContain("q=sum");
			expect(cap.url).toContain("limit=3");
			expect(cap.url).toContain("refresh=1");
		});

		it("mcp_server_enable patches enabled=true", async () => {
			const cap: { method?: string; body?: string; url?: string } = {};
			mockFetch(200, { success: true }, cap);

			await callTool(server, "mcp_server_enable", {
				server_id: "dogfood-everything",
			});

			expect(cap.method).toBe("PATCH");
			expect(cap.url).toContain("/api/marketplace/mcp/dogfood-everything");
			const body = JSON.parse(cap.body ?? "{}");
			expect(body.enabled).toBe(true);
		});

		it("mcp_server_policy_set maps policy fields", async () => {
			const cap: { method?: string; body?: string } = {};
			mockFetch(200, { success: true, policy: { mode: "compact" } }, cap);

			await callTool(server, "mcp_server_policy_set", {
				mode: "compact",
				max_expanded_tools: 5,
				max_search_results: 4,
			});

			expect(cap.method).toBe("PATCH");
			const body = JSON.parse(cap.body ?? "{}");
			expect(body.mode).toBe("compact");
			expect(body.maxExpandedTools).toBe(5);
			expect(body.maxSearchResults).toBe(4);
		});
	});

	describe("marketplace proxy tools", () => {
		it("registers dynamic proxy tools for installed MCP tools", async () => {
			globalThis.fetch = mock(async (input: string | URL | Request, init?: RequestInit) => {
				const url = typeof input === "string" ? input : input.toString();

				if (url.endsWith("/api/marketplace/mcp/tools?refresh=1")) {
					return new Response(
						JSON.stringify({
							count: 1,
							servers: [
								{
									serverId: "dogfood-everything",
									serverName: "dogfood-everything",
									ok: true,
									toolCount: 1,
								},
							],
							tools: [
								{
									id: "dogfood-everything:echo",
									serverId: "dogfood-everything",
									serverName: "dogfood-everything",
									toolName: "echo",
									description: "Echo input text",
									readOnly: false,
									inputSchema: {},
								},
							],
						}),
						{ status: 200, headers: { "Content-Type": "application/json" } },
					);
				}

				if (url.endsWith("/api/marketplace/mcp/call")) {
					const rawBody = typeof init?.body === "string" ? init.body : "{}";
					const body = JSON.parse(rawBody) as Record<string, unknown>;
					return new Response(
						JSON.stringify({
							success: true,
							result: {
								serverId: body.serverId,
								toolName: body.toolName,
								args: body.args,
							},
						}),
						{ status: 200, headers: { "Content-Type": "application/json" } },
					);
				}

				return new Response(JSON.stringify({ error: "unexpected" }), {
					status: 404,
					headers: { "Content-Type": "application/json" },
				});
			}) as unknown as typeof fetch;

			const dynamicServer = await createMcpServer({
				daemonUrl: "http://localhost:3850",
				version: "0.0.1-test",
				enableMarketplaceProxyTools: true,
			});

			const names = getToolNames(dynamicServer);
			expect(names).toContain("signet_dogfood_everything_echo");

			const result = await callTool(dynamicServer, "signet_dogfood_everything_echo", {
				message: "hello",
			});
			expect(result.isError).toBeUndefined();
			expect(result.content[0]?.text).toContain("dogfood-everything");
			expect(result.content[0]?.text).toContain("echo");
		});

		it("refreshes proxy tools and reports changes", async () => {
			let stage: "initial" | "updated" = "initial";

			globalThis.fetch = mock(async (input: string | URL | Request, init?: RequestInit) => {
				const url = typeof input === "string" ? input : input.toString();

				if (url.endsWith("/api/marketplace/mcp/tools?refresh=1")) {
					const tools =
						stage === "initial"
							? [
									{
										id: "dogfood-everything:echo",
										serverId: "dogfood-everything",
										serverName: "dogfood-everything",
										toolName: "echo",
										description: "Echo input text",
										readOnly: false,
										inputSchema: {},
									},
								]
							: [
									{
										id: "dogfood-everything:echo",
										serverId: "dogfood-everything",
										serverName: "dogfood-everything",
										toolName: "echo",
										description: "Echo input text",
										readOnly: false,
										inputSchema: {},
									},
									{
										id: "dogfood-everything:get-sum",
										serverId: "dogfood-everything",
										serverName: "dogfood-everything",
										toolName: "get-sum",
										description: "Calculate a sum",
										readOnly: false,
										inputSchema: {},
									},
								];

					return new Response(
						JSON.stringify({
							count: tools.length,
							servers: [
								{
									serverId: "dogfood-everything",
									serverName: "dogfood-everything",
									ok: true,
									toolCount: tools.length,
								},
							],
							tools,
						}),
						{ status: 200, headers: { "Content-Type": "application/json" } },
					);
				}

				if (url.endsWith("/api/marketplace/mcp/call")) {
					const rawBody = typeof init?.body === "string" ? init.body : "{}";
					const body = JSON.parse(rawBody) as Record<string, unknown>;
					return new Response(
						JSON.stringify({
							success: true,
							result: {
								serverId: body.serverId,
								toolName: body.toolName,
								args: body.args,
							},
						}),
						{ status: 200, headers: { "Content-Type": "application/json" } },
					);
				}

				return new Response(JSON.stringify({ error: "unexpected" }), {
					status: 404,
					headers: { "Content-Type": "application/json" },
				});
			}) as unknown as typeof fetch;

			const dynamicServer = await createMcpServer({
				daemonUrl: "http://localhost:3850",
				version: "0.0.1-test",
				enableMarketplaceProxyTools: true,
			});

			expect(getToolNames(dynamicServer)).toContain("signet_dogfood_everything_echo");
			expect(getToolNames(dynamicServer)).not.toContain("signet_dogfood_everything_get_sum");

			stage = "updated";
			const refresh = await refreshMarketplaceProxyTools(dynamicServer, { notify: false });
			expect(refresh.changed).toBe(true);
			expect(getToolNames(dynamicServer)).toContain("signet_dogfood_everything_get_sum");
		});
	});
});

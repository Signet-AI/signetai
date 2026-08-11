import { describe, expect, test } from "bun:test";
import type { DaemonClient } from "./daemon-client.js";
import { createTools } from "./tools.js";

describe("createTools", () => {
	test("memory_search uses canonical defaults, bounds, and scope serialization", async () => {
		const captured: unknown[] = [];
		const client = {
			post: async (_path: string, body: unknown) => {
				captured.push(body);
				return { results: [], meta: { totalReturned: 0, hasSupplementary: false, noHits: true } };
			},
		} as unknown as DaemonClient;
		const tools = createTools(client);
		const memorySearch = tools.memory_search;
		if (memorySearch == null) {
			throw new Error("memory_search tool must be registered");
		}

		await memorySearch.execute({ query: "default recall" }, {} as never);
		await memorySearch.execute(
			{ query: "bounded recall", limit: 5000, scope: "world:alpha", include_recalled: true },
			{} as never,
		);

		expect(captured).toEqual([
			{ query: "default recall", limit: 10, recallSurface: "tool_call" },
			{
				query: "bounded recall",
				limit: 100,
				scope: "world:alpha",
				includeRecalled: true,
				recallSurface: "tool_call",
			},
		]);
	});

	test("session_search posts to the transcript search endpoint", async () => {
		let capturedPath = "";
		let capturedBody: unknown;
		const client = {
			post: async (path: string, body: unknown) => {
				capturedPath = path;
				capturedBody = body;
				return {
					query: "Juniper trunk ports",
					hits: [
						{
							sessionKey: "parent-session",
							project: "/tmp/network",
							updatedAt: "2026-03-25T10:05:00.000Z",
							excerpt: "keep the Juniper EX4300 VLAN audit focused on trunk ports",
							rank: -1.2,
						},
					],
					count: 1,
				};
			},
		} as unknown as DaemonClient;

		const tools = createTools(client);
		const sessionSearch = tools.session_search;
		if (sessionSearch == null) {
			throw new Error("session_search tool must be registered");
		}
		const result = await sessionSearch.execute(
			{
				query: "Juniper trunk ports",
				session_key: "parent-session",
				current_session_key: "child-session",
				agent_id: "research-agent",
				project: "/tmp/network",
				limit: 3,
			},
			{} as never,
		);

		expect(capturedPath).toBe("/api/sessions/search");
		expect(capturedBody).toEqual({
			query: "Juniper trunk ports",
			sessionKey: "parent-session",
			currentSessionKey: "child-session",
			agentId: "research-agent",
			project: "/tmp/network",
			limit: 3,
		});
		expect(result).toContain('"sessionKey": "parent-session"');
	});
});

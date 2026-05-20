import { describe, expect, test } from "bun:test";
import type { DaemonClient } from "./daemon-client.js";
import { createTools } from "./tools.js";

describe("createTools", () => {
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
		const result = await tools.session_search.execute(
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

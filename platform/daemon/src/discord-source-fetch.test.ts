import { afterEach, describe, expect, it, mock } from "bun:test";
import { fetchActiveThreads, fetchChannelMessages, fetchGuild, snowflakeIdForTimestamp } from "./discord-source-fetch";

const originalFetch = globalThis.fetch;

afterEach(() => {
	globalThis.fetch = originalFetch;
});

describe("discord-source-fetch", () => {
	it("fetches active threads through the guild-level Discord API v10 route", async () => {
		let requestedUrl = "";
		globalThis.fetch = mock((url: string | URL | Request) => {
			requestedUrl = String(url);
			return Promise.resolve(Response.json({ threads: [{ id: "thread1", type: 11, parent_id: "channel1" }] }));
		});

		const result = await fetchActiveThreads({ token: "TOKEN" }, "123456789012345678");

		expect(requestedUrl).toBe("https://discord.com/api/v10/guilds/123456789012345678/threads/active");
		expect(result.data[0]?.parent_id).toBe("channel1");
	});

	it("converts ISO timestamps to Discord snowflake lower bounds", () => {
		expect(snowflakeIdForTimestamp("2015-01-02T00:00:00.000Z")).toBe("362387865600000");
		expect(snowflakeIdForTimestamp("not-a-date")).toBeUndefined();
	});

	it("preserves 404 handling when Discord returns a non-JSON body", async () => {
		globalThis.fetch = mock(() =>
			Promise.resolve(
				new Response("missing", {
					status: 404,
					headers: { "content-type": "text/plain" },
				}),
			),
		) as typeof fetch;

		await expect(fetchGuild({ token: "TOKEN" }, "123456789012345678")).resolves.toBeNull();
	});

	it("skips malformed message ids without aborting the whole channel fetch", async () => {
		globalThis.fetch = mock(() =>
			Promise.resolve(
				Response.json([
					{
						id: "bad-id",
						type: 0,
						content: "oops",
						author: { id: "u1", username: "alice" },
						timestamp: "2026-05-23T16:00:00.000Z",
						channel_id: "channel1",
					},
					{
						id: "999999999999999999",
						type: 0,
						content: "ok",
						author: { id: "u2", username: "bob" },
						timestamp: "2026-05-23T16:01:00.000Z",
						channel_id: "channel1",
					},
				]),
			),
		) as typeof fetch;

		const result = await fetchChannelMessages({ token: "TOKEN" }, "channel1", 10, undefined, "1");

		expect(result.data.map((msg) => msg.id)).toEqual(["999999999999999999"]);
		expect(result.errors).toEqual([
			{
				message: "Messages fetch returned malformed message id for channel channel1: bad-id",
				retryable: false,
			},
		]);
	});
});

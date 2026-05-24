import { describe, expect, it, mock } from "bun:test";
import {
	DISCORD_CHANNEL_TYPES,
	fetchArchivedThreads,
	fetchChannelMessages,
	fetchGuild,
	fetchGuildActiveThreads,
	fetchGuildChannels,
	fetchGuildMembers,
	fetchThreadMembers,
	isDiscordTextReadableChannel,
	snowflakeIdForTimestamp,
} from "./discord-source-fetch";

describe("discord-source-fetch", () => {
	it("fetches active threads through the guild-level Discord API v10 route", async () => {
		let requestedUrl = "";
		const fetchImpl = mock((url: string | URL | Request) => {
			requestedUrl = String(url);
			return Promise.resolve(
				Response.json({ threads: [{ id: "123456789012345679", type: 11, parent_id: "123456789012345678" }] }),
			);
		}) as unknown as typeof fetch;

		const result = await fetchGuildActiveThreads({ token: "TOKEN", fetchImpl }, "123456789012345678");

		expect(requestedUrl).toBe("https://discord.com/api/v10/guilds/123456789012345678/threads/active");
		expect(result.data[0]?.parent_id).toBe("123456789012345678");
	});

	it("fetches archived public and private threads through parent-channel catalogs", async () => {
		const requested: string[] = [];
		const fetchImpl = mock((url: string | URL | Request) => {
			requested.push(String(url));
			return Promise.resolve(
				Response.json({
					threads: [{ id: "123456789012345680", type: 12, parent_id: "123456789012345678" }],
					has_more: false,
				}),
			);
		}) as unknown as typeof fetch;

		await fetchArchivedThreads({ token: "TOKEN", fetchImpl }, "123456789012345678", "public");
		await fetchArchivedThreads({ token: "TOKEN", fetchImpl }, "123456789012345678", "private");

		expect(requested[0]).toStartWith(
			"https://discord.com/api/v10/channels/123456789012345678/threads/archived/public?",
		);
		expect(requested[1]).toStartWith(
			"https://discord.com/api/v10/channels/123456789012345678/threads/archived/private?",
		);
	});

	it("paginates guild members using the last user id as the after cursor", async () => {
		const requested: string[] = [];
		const fetchImpl = mock((url: string | URL | Request) => {
			requested.push(String(url));
			if (requested.length === 1) {
				return Promise.resolve(
					Response.json(
						Array.from({ length: 100 }, (_, index) => ({
							user: { id: `${1000 + index}`, username: `user-${index}` },
						})),
					),
				);
			}
			return Promise.resolve(Response.json([{ user: { id: "2000", username: "final" } }]));
		}) as unknown as typeof fetch;

		const result = await fetchGuildMembers({ token: "TOKEN", fetchImpl }, "123456789012345678", 101);

		expect(result.data).toHaveLength(101);
		expect(requested[1]).toContain("after=1099");
	});

	it("preserves 404 handling when Discord returns a non-JSON body", async () => {
		const fetchImpl = mock(() =>
			Promise.resolve(new Response("missing", { status: 404, headers: { "content-type": "text/plain" } })),
		) as unknown as typeof fetch;

		await expect(fetchGuild({ token: "TOKEN", fetchImpl }, "123456789012345678")).resolves.toBeNull();
	});

	it("clears request timeouts when fetch rejects before a response", async () => {
		const originalSetTimeout = globalThis.setTimeout;
		const originalClearTimeout = globalThis.clearTimeout;
		const handles: unknown[] = [];
		const cleared: unknown[] = [];
		globalThis.setTimeout = ((handler: TimerHandler, timeout?: number, ...args: unknown[]) => {
			const handle = { handler, timeout, args };
			handles.push(handle);
			return handle;
		}) as typeof setTimeout;
		globalThis.clearTimeout = ((handle?: string | number | Timer) => {
			cleared.push(handle);
		}) as typeof clearTimeout;
		try {
			const fetchImpl = mock(() => Promise.reject(new Error("network down"))) as unknown as typeof fetch;

			await expect(
				fetchGuild({ token: "TOKEN", fetchImpl, sleepMs: async () => undefined }, "123456789012345678"),
			).rejects.toThrow("network down");

			expect(cleared).toEqual(handles);
		} finally {
			globalThis.setTimeout = originalSetTimeout;
			globalThis.clearTimeout = originalClearTimeout;
		}
	});

	it("surfaces non-JSON API errors without throwing away partial fetch state", async () => {
		const fetchImpl = mock(() =>
			Promise.resolve(new Response("rate limit text", { status: 403, headers: { "content-type": "text/plain" } })),
		) as unknown as typeof fetch;

		const result = await fetchThreadMembers({ token: "TOKEN", fetchImpl }, "123456789012345678");

		expect(result.data).toEqual([]);
		expect(result.errors[0]?.message).toContain("403: rate limit text");
	});

	it("returns structured errors when non-guild fetches exhaust retries", async () => {
		const fetchImpl = mock(() => Promise.reject(new Error("network down"))) as unknown as typeof fetch;
		const config = { token: "TOKEN", fetchImpl, sleepMs: async () => undefined };

		const channels = await fetchGuildChannels(config, "123456789012345678");
		const members = await fetchGuildMembers(config, "123456789012345678", 1);
		const messages = await fetchChannelMessages(config, "123456789012345679", 1);
		const activeThreads = await fetchGuildActiveThreads(config, "123456789012345678");
		const archivedThreads = await fetchArchivedThreads(config, "123456789012345679", "public", 1);
		const threadMembers = await fetchThreadMembers(config, "123456789012345680");

		expect(channels.errors[0]?.message).toContain("Channels fetch failed for guild 123456789012345678");
		expect(members.errors[0]?.message).toContain("Members fetch failed for guild 123456789012345678");
		expect(messages.errors[0]?.message).toContain("Messages fetch failed for channel 123456789012345679");
		expect(activeThreads.errors[0]?.message).toContain("Active threads fetch failed for guild 123456789012345678");
		expect(archivedThreads.errors[0]?.message).toContain(
			"Archived public threads fetch failed for channel 123456789012345679",
		);
		expect(threadMembers.errors[0]?.message).toContain("Thread members fetch failed for thread 123456789012345680");
		for (const error of [
			...channels.errors,
			...members.errors,
			...messages.errors,
			...activeThreads.errors,
			...archivedThreads.errors,
			...threadMembers.errors,
		]) {
			expect(error.retryable).toBe(true);
		}
	});

	it("converts ISO timestamps to Discord snowflake lower bounds", () => {
		expect(snowflakeIdForTimestamp("2015-01-02T00:00:00.000Z")).toBe("362387865600000");
		expect(snowflakeIdForTimestamp("not-a-date")).toBeUndefined();
	});

	it("treats forum and media parents as thread containers instead of message-readable channels", () => {
		expect(isDiscordTextReadableChannel({ id: "1", type: DISCORD_CHANNEL_TYPES.guildText })).toBe(true);
		expect(isDiscordTextReadableChannel({ id: "2", type: DISCORD_CHANNEL_TYPES.guildAnnouncement })).toBe(true);
		expect(isDiscordTextReadableChannel({ id: "3", type: DISCORD_CHANNEL_TYPES.publicThread })).toBe(true);
		expect(isDiscordTextReadableChannel({ id: "4", type: DISCORD_CHANNEL_TYPES.guildForum })).toBe(false);
		expect(isDiscordTextReadableChannel({ id: "5", type: DISCORD_CHANNEL_TYPES.guildMedia })).toBe(false);
	});

	it("skips malformed message ids without aborting the whole channel fetch", async () => {
		const fetchImpl = mock(() =>
			Promise.resolve(
				Response.json([
					{
						id: "bad-id",
						type: 0,
						content: "oops",
						author: { id: "123456789012345681", username: "alice" },
						timestamp: "2026-05-23T16:00:00.000Z",
						channel_id: "123456789012345678",
					},
					{
						id: "999999999999999999",
						type: 0,
						content: "ok",
						author: { id: "123456789012345682", username: "bob" },
						timestamp: "2026-05-23T16:01:00.000Z",
						channel_id: "123456789012345678",
					},
				]),
			),
		) as unknown as typeof fetch;

		const result = await fetchChannelMessages({ token: "TOKEN", fetchImpl }, "123456789012345678", 10, undefined, "1");

		expect(result.data.map((msg) => msg.id)).toEqual(["999999999999999999"]);
		expect(result.errors).toEqual([
			{
				message: "Messages fetch returned malformed message id for channel 123456789012345678: bad-id",
				retryable: false,
			},
		]);
	});
});

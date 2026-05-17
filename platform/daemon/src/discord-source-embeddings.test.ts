import { describe, expect, it } from "bun:test";
import { buildDiscordSourceChunks } from "./discord-source-embeddings";
import type { DiscordMessage } from "./discord-source-fetch";

function makeMessage(id: string, content: string, author: string, timestamp: string): DiscordMessage {
	return {
		id,
		type: 0,
		content,
		author: { id: `user-${author}`, username: author, global_name: author },
		timestamp,
		channel_id: "ch1",
	};
}

describe("discord-source-embeddings", () => {
	it("builds chunks from a sequence of messages", () => {
		const messages: DiscordMessage[] = [
			makeMessage("1", "Hello world", "alice", "2026-01-01T10:00:00.000Z"),
			makeMessage("2", "Hey there", "bob", "2026-01-01T10:00:15.000Z"),
			makeMessage("3", "How are you?", "alice", "2026-01-01T10:00:30.000Z"),
		];

		const chunks = buildDiscordSourceChunks({
			sourceId: "discord:test",
			guildId: "guild1",
			channelId: "ch1",
			channelName: "general",
			messages,
		});

		expect(chunks.length).toBeGreaterThan(0);
		expect(chunks[0]?.chunkText).toContain("source_id: discord:test");
		expect(chunks[0]?.chunkText).toContain("channel: general");
		expect(chunks[0]?.heading).toContain("#general");
	});

	it("splits messages into separate conversation batches across large time gaps", () => {
		const messages: DiscordMessage[] = [
			makeMessage("1", "Morning chat", "alice", "2026-01-01T10:00:00.000Z"),
			makeMessage("2", "Evening chat", "bob", "2026-01-01T20:00:00.000Z"),
		];

		const chunks = buildDiscordSourceChunks({
			sourceId: "discord:test",
			guildId: "guild1",
			channelId: "ch1",
			channelName: "general",
			messages,
		});

		expect(chunks.length).toBeGreaterThanOrEqual(2);
	});

	it("skips empty messages and noise types", () => {
		const messages: DiscordMessage[] = [
			{ ...makeMessage("1", "", "system", "2026-01-01T10:00:00.000Z"), type: 1 },
			{ ...makeMessage("2", "", "system", "2026-01-01T10:00:01.000Z"), type: 6 },
		];

		const chunks = buildDiscordSourceChunks({
			sourceId: "discord:test",
			guildId: "guild1",
			channelId: "ch1",
			channelName: "general",
			messages,
		});

		expect(chunks).toHaveLength(0);
	});

	it("includes thread ID in chunk IDs when provided", () => {
		const messages = [makeMessage("1", "Thread message", "alice", "2026-01-01T10:00:00.000Z")];

		const chunks = buildDiscordSourceChunks({
			sourceId: "discord:test",
			guildId: "guild1",
			channelId: "ch1",
			channelName: "general",
			threadId: "thread123",
			messages,
		});

		expect(chunks.length).toBeGreaterThan(0);
		expect(chunks[0]?.id).toContain("thread:thread123");
	});
});

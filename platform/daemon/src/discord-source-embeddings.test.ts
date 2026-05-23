import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDbAccessor, getDbAccessor, initDbAccessor } from "./db-accessor";
import { buildDiscordSourceChunks, indexDiscordSourceEmbeddings } from "./discord-source-embeddings";
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

function longMessage(label: string): string {
	return `${label} with enough detail to exceed the minimum chunk size for Discord source embedding tests.`;
}

describe("discord-source-embeddings", () => {
	let dir = "";

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "signet-discord-embeddings-"));
		closeDbAccessor();
		initDbAccessor(join(dir, "memories.db"));
	});

	afterEach(() => {
		closeDbAccessor();
		rmSync(dir, { recursive: true, force: true });
	});

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
			makeMessage("1", longMessage("Morning chat"), "alice", "2026-01-01T10:00:00.000Z"),
			makeMessage("2", longMessage("Evening chat"), "bob", "2026-01-01T20:00:00.000Z"),
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

	it("does not write embeddings if the source is deactivated while fetching vectors", async () => {
		let active = true;
		const result = await indexDiscordSourceEmbeddings({
			agentId: "test-agent",
			sourceId: "discord:test",
			guildId: "guild1",
			channelId: "ch1",
			channelName: "general",
			messages: [makeMessage("1", longMessage("Race window"), "alice", "2026-01-01T10:00:00.000Z")],
			embeddingConfig: {
				provider: "openai",
				model: "text-embedding-3-small",
				dimensions: 3,
			},
			fetchEmbedding: async () => {
				active = false;
				return [0.1, 0.2, 0.3];
			},
			sourceActiveCheck: () => active,
		});

		expect(result.embedded).toBe(0);
		const rows = getDbAccessor().withReadDb(
			(db) =>
				db.prepare("SELECT id FROM embeddings WHERE source_type = 'source_discord_chunk'").all() as Array<{
					id: string;
				}>,
		);
		expect(rows).toHaveLength(0);
	});
});

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDbAccessor, getDbAccessor, initDbAccessor } from "./db-accessor";
import { indexDiscordSourceStructure, reconcileDiscordGuildStructure } from "./discord-source-graph";

describe("discord-source-graph", () => {
	let dir = "";

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "signet-discord-graph-"));
		closeDbAccessor();
		initDbAccessor(join(dir, "memories.db"));
	});

	afterEach(() => {
		closeDbAccessor();
		rmSync(dir, { recursive: true, force: true });
	});

	it("indexDiscordSourceStructure does not throw for basic input", () => {
		expect(() =>
			indexDiscordSourceStructure({
				agentId: "test-agent",
				sourceId: "discord:test1234",
				sourceName: "Test Discord Source",
				guildId: "123456789012345678",
				guildName: "Test Guild",
				channelId: "ch1",
				channelName: "general",
				messageCount: 42,
				participants: [
					{ id: "u1", name: "alice" },
					{ id: "u2", name: "bob" },
				],
			}),
		).not.toThrow();
	});

	it("handles empty participants list", () => {
		expect(() =>
			indexDiscordSourceStructure({
				agentId: "test-agent",
				sourceId: "discord:test1234",
				sourceName: "Test Source",
				guildId: "123456789012345678",
				guildName: "Test Guild",
				channelId: "ch1",
				channelName: "general",
				messageCount: 5,
				participants: [],
			}),
		).not.toThrow();
	});

	it("handles thread input with thread ID and name", () => {
		expect(() =>
			indexDiscordSourceStructure({
				agentId: "test-agent",
				sourceId: "discord:test1234",
				sourceName: "Test Source",
				guildId: "123456789012345678",
				guildName: "Test Guild",
				channelId: "ch1",
				channelName: "general",
				threadId: "thread123",
				threadName: "Help Thread",
				messageCount: 10,
				participants: [{ id: "u1", name: "alice" }],
			}),
		).not.toThrow();
	});

	it("accepts participants with duplicate names when IDs differ", () => {
		expect(() =>
			indexDiscordSourceStructure({
				agentId: "test-agent",
				sourceId: "discord:test1234",
				sourceName: "Test Source",
				guildId: "123456789012345678",
				guildName: "Test Guild",
				channelId: "ch1",
				channelName: "general",
				messageCount: 2,
				participants: [
					{ id: "u1", name: "avery" },
					{ id: "u2", name: "avery" },
				],
			}),
		).not.toThrow();
	});

	it("scopes participant entities by Discord source", () => {
		indexDiscordSourceStructure({
			agentId: "test-agent",
			sourceId: "discord:source-a",
			sourceName: "Source A",
			guildId: "123456789012345678",
			guildName: "Guild A",
			channelId: "ch1",
			channelName: "general",
			messageCount: 1,
			participants: [{ id: "u1", name: "alice" }],
		});
		indexDiscordSourceStructure({
			agentId: "test-agent",
			sourceId: "discord:source-b",
			sourceName: "Source B",
			guildId: "223456789012345678",
			guildName: "Guild B",
			channelId: "ch2",
			channelName: "random",
			messageCount: 1,
			participants: [{ id: "u1", name: "alice" }],
		});

		const rows = getDbAccessor().withReadDb(
			(db) =>
				db
					.prepare(
						"SELECT canonical_name, source_id FROM entities WHERE agent_id = ? AND entity_type = 'source_document_reference' ORDER BY source_id",
					)
					.all("test-agent") as Array<{ canonical_name: string; source_id: string }>,
		);

		expect(rows).toEqual([
			{ canonical_name: "discord:discord:source-a:user:u1", source_id: "discord:source-a" },
			{ canonical_name: "discord:discord:source-b:user:u1", source_id: "discord:source-b" },
		]);
	});

	it("scopes guild, channel, and conversation entities by Discord source", () => {
		indexDiscordSourceStructure({
			agentId: "test-agent",
			sourceId: "discord:source-a",
			sourceName: "Source A",
			guildId: "123456789012345678",
			guildName: "Guild",
			channelId: "ch1",
			channelName: "general",
			messageCount: 1,
			participants: [],
		});
		indexDiscordSourceStructure({
			agentId: "test-agent",
			sourceId: "discord:source-b",
			sourceName: "Source B",
			guildId: "123456789012345678",
			guildName: "Guild",
			channelId: "ch1",
			channelName: "general",
			messageCount: 1,
			participants: [],
		});

		const rows = getDbAccessor().withReadDb(
			(db) =>
				db
					.prepare(
						"SELECT canonical_name, source_id FROM entities WHERE agent_id = ? AND entity_type IN ('source_folder', 'source_document') ORDER BY source_id, canonical_name",
					)
					.all("test-agent") as Array<{ canonical_name: string; source_id: string }>,
		);

		expect(rows).toEqual([
			{
				canonical_name: "discord:discord:source-a:guild:123456789012345678",
				source_id: "discord:source-a",
			},
			{
				canonical_name: "discord:discord:source-a:guild:123456789012345678:channel:ch1",
				source_id: "discord:source-a",
			},
			{
				canonical_name: "discord:discord:source-a:guild:123456789012345678:channel:ch1:messages",
				source_id: "discord:source-a",
			},
			{
				canonical_name: "discord:discord:source-b:guild:123456789012345678",
				source_id: "discord:source-b",
			},
			{
				canonical_name: "discord:discord:source-b:guild:123456789012345678:channel:ch1",
				source_id: "discord:source-b",
			},
			{
				canonical_name: "discord:discord:source-b:guild:123456789012345678:channel:ch1:messages",
				source_id: "discord:source-b",
			},
		]);
	});

	it("replaces stale participant links for a refreshed conversation", () => {
		indexDiscordSourceStructure({
			agentId: "test-agent",
			sourceId: "discord:test1234",
			sourceName: "Test Source",
			guildId: "123456789012345678",
			guildName: "Test Guild",
			channelId: "ch1",
			channelName: "general",
			messageCount: 2,
			participants: [
				{ id: "u1", name: "alice" },
				{ id: "u2", name: "bob" },
			],
		});
		indexDiscordSourceStructure({
			agentId: "test-agent",
			sourceId: "discord:test1234",
			sourceName: "Test Source",
			guildId: "123456789012345678",
			guildName: "Test Guild",
			channelId: "ch1",
			channelName: "general",
			messageCount: 1,
			participants: [{ id: "u2", name: "bob" }],
		});

		const dependencies = getDbAccessor().withReadDb(
			(db) =>
				db
					.prepare(
						"SELECT target_entity_id FROM entity_dependencies WHERE agent_id = ? AND source_id = ? AND dependency_type = 'wiki_link' ORDER BY target_entity_id",
					)
					.all("test-agent", "discord:test1234") as Array<{ target_entity_id: string }>,
		);
		const participants = getDbAccessor().withReadDb(
			(db) =>
				db
					.prepare(
						"SELECT canonical_name FROM entities WHERE agent_id = ? AND source_id = ? AND entity_type = 'source_document_reference' ORDER BY canonical_name",
					)
					.all("test-agent", "discord:test1234") as Array<{ canonical_name: string }>,
		);

		expect(dependencies).toHaveLength(1);
		expect(participants).toEqual([{ canonical_name: "discord:discord:test1234:user:u2" }]);
	});

	it("removes stale channel conversations and orphaned participants during guild reconcile", () => {
		indexDiscordSourceStructure({
			agentId: "test-agent",
			sourceId: "discord:test1234",
			sourceName: "Test Source",
			guildId: "123456789012345678",
			guildName: "Test Guild",
			channelId: "ch1",
			channelName: "general",
			messageCount: 2,
			participants: [{ id: "u1", name: "alice" }],
		});
		indexDiscordSourceStructure({
			agentId: "test-agent",
			sourceId: "discord:test1234",
			sourceName: "Test Source",
			guildId: "123456789012345678",
			guildName: "Test Guild",
			channelId: "ch2",
			channelName: "random",
			threadId: "thread1",
			threadName: "Thread 1",
			messageCount: 1,
			participants: [{ id: "u2", name: "bob" }],
		});

		reconcileDiscordGuildStructure({
			agentId: "test-agent",
			sourceId: "discord:test1234",
			guildId: "123456789012345678",
			currentChannelIds: ["ch2"],
			reconciledChannels: [
				{
					channelId: "ch2",
					conversationPaths: ["discord:discord:test1234:guild:123456789012345678:channel:ch2:thread:thread1"],
				},
			],
		});

		const entities = getDbAccessor().withReadDb(
			(db) =>
				db
					.prepare(
						"SELECT entity_type, source_path FROM entities WHERE agent_id = ? AND source_id = ? ORDER BY entity_type, source_path",
					)
					.all("test-agent", "discord:test1234") as Array<{ entity_type: string; source_path: string }>,
		);

		expect(entities).toEqual([
			{ entity_type: "source", source_path: "discord:test1234" },
			{
				entity_type: "source_document",
				source_path: "discord:discord:test1234:guild:123456789012345678:channel:ch2:thread:thread1",
			},
			{ entity_type: "source_document_reference", source_path: "discord:discord:test1234:user:u2" },
			{ entity_type: "source_folder", source_path: "discord:discord:test1234:guild:123456789012345678" },
			{
				entity_type: "source_folder",
				source_path: "discord:discord:test1234:guild:123456789012345678:channel:ch2",
			},
		]);
	});
});

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDbAccessor, initDbAccessor } from "./db-accessor";
import { indexDiscordSourceStructure } from "./discord-source-graph";

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
});

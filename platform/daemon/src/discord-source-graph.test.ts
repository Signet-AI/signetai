import { describe, expect, it } from "bun:test";
import { indexDiscordSourceStructure } from "./discord-source-graph";

describe("discord-source-graph", () => {
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
				participants: ["alice", "bob"],
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
				participants: ["alice"],
			}),
		).not.toThrow();
	});
});

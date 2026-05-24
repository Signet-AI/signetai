import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addDiscordSource } from "@signet/core";
import { closeDbAccessor, getDbAccessor, initDbAccessor } from "./db-accessor";
import { DISCORD_CHANNEL_TYPES } from "./discord-source-fetch";
import { discordSourceProvider } from "./discord-source-provider";
import { indexExternalMemoryArtifact } from "./memory-lineage";
import { putSecret } from "./secrets";
import { indexSourceArtifactStructure } from "./source-artifact-graph";

const originalFetch = globalThis.fetch;

describe("discord-source-provider", () => {
	let dir = "";
	let previousSignetPath: string | undefined;

	beforeEach(async () => {
		dir = mkdtempSync(join(tmpdir(), "signet-discord-source-"));
		previousSignetPath = process.env.SIGNET_PATH;
		process.env.SIGNET_PATH = dir;
		mkdirSync(join(dir, "memory"), { recursive: true });
		closeDbAccessor();
		initDbAccessor(join(dir, "memory", "memories.db"));
		await putSecret("DISCORD_BOT_TOKEN", "bot-token");
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
		closeDbAccessor();
		if (previousSignetPath === undefined) Reflect.deleteProperty(process.env, "SIGNET_PATH");
		else process.env.SIGNET_PATH = previousSignetPath;
		rmSync(dir, { recursive: true, force: true });
	});

	it("indexes multi-guild Discord topology, members, threads, messages, mentions, attachments, embeds, polls, and checkpoints", async () => {
		globalThis.fetch = mock((url: string | URL | Request) =>
			Promise.resolve(discordResponse(String(url))),
		) as typeof fetch;
		const added = addDiscordSource(
			{
				guildIds: ["123456789012345678", "223456789012345678"],
				tokenRef: "DISCORD_BOT_TOKEN",
				channelFilter: ["general", "123456789012345679"],
				maxMessagesPerChannel: 10,
				includePrivateArchivedThreads: true,
				now: "2026-01-01T00:00:00.000Z",
			},
			dir,
		);
		expect(added.ok).toBe(true);
		if (added.ok === false) throw new Error(added.error);
		const progress: string[] = [];

		const result = await discordSourceProvider.sync?.({
			source: added.source,
			agentsDir: dir,
			agentId: "default",
			shouldContinue: () => true,
			onProgress: (event) => progress.push(event.currentPath),
		});

		expect(result?.failures).toEqual([]);
		expect(progress.some((path) => path.includes("/channel/123456789012345679"))).toBe(true);
		const rows = sourceRows(added.source.id);
		expect(rows.map((row) => row.source_kind)).toContain("source_discord_guild");
		expect(rows.map((row) => row.source_kind)).toContain("source_discord_channel");
		expect(rows.map((row) => row.source_kind)).toContain("source_discord_thread");
		expect(rows.map((row) => row.source_kind)).toContain("source_discord_member");
		expect(rows.map((row) => row.source_kind)).toContain("source_discord_thread_member");
		expect(rows.map((row) => row.source_kind)).toContain("source_discord_message_window");
		expect(rows.map((row) => row.source_kind)).toContain("source_discord_message");
		expect(rows.map((row) => row.source_kind)).toContain("source_discord_mention");
		expect(rows.map((row) => row.source_kind)).toContain("source_discord_attachment");
		expect(rows.map((row) => row.source_kind)).toContain("source_discord_embed");
		expect(rows.map((row) => row.source_kind)).toContain("source_discord_poll");
		expect(rows.map((row) => row.source_kind)).toContain("source_discord_checkpoint");
		expect(rows.some((row) => row.source_path.includes("/channel/323456789012345678"))).toBe(false);
		const message = rows.find((row) => row.source_kind === "source_discord_message");
		expect(message?.source_meta_json).toContain('"replyToMessageId":"999999999999999998"');
		expect(message?.source_meta_json).toContain('"pinned":true');
		const attachment = rows.find((row) => row.source_kind === "source_discord_attachment");
		expect(attachment?.source_meta_json).toContain('"urlPresent":true');
		const graph = getDbAccessor().withReadDb((db) => ({
			docs: (
				db
					.prepare("SELECT COUNT(*) AS count FROM entities WHERE source_id = ? AND entity_type = 'source_document'")
					.get(added.source.id) as { count: number }
			).count,
			attrs: (
				db
					.prepare("SELECT COUNT(*) AS count FROM entity_attributes WHERE source_id = ? AND memory_id IS NULL")
					.get(added.source.id) as { count: number }
			).count,
		}));
		expect(graph.docs).toBeGreaterThan(0);
		expect(graph.attrs).toBeGreaterThan(0);
	});

	it("records partial Discord failures without deleting existing source-owned rows", async () => {
		const added = addDiscordSource(
			{ guildIds: ["123456789012345678"], tokenRef: "DISCORD_BOT_TOKEN", now: "2026-01-01T00:00:00.000Z" },
			dir,
		);
		expect(added.ok).toBe(true);
		if (added.ok === false) throw new Error(added.error);
		indexExternalMemoryArtifact({
			agentId: "default",
			harness: "discord",
			sourceId: added.source.id,
			sourceRoot: added.source.root,
			sourceExternalId: "message_window:old",
			sourcePath: "discord://guild/123456789012345678/channel/old/messages/old",
			sourceKind: "source_discord_message_window",
			sourceMtimeMs: Date.now(),
			content: "old row",
		});
		globalThis.fetch = mock((url: string | URL | Request) => {
			const text = String(url);
			if (text.includes("/guilds/123456789012345678?with_counts=true")) {
				return Promise.resolve(Response.json({ id: "123456789012345678", name: "Guild A" }));
			}
			if (text.includes("/channels")) return Promise.resolve(new Response("discord unavailable", { status: 503 }));
			return Promise.resolve(Response.json([]));
		}) as typeof fetch;

		const result = await discordSourceProvider.sync?.({
			source: added.source,
			agentsDir: dir,
			agentId: "default",
			shouldContinue: () => true,
		});

		expect(result?.failures[0]?.message).toContain("Channels fetch failed");
		const rows = sourceRows(added.source.id);
		expect(rows.some((row) => row.content === "old row")).toBe(true);
		expect(rows.map((row) => row.source_kind)).toContain("source_discord_failure");
	});

	it("removes stale source-owned Discord artifacts after a fully successful sync", async () => {
		const added = addDiscordSource(
			{ guildIds: ["123456789012345678"], tokenRef: "DISCORD_BOT_TOKEN", now: "2026-01-01T00:00:00.000Z" },
			dir,
		);
		expect(added.ok).toBe(true);
		if (added.ok === false) throw new Error(added.error);
		indexExternalMemoryArtifact({
			agentId: "default",
			harness: "discord",
			sourceId: added.source.id,
			sourceRoot: added.source.root,
			sourceExternalId: "message:stale",
			sourcePath: "discord://guild/123456789012345678/channel/old/messages/stale",
			sourceKind: "source_discord_message",
			sourceMtimeMs: Date.now(),
			content: "stale row",
		});
		getDbAccessor().withWriteTx((db) => {
			db.prepare("UPDATE memory_artifacts SET updated_at = ? WHERE source_id = ? AND content = ?").run(
				"2000-01-01T00:00:00.000Z",
				added.source.id,
				"stale row",
			);
		});
		globalThis.fetch = mock((url: string | URL | Request) => {
			const text = String(url);
			if (text.includes("/guilds/123456789012345678?with_counts=true")) {
				return Promise.resolve(Response.json({ id: "123456789012345678", name: "Guild A" }));
			}
			if (text.includes("/guilds/123456789012345678/channels")) return Promise.resolve(Response.json([]));
			if (text.includes("/members?")) return Promise.resolve(Response.json([]));
			if (text.includes("/threads/active")) return Promise.resolve(Response.json({ threads: [] }));
			return Promise.resolve(Response.json([]));
		}) as typeof fetch;

		const result = await discordSourceProvider.sync?.({
			source: added.source,
			agentsDir: dir,
			agentId: "default",
			shouldContinue: () => true,
		});

		expect(result?.failures).toEqual([]);
		const rows = sourceRows(added.source.id);
		expect(rows.some((row) => row.content === "stale row")).toBe(false);
		expect(rows.some((row) => row.source_path === "discord://guild/123456789012345678")).toBe(true);
	});

	it("imports Discord Desktop cache DMs locally without persisting raw cache tokens", async () => {
		const cachePath = join(dir, "discord", "Local Storage", "leveldb");
		mkdirSync(cachePath, { recursive: true });
		writeFileSync(
			join(cachePath, "000001.log"),
			[
				`{"id":"111111111111111111","type":1,"recipients":[{"id":"222222222222222222","username":"alice","global_name":"Alice"}]}`,
				`noise {"t":"MESSAGE_CREATE","token":"do-not-store","d":{"id":"333333333333333333","channel_id":"111111111111111111","content":"launch checklist in a DM mfa.CCCCCCCCCCCCCCCCCCCCCCCCCCCCCC","timestamp":"2026-04-23T18:20:43.123Z","author":{"id":"222222222222222222","username":"alice","global_name":"Alice"},"attachments":[{"id":"444444444444444444","filename":"plan.txt","size":10}],"mentions":[{"id":"555555555555555555","username":"bob"}],"embeds":[{"title":"mfa.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAA","description":"safe summary","fields":[{"name":"Authorization","value":"mfa.BBBBBBBBBBBBBBBBBBBBBBBBBBBBBB"}]}],"poll":{"question":{"text":"mfa.DDDDDDDDDDDDDDDDDDDDDDDDDDDDDD"},"answers":[{"answer_id":1,"poll_media":{"text":"mfa.EEEEEEEEEEEEEEEEEEEEEEEEEEEEEE"}}]}}} tail`,
			].join("\n"),
		);
		const added = addDiscordSource(
			{
				guildIds: [],
				name: "Desktop Cache",
				desktopCachePath: join(dir, "discord"),
				syncMode: "desktop-cache",
				now: "2026-01-01T00:00:00.000Z",
			},
			dir,
		);
		expect(added.ok).toBe(true);
		if (added.ok === false) throw new Error(added.error);

		const result = await discordSourceProvider.sync?.({
			source: added.source,
			agentsDir: dir,
			agentId: "default",
			shouldContinue: () => true,
		});

		expect(result?.failures).toEqual([]);
		const rows = sourceRows(added.source.id);
		expect(rows.some((row) => row.source_path === "discord-cache://guild/@me")).toBe(true);
		expect(rows.some((row) => row.source_path === "discord-cache://guild/@me/channel/111111111111111111")).toBe(true);
		expect(
			rows.some(
				(row) => row.source_path === "discord-cache://guild/@me/channel/111111111111111111/messages/333333333333333333",
			),
		).toBe(true);
		expect(rows.map((row) => row.source_kind)).toContain("source_discord_attachment");
		expect(rows.map((row) => row.source_kind)).toContain("source_discord_mention");
		expect(rows.map((row) => row.source_kind)).toContain("source_discord_embed");
		expect(rows.map((row) => row.source_kind)).toContain("source_discord_poll");
		expect(rows.find((row) => row.source_kind === "source_discord_message")?.source_meta_json).toContain(
			'"localOnly":true',
		);
		const indexedText = rows.map((row) => `${row.content}\n${row.source_meta_json ?? ""}`).join("\n");
		expect(indexedText).not.toContain("do-not-store");
		expect(indexedText).not.toContain("mfa.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAA");
		expect(indexedText).not.toContain("mfa.BBBBBBBBBBBBBBBBBBBBBBBBBBBBBB");
		expect(indexedText).not.toContain("mfa.CCCCCCCCCCCCCCCCCCCCCCCCCCCCCC");
		expect(indexedText).not.toContain("mfa.DDDDDDDDDDDDDDDDDDDDDDDDDDDDDD");
		expect(indexedText).not.toContain("mfa.EEEEEEEEEEEEEEEEEEEEEEEEEEEEEE");
		expect(indexedText).toContain("[redacted]");
		const graphDocs = getDbAccessor().withReadDb(
			(db) =>
				(
					db
						.prepare("SELECT COUNT(*) AS count FROM entities WHERE source_id = ? AND entity_type = 'source_document'")
						.get(added.source.id) as { count: number }
				).count,
		);
		expect(graphDocs).toBeGreaterThan(0);
	});

	it("purges stale Discord Desktop cache artifacts and graph rows after a complete sync", async () => {
		const cachePath = join(dir, "discord");
		mkdirSync(cachePath, { recursive: true });
		const added = addDiscordSource(
			{
				guildIds: [],
				name: "Desktop Cache",
				desktopCachePath: cachePath,
				syncMode: "desktop-cache",
				now: "2026-01-01T00:00:00.000Z",
			},
			dir,
		);
		expect(added.ok).toBe(true);
		if (added.ok === false) throw new Error(added.error);
		const stalePath = "discord-cache://guild/@me/channel/stale/messages/stale";
		indexExternalMemoryArtifact({
			agentId: "default",
			harness: "discord",
			sourceId: added.source.id,
			sourceRoot: added.source.root,
			sourceExternalId: "message:stale",
			sourcePath: stalePath,
			sourceKind: "source_discord_message",
			sourceMtimeMs: Date.parse("2025-01-01T00:00:00.000Z"),
			content: "stale cache message",
		});
		indexSourceArtifactStructure({
			agentId: "default",
			sourceId: added.source.id,
			sourceKind: "source_discord_message",
			sourceRoot: added.source.root,
			sourcePath: stalePath,
			content: "# Stale\n\nThis stale desktop-cache graph row should be purged after the next complete sync.\n",
		});
		getDbAccessor().withWriteTx((db) => {
			db.prepare("UPDATE memory_artifacts SET updated_at = ? WHERE source_id = ? AND source_path = ?").run(
				"2025-01-01T00:00:00.000Z",
				added.source.id,
				stalePath,
			);
			db.prepare("UPDATE entities SET updated_at = ? WHERE source_id = ? AND source_path = ?").run(
				"2025-01-01T00:00:00.000Z",
				added.source.id,
				stalePath,
			);
		});

		const result = await discordSourceProvider.sync?.({
			source: added.source,
			agentsDir: dir,
			agentId: "default",
			shouldContinue: () => true,
		});

		expect(result?.failures).toEqual([]);
		expect(sourceRows(added.source.id).some((row) => row.source_path === stalePath)).toBe(false);
		const graphRows = getDbAccessor().withReadDb((db) => ({
			entities: (
				db
					.prepare("SELECT COUNT(*) AS count FROM entities WHERE source_id = ? AND source_path = ?")
					.get(added.source.id, stalePath) as { count: number }
			).count,
			attrs: (
				db
					.prepare("SELECT COUNT(*) AS count FROM entity_attributes WHERE source_id = ? AND source_path = ?")
					.get(added.source.id, stalePath) as { count: number }
			).count,
		}));
		expect(graphRows).toEqual({ entities: 0, attrs: 0 });
	});

	it("classifies route-bearing Discord Desktop cache guild messages and skips ambiguous routes", async () => {
		const cachePath = join(dir, "discord", "Cache", "Cache_Data");
		mkdirSync(cachePath, { recursive: true });
		writeFileSync(
			join(cachePath, "guild_0"),
			[
				"https://discord.com/channels/999999999999999998/111111111111111115",
				`{"id":"333333333333333337","channel_id":"111111111111111115","content":"route guild message","timestamp":"2026-04-23T18:20:44Z","author":{"id":"222222222222222226","username":"bob"}}`,
			].join("\n"),
		);
		writeFileSync(
			join(cachePath, "ambiguous_0"),
			[
				"https://discord.com/channels/999999999999999998/111111111111111118",
				"https://discord.com/channels/999999999999999997/111111111111111118",
				"https://discord.com/channels/999999999999999998/111111111111111118",
				`{"id":"333333333333333340","channel_id":"111111111111111118","content":"ambiguous route message","timestamp":"2026-04-23T18:20:43Z","author":{"id":"222222222222222229","username":"alice"}}`,
			].join("\n"),
		);
		writeFileSync(
			join(cachePath, "clear_later_0"),
			[
				"https://discord.com/channels/999999999999999998/111111111111111118",
				`{"id":"333333333333333341","channel_id":"111111111111111118","content":"later clear route message","timestamp":"2026-04-23T18:20:45Z","author":{"id":"222222222222222229","username":"alice"}}`,
			].join("\n"),
		);
		const added = addDiscordSource(
			{
				guildIds: [],
				name: "Desktop Cache",
				desktopCachePath: join(dir, "discord"),
				syncMode: "desktop-cache",
				now: "2026-01-01T00:00:00.000Z",
			},
			dir,
		);
		expect(added.ok).toBe(true);
		if (added.ok === false) throw new Error(added.error);

		const result = await discordSourceProvider.sync?.({
			source: added.source,
			agentsDir: dir,
			agentId: "default",
			shouldContinue: () => true,
		});

		expect(result?.failures).toEqual([]);
		const rows = sourceRows(added.source.id);
		expect(
			rows.some(
				(row) =>
					row.source_path ===
					"discord-cache://guild/999999999999999998/channel/111111111111111115/messages/333333333333333337",
			),
		).toBe(true);
		expect(rows.some((row) => row.content.includes("ambiguous route message"))).toBe(false);
		expect(rows.some((row) => row.content.includes("later clear route message"))).toBe(true);
		const stats = rows.find((row) => row.source_kind === "source_discord_desktop_import");
		expect(stats?.source_meta_json).toContain('"skippedMessages":1');
	});

	it("skips unreadable Discord Desktop cache files without failing the source sync", async () => {
		const cachePath = join(dir, "discord", "Local Storage", "leveldb");
		mkdirSync(cachePath, { recursive: true });
		writeFileSync(
			join(cachePath, "000001.log"),
			[
				`{"id":"111111111111111111","type":1,"recipients":[{"id":"222222222222222222","username":"alice"}]}`,
				`{"id":"333333333333333333","channel_id":"111111111111111111","content":"readable cache message","timestamp":"2026-04-23T18:20:43.123Z","author":{"id":"222222222222222222","username":"alice"}}`,
			].join("\n"),
		);
		const unreadablePath = join(cachePath, "000002.log");
		writeFileSync(unreadablePath, "unreadable");
		chmodSync(unreadablePath, 0);
		const added = addDiscordSource(
			{
				name: "Desktop Cache",
				desktopCachePath: join(dir, "discord"),
				syncMode: "desktop-cache",
				now: "2026-01-01T00:00:00.000Z",
			},
			dir,
		);
		expect(added.ok).toBe(true);
		if (added.ok === false) throw new Error(added.error);

		let result: Awaited<ReturnType<NonNullable<typeof discordSourceProvider.sync>>> | undefined;
		try {
			result = await discordSourceProvider.sync?.({
				source: added.source,
				agentsDir: dir,
				agentId: "default",
				shouldContinue: () => true,
			});
		} finally {
			chmodSync(unreadablePath, 0o600);
		}
		expect(result?.failures).toEqual([]);
		const rows = sourceRows(added.source.id);
		expect(rows.some((row) => row.content.includes("readable cache message"))).toBe(true);
		const stats = rows.find((row) => row.source_kind === "source_discord_desktop_import");
		expect(stats?.source_meta_json).toContain('"filesSkipped":1');
	});

	it("skips unreadable Discord Desktop cache directories without failing the source sync", async () => {
		const cachePath = join(dir, "discord", "Local Storage", "leveldb");
		mkdirSync(cachePath, { recursive: true });
		writeFileSync(
			join(cachePath, "000001.log"),
			[
				`{"id":"111111111111111111","type":1,"recipients":[{"id":"222222222222222222","username":"alice"}]}`,
				`{"id":"333333333333333333","channel_id":"111111111111111111","content":"directory skip still imports","timestamp":"2026-04-23T18:20:43.123Z","author":{"id":"222222222222222222","username":"alice"}}`,
			].join("\n"),
		);
		const unreadableDir = join(cachePath, "mutable-cache-dir");
		mkdirSync(unreadableDir, { recursive: true });
		chmodSync(unreadableDir, 0);
		const added = addDiscordSource(
			{
				name: "Desktop Cache",
				desktopCachePath: join(dir, "discord"),
				syncMode: "desktop-cache",
				now: "2026-01-01T00:00:00.000Z",
			},
			dir,
		);
		expect(added.ok).toBe(true);
		if (added.ok === false) throw new Error(added.error);

		let result: Awaited<ReturnType<NonNullable<typeof discordSourceProvider.sync>>> | undefined;
		try {
			result = await discordSourceProvider.sync?.({
				source: added.source,
				agentsDir: dir,
				agentId: "default",
				shouldContinue: () => true,
			});
		} finally {
			chmodSync(unreadableDir, 0o700);
		}

		expect(result?.failures).toEqual([]);
		const rows = sourceRows(added.source.id);
		expect(rows.some((row) => row.content.includes("directory skip still imports"))).toBe(true);
		const stats = rows.find((row) => row.source_kind === "source_discord_desktop_import");
		expect(stats?.source_meta_json).toContain('"filesSkipped":1');
	});

	it("records guild fetch failures and continues syncing later guilds", async () => {
		const added = addDiscordSource(
			{
				guildIds: ["123456789012345678", "223456789012345678"],
				tokenRef: "DISCORD_BOT_TOKEN",
				now: "2026-01-01T00:00:00.000Z",
			},
			dir,
		);
		expect(added.ok).toBe(true);
		if (added.ok === false) throw new Error(added.error);
		globalThis.fetch = mock((url: string | URL | Request) => {
			const text = String(url);
			if (text.includes("/guilds/123456789012345678?with_counts=true")) {
				return Promise.resolve(new Response("discord unavailable", { status: 503 }));
			}
			if (text.includes("/guilds/223456789012345678?with_counts=true")) {
				return Promise.resolve(Response.json({ id: "223456789012345678", name: "Guild B" }));
			}
			if (text.includes("/guilds/223456789012345678/channels")) return Promise.resolve(Response.json([]));
			if (text.includes("/members?")) return Promise.resolve(Response.json([]));
			if (text.includes("/threads/active")) return Promise.resolve(Response.json({ threads: [] }));
			return Promise.resolve(Response.json([]));
		}) as typeof fetch;

		const result = await discordSourceProvider.sync?.({
			source: added.source,
			agentsDir: dir,
			agentId: "default",
			shouldContinue: () => true,
		});

		expect(result?.failures[0]?.message).toContain("Discord guild fetch failed");
		const rows = sourceRows(added.source.id);
		expect(rows.some((row) => row.source_kind === "source_discord_failure")).toBe(true);
		expect(rows.some((row) => row.source_path === "discord://guild/223456789012345678")).toBe(true);
	});

	it("indexes forum and media parent channels without fetching parent message history", async () => {
		const requested: string[] = [];
		globalThis.fetch = mock((url: string | URL | Request) => {
			const text = String(url);
			requested.push(text);
			if (text.includes("/guilds/123456789012345678?with_counts=true")) {
				return Promise.resolve(Response.json({ id: "123456789012345678", name: "Guild A" }));
			}
			if (text.includes("/guilds/123456789012345678/channels")) {
				return Promise.resolve(
					Response.json([
						{ id: "123456789012345679", type: DISCORD_CHANNEL_TYPES.guildForum, name: "ideas" },
						{ id: "123456789012345680", type: DISCORD_CHANNEL_TYPES.guildMedia, name: "clips" },
					]),
				);
			}
			if (text.includes("/guilds/123456789012345678/threads/active")) {
				return Promise.resolve(
					Response.json({
						threads: [
							{
								id: "123456789012345681",
								type: DISCORD_CHANNEL_TYPES.publicThread,
								name: "threaded-post",
								parent_id: "123456789012345679",
							},
						],
					}),
				);
			}
			if (text.includes("/threads/archived/")) return Promise.resolve(Response.json({ threads: [], has_more: false }));
			if (text.includes("/thread-members")) return Promise.resolve(Response.json([]));
			if (text.includes("/messages?")) {
				return Promise.resolve(
					Response.json([
						{
							id: "999999999999999999",
							type: 0,
							channel_id: "123456789012345681",
							content: "forum thread body",
							author: { id: "123456789012345682", username: "alice" },
							timestamp: "2026-01-02T00:00:00.000Z",
						},
					]),
				);
			}
			if (text.includes("/members?")) return Promise.resolve(Response.json([]));
			return Promise.resolve(Response.json([]));
		}) as typeof fetch;
		const added = addDiscordSource(
			{ guildIds: ["123456789012345678"], tokenRef: "DISCORD_BOT_TOKEN", now: "2026-01-01T00:00:00.000Z" },
			dir,
		);
		expect(added.ok).toBe(true);
		if (added.ok === false) throw new Error(added.error);

		const result = await discordSourceProvider.sync?.({
			source: added.source,
			agentsDir: dir,
			agentId: "default",
			shouldContinue: () => true,
		});

		expect(result?.failures).toEqual([]);
		expect(requested.some((url) => url.includes("/channels/123456789012345679/messages"))).toBe(false);
		expect(requested.some((url) => url.includes("/channels/123456789012345680/messages"))).toBe(false);
		expect(requested.some((url) => url.includes("/channels/123456789012345681/messages"))).toBe(true);
		const rows = sourceRows(added.source.id);
		expect(
			rows.some((row) => row.source_path === "discord://guild/123456789012345678/channel/123456789012345679"),
		).toBe(true);
		expect(
			rows.some((row) => row.source_path === "discord://guild/123456789012345678/channel/123456789012345681"),
		).toBe(true);
		expect(rows.map((row) => row.source_kind)).toContain("source_discord_message_window");
	});

	it("allows channel filters to target active threads directly by id or name", async () => {
		const requested: string[] = [];
		globalThis.fetch = mock((url: string | URL | Request) => {
			const text = String(url);
			requested.push(text);
			if (text.includes("/guilds/123456789012345678?with_counts=true")) {
				return Promise.resolve(Response.json({ id: "123456789012345678", name: "Guild A" }));
			}
			if (text.includes("/guilds/123456789012345678/channels")) {
				return Promise.resolve(
					Response.json([{ id: "123456789012345679", type: DISCORD_CHANNEL_TYPES.guildText, name: "general" }]),
				);
			}
			if (text.includes("/guilds/123456789012345678/threads/active")) {
				return Promise.resolve(
					Response.json({
						threads: [
							{
								id: "123456789012345680",
								type: DISCORD_CHANNEL_TYPES.publicThread,
								name: "target-by-id",
								parent_id: "123456789012345679",
							},
							{
								id: "123456789012345681",
								type: DISCORD_CHANNEL_TYPES.publicThread,
								name: "target-by-name",
								parent_id: "123456789012345679",
							},
							{
								id: "123456789012345682",
								type: DISCORD_CHANNEL_TYPES.publicThread,
								name: "not-targeted",
								parent_id: "123456789012345679",
							},
						],
					}),
				);
			}
			if (text.includes("/channels/123456789012345680/messages")) {
				return Promise.resolve(
					Response.json([
						{
							id: "999999999999999990",
							type: 0,
							channel_id: "123456789012345680",
							content: "thread selected by id",
							author: { id: "123456789012345683", username: "alice" },
							timestamp: "2026-01-02T00:00:00.000Z",
						},
					]),
				);
			}
			if (text.includes("/channels/123456789012345681/messages")) {
				return Promise.resolve(
					Response.json([
						{
							id: "999999999999999991",
							type: 0,
							channel_id: "123456789012345681",
							content: "thread selected by name",
							author: { id: "123456789012345684", username: "bob" },
							timestamp: "2026-01-02T00:00:00.000Z",
						},
					]),
				);
			}
			if (text.includes("/thread-members")) return Promise.resolve(Response.json([]));
			if (text.includes("/members?")) return Promise.resolve(Response.json([]));
			return Promise.resolve(Response.json([]));
		}) as typeof fetch;
		const added = addDiscordSource(
			{
				guildIds: ["123456789012345678"],
				tokenRef: "DISCORD_BOT_TOKEN",
				channelFilter: ["123456789012345680", "target-by-name"],
				now: "2026-01-01T00:00:00.000Z",
			},
			dir,
		);
		expect(added.ok).toBe(true);
		if (added.ok === false) throw new Error(added.error);

		const result = await discordSourceProvider.sync?.({
			source: added.source,
			agentsDir: dir,
			agentId: "default",
			shouldContinue: () => true,
		});

		expect(result?.failures).toEqual([]);
		expect(requested.some((url) => url.includes("/channels/123456789012345679/messages"))).toBe(false);
		expect(requested.some((url) => url.includes("/channels/123456789012345680/messages"))).toBe(true);
		expect(requested.some((url) => url.includes("/channels/123456789012345681/messages"))).toBe(true);
		expect(requested.some((url) => url.includes("/channels/123456789012345682/messages"))).toBe(false);
		const rows = sourceRows(added.source.id);
		expect(
			rows.some((row) => row.source_path === "discord://guild/123456789012345678/channel/123456789012345680"),
		).toBe(true);
		expect(
			rows.some((row) => row.source_path === "discord://guild/123456789012345678/channel/123456789012345681"),
		).toBe(true);
		expect(
			rows.some((row) => row.source_path === "discord://guild/123456789012345678/channel/123456789012345682"),
		).toBe(false);
	});

	it("orders checkpoint cursors by numeric Discord snowflake value", async () => {
		globalThis.fetch = mock((url: string | URL | Request) => {
			const text = String(url);
			if (text.includes("/guilds/123456789012345678?with_counts=true")) {
				return Promise.resolve(Response.json({ id: "123456789012345678", name: "Guild A" }));
			}
			if (text.includes("/guilds/123456789012345678/channels")) {
				return Promise.resolve(
					Response.json([{ id: "123456789012345679", type: DISCORD_CHANNEL_TYPES.guildText, name: "general" }]),
				);
			}
			if (text.includes("/channels/123456789012345679/messages")) {
				return Promise.resolve(
					Response.json([
						{
							id: "99",
							type: 0,
							channel_id: "123456789012345679",
							content: "older numeric cursor",
							author: { id: "123456789012345680", username: "alice" },
							timestamp: "2015-01-01T00:00:00.000Z",
						},
						{
							id: "1000",
							type: 0,
							channel_id: "123456789012345679",
							content: "newer numeric cursor",
							author: { id: "123456789012345681", username: "bob" },
							timestamp: "2015-01-01T00:00:01.000Z",
						},
					]),
				);
			}
			if (text.includes("/members?")) return Promise.resolve(Response.json([]));
			if (text.includes("/threads/active")) return Promise.resolve(Response.json({ threads: [] }));
			return Promise.resolve(Response.json([]));
		}) as typeof fetch;
		const added = addDiscordSource(
			{ guildIds: ["123456789012345678"], tokenRef: "DISCORD_BOT_TOKEN", now: "2026-01-01T00:00:00.000Z" },
			dir,
		);
		expect(added.ok).toBe(true);
		if (added.ok === false) throw new Error(added.error);

		const result = await discordSourceProvider.sync?.({
			source: added.source,
			agentsDir: dir,
			agentId: "default",
			shouldContinue: () => true,
		});

		expect(result?.failures).toEqual([]);
		const rows = sourceRows(added.source.id);
		const window = rows.find((row) => row.source_kind === "source_discord_message_window");
		expect(window?.source_path).toContain("/messages/99-1000");
		expect(window?.source_meta_json).toContain('"oldestMessageId":"99"');
		expect(window?.source_meta_json).toContain('"newestMessageId":"1000"');
		const checkpoint = rows.find((row) => row.source_kind === "source_discord_checkpoint");
		expect(checkpoint?.source_meta_json).toContain('"latestCursor":"1000"');
		expect(checkpoint?.source_meta_json).toContain('"backfillCursor":"99"');
	});

	it("resumes routine message sync from the latest checkpoint cursor without purging older rows", async () => {
		const requestedMessages: string[] = [];
		let channelFetches = 0;
		globalThis.fetch = mock((url: string | URL | Request) => {
			const text = String(url);
			if (text.includes("/guilds/123456789012345678?with_counts=true")) {
				return Promise.resolve(Response.json({ id: "123456789012345678", name: "Guild A" }));
			}
			if (text.includes("/guilds/123456789012345678/channels")) {
				channelFetches++;
				const channels = [{ id: "123456789012345679", type: DISCORD_CHANNEL_TYPES.guildText, name: "general" }];
				if (channelFetches > 1)
					channels.push({ id: "123456789012345680", type: DISCORD_CHANNEL_TYPES.guildText, name: "new-channel" });
				return Promise.resolve(Response.json(channels));
			}
			if (text.includes("/channels/123456789012345680/messages")) {
				requestedMessages.push(text);
				return Promise.resolve(
					Response.json([
						{
							id: "2000",
							type: 0,
							channel_id: "123456789012345680",
							content: "new channel authoritative row",
							author: { id: "123456789012345682", username: "cara" },
							timestamp: "2015-01-01T00:00:02.000Z",
						},
					]),
				);
			}
			if (text.includes("/channels/123456789012345679/messages")) {
				requestedMessages.push(text);
				if (text.includes("after=1001")) return Promise.resolve(Response.json([]));
				if (text.includes("after=1000")) {
					return Promise.resolve(
						Response.json([
							{
								id: "1001",
								type: 0,
								channel_id: "123456789012345679",
								content: "new checkpoint delta",
								author: { id: "123456789012345681", username: "bob" },
								timestamp: "2015-01-01T00:00:01.000Z",
							},
						]),
					);
				}
				return Promise.resolve(
					Response.json([
						{
							id: "1000",
							type: 0,
							channel_id: "123456789012345679",
							content: "existing checkpoint baseline",
							author: { id: "123456789012345680", username: "alice" },
							timestamp: "2015-01-01T00:00:00.000Z",
						},
					]),
				);
			}
			if (text.includes("/members?")) return Promise.resolve(Response.json([]));
			if (text.includes("/threads/active")) return Promise.resolve(Response.json({ threads: [] }));
			return Promise.resolve(Response.json([]));
		}) as typeof fetch;
		const added = addDiscordSource(
			{
				guildIds: ["123456789012345678"],
				tokenRef: "DISCORD_BOT_TOKEN",
				maxMessagesPerChannel: 10,
				now: "2026-01-01T00:00:00.000Z",
			},
			dir,
		);
		expect(added.ok).toBe(true);
		if (added.ok === false) throw new Error(added.error);

		const first = await discordSourceProvider.sync?.({
			source: added.source,
			agentsDir: dir,
			agentId: "default",
			shouldContinue: () => true,
		});
		indexExternalMemoryArtifact({
			agentId: "default",
			harness: "discord",
			sourceId: added.source.id,
			sourceRoot: added.source.root,
			sourceExternalId: "member:123456789012345678:stale",
			sourcePath: "discord://guild/123456789012345678/member/stale",
			sourceKind: "source_discord_member",
			sourceMtimeMs: Date.parse("2025-01-01T00:00:00.000Z"),
			content: "stale member row",
		});
		indexExternalMemoryArtifact({
			agentId: "default",
			harness: "discord",
			sourceId: added.source.id,
			sourceRoot: added.source.root,
			sourceExternalId: "message:removed-channel",
			sourcePath: "discord://guild/123456789012345678/channel/removed/messages/stale",
			sourceKind: "source_discord_message",
			sourceMtimeMs: Date.parse("2025-01-01T00:00:00.000Z"),
			content: "stale removed channel message",
		});
		indexExternalMemoryArtifact({
			agentId: "default",
			harness: "discord",
			sourceId: added.source.id,
			sourceRoot: added.source.root,
			sourceExternalId: "message:new-channel-stale",
			sourcePath: "discord://guild/123456789012345678/channel/123456789012345680/messages/stale",
			sourceKind: "source_discord_message",
			sourceMtimeMs: Date.parse("2025-01-01T00:00:00.000Z"),
			content: "stale new channel message",
		});
		getDbAccessor().withWriteTx((db) => {
			db.prepare(
				`UPDATE memory_artifacts
				 SET updated_at = ?
				 WHERE source_id = ?
				   AND content IN (?, ?, ?)`,
			).run(
				"2025-01-01T00:00:00.000Z",
				added.source.id,
				"stale member row",
				"stale removed channel message",
				"stale new channel message",
			);
		});
		const second = await discordSourceProvider.sync?.({
			source: added.source,
			agentsDir: dir,
			agentId: "default",
			shouldContinue: () => true,
		});
		const third = await discordSourceProvider.sync?.({
			source: added.source,
			agentsDir: dir,
			agentId: "default",
			shouldContinue: () => true,
		});

		expect(first?.failures).toEqual([]);
		expect(second?.failures).toEqual([]);
		expect(third?.failures).toEqual([]);
		expect(requestedMessages.some((url) => url.includes("after=1000"))).toBe(true);
		expect(requestedMessages.some((url) => url.includes("after=1001"))).toBe(true);
		const rows = sourceRows(added.source.id);
		expect(rows.some((row) => row.content.includes("existing checkpoint baseline"))).toBe(true);
		expect(rows.some((row) => row.content.includes("new checkpoint delta"))).toBe(true);
		expect(rows.some((row) => row.content.includes("new channel authoritative row"))).toBe(true);
		expect(rows.some((row) => row.content === "stale member row")).toBe(false);
		expect(rows.some((row) => row.content === "stale removed channel message")).toBe(false);
		expect(rows.some((row) => row.content === "stale new channel message")).toBe(false);
		const checkpoint = rows.find((row) => row.source_kind === "source_discord_checkpoint");
		expect(checkpoint?.source_meta_json).toContain('"latestCursor":"1001"');
		expect(checkpoint?.source_meta_json).toContain('"backfillCursor":"1000"');
	});

	it("purges source-owned Discord artifacts and generic chunks by source id", async () => {
		const added = addDiscordSource(
			{ guildIds: ["123456789012345678"], tokenRef: "DISCORD_BOT_TOKEN", now: "2026-01-01T00:00:00.000Z" },
			dir,
		);
		expect(added.ok).toBe(true);
		if (added.ok === false) throw new Error(added.error);
		indexExternalMemoryArtifact({
			agentId: "default",
			harness: "discord",
			sourceId: added.source.id,
			sourceRoot: added.source.root,
			sourceExternalId: "guild:123456789012345678",
			sourcePath: "discord://guild/123456789012345678",
			sourceKind: "source_discord_guild",
			sourceMtimeMs: Date.now(),
			content: "guild",
		});
		getDbAccessor().withWriteTx((db) => {
			db.prepare(
				`INSERT INTO embeddings
				 (id, content_hash, vector, dimensions, source_type, source_id, chunk_text, created_at, agent_id)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			).run(
				"discord-chunk",
				"discord-hash",
				new Uint8Array([0]),
				1,
				"source_chunk",
				`${added.source.id}:guild/123456789012345678#0`,
				"chunk",
				"2026-01-01T00:00:00.000Z",
				"default",
			);
		});

		const purged = discordSourceProvider.purge(added.source, "default");

		expect(purged).toBeGreaterThanOrEqual(2);
		expect(sourceRows(added.source.id)).toEqual([]);
		expect(
			getDbAccessor().withReadDb(
				(db) =>
					(
						db
							.prepare("SELECT COUNT(*) AS count FROM embeddings WHERE source_id LIKE ?")
							.get(`${added.source.id}:%`) as { count: number }
					).count,
			),
		).toBe(0);
	});
});

function discordResponse(url: string): Response {
	if (url.includes("/guilds/123456789012345678?with_counts=true")) {
		return Response.json({ id: "123456789012345678", name: "Guild A", description: "Primary guild" });
	}
	if (url.includes("/guilds/223456789012345678?with_counts=true")) {
		return Response.json({ id: "223456789012345678", name: "Guild B" });
	}
	if (url.includes("/guilds/123456789012345678/channels")) {
		return Response.json([
			{ id: "123456789012345677", type: 4, name: "category" },
			{ id: "123456789012345679", type: 0, name: "general", parent_id: "123456789012345677", topic: "chat" },
			{ id: "323456789012345678", type: 0, name: "random" },
		]);
	}
	if (url.includes("/guilds/223456789012345678/channels")) {
		return Response.json([{ id: "223456789012345679", type: 0, name: "general" }]);
	}
	if (url.includes("/members?")) {
		return Response.json([
			{ user: { id: "123456789012345681", username: "alice", global_name: "Alice" }, roles: ["role1"] },
		]);
	}
	if (url.includes("/threads/active")) {
		const guildId = url.includes("223456789012345678") ? "223456789012345678" : "123456789012345678";
		return Response.json({
			threads: [
				{ id: `${guildId.slice(0, 15)}980`, type: 11, name: "active-thread", parent_id: `${guildId.slice(0, 15)}679` },
			],
		});
	}
	if (url.includes("/threads/archived/public")) {
		return Response.json({
			threads: [
				{
					id: "123456789012345980",
					type: 10,
					name: "announcement-thread",
					parent_id: "123456789012345679",
					thread_metadata: { archived: true, archive_timestamp: "2026-01-01T00:00:00.000Z" },
				},
			],
			has_more: false,
		});
	}
	if (url.includes("/threads/archived/private")) {
		return Response.json({
			threads: [
				{
					id: "123456789012345981",
					type: 12,
					name: "private-thread",
					parent_id: "123456789012345679",
					thread_metadata: { archived: true, archive_timestamp: "2026-01-01T00:00:00.000Z" },
				},
			],
			has_more: false,
		});
	}
	if (url.includes("/thread-members")) {
		return Response.json([{ id: "123456789012345980", user_id: "123456789012345681" }]);
	}
	if (url.includes("/messages?")) {
		const channelId = /channels\/([^/]+)\/messages/.exec(url)?.[1] ?? "123456789012345679";
		return Response.json([
			{
				id: "999999999999999999",
				type: 0,
				channel_id: channelId,
				content: "hello <@123456789012345682>",
				author: { id: "123456789012345681", username: "alice", global_name: "Alice" },
				message_reference: { message_id: "999999999999999998", channel_id: channelId, guild_id: "123456789012345678" },
				mentions: [{ id: "123456789012345682", username: "bob", global_name: "Bob" }],
				mention_roles: ["123456789012345683"],
				timestamp: "2026-01-02T00:00:00.000Z",
				edited_timestamp: "2026-01-02T00:01:00.000Z",
				pinned: true,
				attachments: [
					{
						id: "123456789012345684",
						filename: "context.txt",
						url: "https://cdn.discordapp.example/context.txt",
						size: 42,
						content_type: "text/plain",
					},
				],
				embeds: [{ title: "Embed title", description: "Embed body", fields: [{ name: "field", value: "value" }] }],
				poll: { question: { text: "Ship it?" }, answers: [{ answer_id: 1, poll_media: { text: "yes" } }] },
			},
		]);
	}
	return Response.json([]);
}

function sourceRows(
	sourceId: string,
): Array<{ source_kind: string; source_path: string; source_meta_json: string | null; content: string }> {
	return getDbAccessor().withReadDb(
		(db) =>
			db
				.prepare(
					`SELECT source_kind, source_path, source_meta_json, content
					 FROM memory_artifacts
					 WHERE source_id = ?
					 ORDER BY source_path ASC`,
				)
				.all(sourceId) as Array<{
				source_kind: string;
				source_path: string;
				source_meta_json: string | null;
				content: string;
			}>,
	);
}

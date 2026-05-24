import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addDiscordSource } from "@signet/core";
import { closeDbAccessor, getDbAccessor, initDbAccessor } from "./db-accessor";
import { discordSourceProvider } from "./discord-source-provider";
import { indexExternalMemoryArtifact } from "./memory-lineage";
import { putSecret } from "./secrets";

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
		expect(rows.map((row) => row.source_kind)).toContain("source_discord_mention");
		expect(rows.map((row) => row.source_kind)).toContain("source_discord_attachment");
		expect(rows.map((row) => row.source_kind)).toContain("source_discord_embed");
		expect(rows.map((row) => row.source_kind)).toContain("source_discord_poll");
		expect(rows.map((row) => row.source_kind)).toContain("source_discord_checkpoint");
		expect(rows.some((row) => row.source_path.includes("/channel/323456789012345678"))).toBe(false);
		const attachment = rows.find((row) => row.source_kind === "source_discord_attachment");
		expect(attachment?.source_meta_json).toContain('"urlPresent":true');
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
				mentions: [{ id: "123456789012345682", username: "bob", global_name: "Bob" }],
				mention_roles: ["123456789012345683"],
				timestamp: "2026-01-02T00:00:00.000Z",
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

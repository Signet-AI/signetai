import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SignetSourceEntry } from "../../core/src/sources-config";
import { closeDbAccessor, getDbAccessor, initDbAccessor } from "./db-accessor";
import { vectorToBlob } from "./db-helpers";
import { syncDiscordSource } from "./discord-source-bridge";
import { putSecret, resetSecretExecJobsForTests } from "./secrets.js";

const originalFetch = globalThis.fetch;
const originalSignetPath = process.env.SIGNET_PATH;
let agentsDir = "";

describe("syncDiscordSource", () => {
	beforeEach(() => {
		agentsDir = mkdtempSync(join(tmpdir(), "signet-discord-source-"));
		process.env.SIGNET_PATH = agentsDir;
		mkdirSync(agentsDir, { recursive: true });
		initDbAccessor(join(agentsDir, "memories.db"));
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
		resetSecretExecJobsForTests();
		closeDbAccessor();
		if (originalSignetPath === undefined) Reflect.deleteProperty(process.env, "SIGNET_PATH");
		else process.env.SIGNET_PATH = originalSignetPath;
	});

	it("reports skipped syncs when no Discord token can be resolved", async () => {
		const source: SignetSourceEntry = {
			id: "discord:test",
			kind: "discord",
			name: "Discord",
			root: "",
			enabled: true,
			mode: "read-only",
			createdAt: "2026-01-01T00:00:00.000Z",
			updatedAt: "2026-01-01T00:00:00.000Z",
			settings: { guildIds: ["123456789012345678"], tokenRef: "MISSING_SECRET" },
		};

		const result = await syncDiscordSource(source, { agentsDir });
		expect(result).toEqual({ indexed: 0, syncedGuilds: 0 });
	});

	it("treats accessible but empty guilds as a successful sync", async () => {
		await putSecret("DISCORD_BOT_TOKEN", "discord-secret");
		const source: SignetSourceEntry = {
			id: "discord:test",
			kind: "discord",
			name: "Discord",
			root: "",
			enabled: true,
			mode: "read-only",
			createdAt: "2026-01-01T00:00:00.000Z",
			updatedAt: "2026-01-01T00:00:00.000Z",
			settings: { guildIds: ["123456789012345678"], tokenRef: "DISCORD_BOT_TOKEN" },
		};

		globalThis.fetch = mock((input: string | URL | Request) => {
			const url = String(input);
			if (url.endsWith("/guilds/123456789012345678")) {
				return Promise.resolve(Response.json({ id: "123456789012345678", name: "Guild" }));
			}
			if (url.endsWith("/guilds/123456789012345678/channels")) {
				return Promise.resolve(Response.json([]));
			}
			if (url.endsWith("/guilds/123456789012345678/threads/active")) {
				return Promise.resolve(Response.json({ threads: [] }));
			}
			throw new Error(`Unexpected fetch: ${url}`);
		}) as typeof fetch;

		const result = await syncDiscordSource(source, { agentsDir });
		expect(result).toEqual({ indexed: 0, syncedGuilds: 1 });
	});

	it("purges stale channel embeddings when a refreshed channel becomes empty or embeddings are disabled", async () => {
		await putSecret("DISCORD_BOT_TOKEN", "discord-secret");
		const source: SignetSourceEntry = {
			id: "discord:test",
			kind: "discord",
			name: "Discord",
			root: "",
			enabled: true,
			mode: "read-only",
			createdAt: "2026-01-01T00:00:00.000Z",
			updatedAt: "2026-01-01T00:00:00.000Z",
			settings: {
				guildIds: ["123456789012345678"],
				tokenRef: "DISCORD_BOT_TOKEN",
				maxMessagesPerChannel: 50,
			},
		};

		globalThis.fetch = mock((input: string | URL | Request) => {
			const url = String(input);
			if (url.endsWith("/guilds/123456789012345678")) {
				return Promise.resolve(Response.json({ id: "123456789012345678", name: "Guild" }));
			}
			if (url.endsWith("/guilds/123456789012345678/channels")) {
				return Promise.resolve(Response.json([{ id: "channel1", type: 0, name: "general" }]));
			}
			if (url.endsWith("/guilds/123456789012345678/threads/active")) {
				return Promise.resolve(Response.json({ threads: [] }));
			}
			if (url.includes("/channels/channel1/threads/archived/public")) {
				return Promise.resolve(Response.json({ threads: [], has_more: false }));
			}
			if (url.includes("/channels/channel1/messages")) {
				return Promise.resolve(Response.json([]));
			}
			throw new Error(`Unexpected fetch: ${url}`);
		}) as typeof fetch;

		const embeddingConfig = {
			provider: "openai",
			model: "text-embedding-3-small",
			dimensions: 3,
		} as const;
		const fetchEmbedding = async () => [0.1, 0.2, 0.3];

		getDbAccessor().withWriteTx((db) => {
			db.prepare(
				`INSERT INTO embeddings
				 (id, content_hash, vector, dimensions, source_type, source_id, chunk_text, created_at, agent_id)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			).run(
				"stale-discord-embedding",
				"stale-discord-hash",
				vectorToBlob([0.1, 0.2, 0.3]),
				3,
				"source_discord_chunk",
				"discord:test:guild:123456789012345678:channel:channel1:messages#old:0",
				"stale Discord source chunk",
				"2026-05-23T16:00:00.000Z",
				"default",
			);
		});
		let rows = getDbAccessor().withReadDb(
			(db) =>
				db.prepare("SELECT id FROM embeddings WHERE source_type = 'source_discord_chunk'").all() as Array<{
					id: string;
				}>,
		);
		expect(rows).toHaveLength(1);

		await syncDiscordSource(source, {
			agentsDir,
			embeddingConfig: { ...embeddingConfig, provider: "none" },
			fetchEmbedding,
		});
		rows = getDbAccessor().withReadDb(
			(db) =>
				db.prepare("SELECT id FROM embeddings WHERE source_type = 'source_discord_chunk'").all() as Array<{
					id: string;
				}>,
		);
		expect(rows).toHaveLength(0);
	});
});

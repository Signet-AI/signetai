import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addDiscordSource, addObsidianSource, loadSourcesConfig } from "@signet/core";
import { Hono } from "hono";
import { closeDbAccessor, getDbAccessor, initDbAccessor } from "../db-accessor";
import { hashNormalizedBody } from "../memory-lineage";
import type { NativeMemoryBridgeHandle, NativeMemoryBridgeOptions, NativeMemorySource } from "../native-memory-sources";
import {
	beginSourceIndexJob,
	clearSourceIndexProgressForTests,
	completeSourceIndexJob,
	completeSourceIndexJobFromProgress,
	getSourceIndexJob,
	markSourceIndexInFlight,
	markSourceIndexJobRunning,
	updateSourceIndexJobProgress,
} from "../source-index-progress";
import { registerSourcesRoutes } from "./sources-routes";

const originalFetch = globalThis.fetch;

describe("Sources routes", () => {
	let dir = "";
	let vault = "";
	let previousSignetPath: string | undefined;
	let previousSignetAgentId: string | undefined;

	beforeEach(() => {
		clearSourceIndexProgressForTests();
		dir = mkdtempSync(join(tmpdir(), "signet-sources-routes-"));
		vault = join(dir, "vault");
		mkdirSync(join(vault, "permanent"), { recursive: true });
		writeFileSync(join(vault, "permanent", "Note.md"), "# Note\n\nRoute test source note.");
		previousSignetPath = process.env.SIGNET_PATH;
		previousSignetAgentId = process.env.SIGNET_AGENT_ID;
		process.env.SIGNET_PATH = dir;
		Reflect.deleteProperty(process.env, "SIGNET_AGENT_ID");
		mkdirSync(join(dir, "memory"), { recursive: true });
		closeDbAccessor();
		initDbAccessor(join(dir, "memory", "memories.db"));
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
		clearSourceIndexProgressForTests();
		closeDbAccessor();
		if (previousSignetPath === undefined) Reflect.deleteProperty(process.env, "SIGNET_PATH");
		else process.env.SIGNET_PATH = previousSignetPath;
		if (previousSignetAgentId === undefined) Reflect.deleteProperty(process.env, "SIGNET_AGENT_ID");
		else process.env.SIGNET_AGENT_ID = previousSignetAgentId;
		rmSync(dir, { recursive: true, force: true });
	});

	function makeApp(
		options: {
			indexed?: number;
			purged?: number;
			syncGate?: Promise<void>;
			onPurge?: () => void;
			onSyncStart?: () => void;
		} = {},
	): Hono {
		const app = new Hono();
		registerSourcesRoutes(app, {
			agentsDir: dir,
			startBridge: (sources: readonly NativeMemorySource[], bridgeOptions: NativeMemoryBridgeOptions) => {
				expect(sources).toHaveLength(1);
				expect(sources[0]?.sourceId).toStartWith("obsidian:");
				expect(bridgeOptions.yieldEveryFiles).toBe(1);
				expect(bridgeOptions.embeddingConfig).toBeUndefined();
				expect(bridgeOptions.fetchEmbedding).toBeUndefined();
				expect(bridgeOptions.sourceCleanupEnabled).toBe(false);
				expect(bridgeOptions.sourceGraphEnabled).toBe(false);
				return {
					syncExisting: async () => {
						options.onSyncStart?.();
						if (options.syncGate) await options.syncGate;
						bridgeOptions.onFileIndexed?.({
							source: sources[0] as NativeMemorySource,
							filePath: join(vault, "permanent", "Note.md"),
							indexed: true,
							scanned: 1,
							total: 1,
							changed: options.indexed ?? 1,
						});
						return options.indexed ?? 1;
					},
					close: async () => {},
				} satisfies NativeMemoryBridgeHandle;
			},
			purgeNativeSource: (source, agentId) => {
				expect(source.sourceId).toStartWith("obsidian:");
				expect(agentId).toBe(process.env.SIGNET_AGENT_ID?.trim() || "default");
				options.onPurge?.();
				return options.purged ?? 7;
			},
		});
		return app;
	}

	async function waitFor(predicate: () => boolean): Promise<void> {
		for (let attempt = 0; attempt < 50; attempt++) {
			if (predicate()) return;
			await Bun.sleep(10);
		}
		throw new Error("Timed out waiting for condition");
	}

	it("lists no configured sources by default", async () => {
		const res = await makeApp().request("/api/sources");
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ version: 1, sources: [] });
	});

	it("connects an Obsidian source, queues indexing, and records lastIndexedAt after the job finishes", async () => {
		const res = await makeApp({ indexed: 3 }).request("/api/sources/obsidian", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ path: vault, name: "Route Vault" }),
		});

		expect(res.status).toBe(202);
		const body = (await res.json()) as {
			created: boolean;
			indexed: number;
			queued: boolean;
			source: { id: string; root: string };
		};
		expect(body.created).toBe(true);
		expect(body.indexed).toBe(0);
		expect(body.queued).toBe(true);
		expect(body.source.root).toBe(vault);

		await waitFor(() => !!loadSourcesConfig(dir).sources[0]?.lastIndexedAt);
		expect(loadSourcesConfig(dir).sources[0]?.id).toBe(body.source.id);
	});

	it("connects a Discord source through provider-neutral source config", async () => {
		const res = await makeApp().request("/api/sources/discord", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				guildIds: ["123456789012345678"],
				tokenRef: "DISCORD_BOT_TOKEN",
				name: "Route Discord",
				channelFilter: ["general"],
				maxMessagesPerChannel: 25,
			}),
		});

		expect(res.status).toBe(202);
		const body = (await res.json()) as {
			source: { kind: string; providerSettings?: { tokenRef?: string } };
			queued: boolean;
		};
		expect(body.queued).toBe(true);
		expect(body.source.kind).toBe("discord");
		expect(body.source.providerSettings?.tokenRef).toBe("DISCORD_BOT_TOKEN");
		expect(loadSourcesConfig(dir).sources[0]?.kind).toBe("discord");
	});

	it("connects a Discord Desktop cache source without a bot token", async () => {
		const cachePath = join(dir, "discord");
		mkdirSync(join(cachePath, "Local Storage", "leveldb"), { recursive: true });
		writeFileSync(
			join(cachePath, "Local Storage", "leveldb", "000001.log"),
			`https://discord.com/channels/@me/111111111111111111
{"id":"333333333333333333","channel_id":"111111111111111111","content":"route dm message","timestamp":"2026-04-23T18:20:43Z","author":{"id":"222222222222222222","username":"alice"}}`,
		);

		const res = await makeApp().request("/api/sources/discord", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				name: "Route Discord Cache",
				desktopCachePath: cachePath,
				syncMode: "desktop-cache",
			}),
		});

		expect(res.status).toBe(202);
		const body = (await res.json()) as {
			source: { id: string; kind: string; providerSettings?: { syncMode?: string; desktopCachePath?: string } };
			queued: boolean;
		};
		expect(body.queued).toBe(true);
		expect(body.source.id.startsWith("discord-cache:")).toBe(true);
		expect(body.source.providerSettings?.syncMode).toBe("desktop-cache");
		expect(body.source.providerSettings?.desktopCachePath).toBe(cachePath);
		await waitFor(() => !!loadSourcesConfig(dir).sources[0]?.lastIndexedAt);
		expect(
			getDbAccessor().withReadDb(
				(db) =>
					(
						db
							.prepare("SELECT COUNT(*) AS count FROM memory_artifacts WHERE source_id = ? AND source_path LIKE ?")
							.get(body.source.id, "discord-cache://guild/@me/%") as { count: number }
					).count,
			),
		).toBeGreaterThan(0);
	});

	it("connects a GitHub source through provider-neutral source config", async () => {
		globalThis.fetch = mock((url: string | URL | Request) => {
			const text = String(url);
			if (text.endsWith("/repos/Signet-AI/signetai")) {
				return Promise.resolve(
					Response.json({ name: "signetai", full_name: "Signet-AI/signetai", default_branch: "main" }),
				);
			}
			if (text.includes("/issues?") || text.includes("/pulls?")) return Promise.resolve(Response.json([]));
			if (text.includes("/contents/")) return Promise.resolve(new Response("missing", { status: 404 }));
			return Promise.resolve(Response.json([]));
		}) as typeof fetch;

		const res = await makeApp().request("/api/sources/github", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				repos: ["Signet-AI/signetai"],
				name: "Route GitHub",
				resourceTypes: ["issues", "docs"],
				maxItemsPerRepo: 5,
			}),
		});

		expect(res.status).toBe(202);
		const body = (await res.json()) as {
			source: { kind: string; providerSettings?: { repos?: string[] } };
			queued: boolean;
		};
		expect(body.queued).toBe(true);
		expect(body.source.kind).toBe("github");
		expect(body.source.providerSettings?.repos).toEqual(["Signet-AI/signetai"]);
		expect(loadSourcesConfig(dir).sources[0]?.kind).toBe("github");
	});

	it("rejects raw Discord tokens at the route boundary", async () => {
		const res = await makeApp().request("/api/sources/discord", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				guildIds: ["123456789012345678"],
				tokenRef: "MzI0NzY5ODEwMDc4NzQ3NjY4.GbM8rb.fakeFakeFakeFakeFakeFakeFakeFake",
			}),
		});

		expect(res.status).toBe(400);
		expect(((await res.json()) as { error: string }).error).toContain("not a raw token");
	});

	it("rejects raw GitHub tokens at the route boundary", async () => {
		const res = await makeApp().request("/api/sources/github", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				repos: ["Signet-AI/signetai"],
				tokenRef: `github_pat_${"a".repeat(60)}`,
			}),
		});

		expect(res.status).toBe(400);
		expect(((await res.json()) as { error: string }).error).toContain("not a raw token");
		expect(loadSourcesConfig(dir).sources).toHaveLength(0);
	});

	it("does not block the connect response on a slow Obsidian source scan", async () => {
		let releaseScan = () => {};
		const syncGate = new Promise<void>((resolve) => {
			releaseScan = resolve;
		});
		const res = await makeApp({ indexed: 3, syncGate }).request("/api/sources/obsidian", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ path: vault, name: "Slow Vault" }),
		});

		expect(res.status).toBe(202);
		expect(loadSourcesConfig(dir).sources[0]?.lastIndexedAt).toBeUndefined();

		releaseScan();
		await waitFor(() => !!loadSourcesConfig(dir).sources[0]?.lastIndexedAt);
	});

	it("purges again when a disconnected source still has an in-flight index job", async () => {
		let releaseScan = () => {};
		let purges = 0;
		let scanStarted = false;
		const syncGate = new Promise<void>((resolve) => {
			releaseScan = resolve;
		});
		const app = makeApp({ syncGate, onPurge: () => purges++, onSyncStart: () => (scanStarted = true) });
		const added = (await (
			await app.request("/api/sources/obsidian", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ path: vault, name: "Disconnecting Vault" }),
			})
		).json()) as { source: { id: string } };
		await waitFor(() => scanStarted);

		const res = await app.request(`/api/sources/${encodeURIComponent(added.source.id)}`, { method: "DELETE" });
		expect(res.status).toBe(200);
		expect(purges).toBe(1);

		releaseScan();
		await waitFor(() => purges === 2);
		expect(loadSourcesConfig(dir).sources).toHaveLength(0);
	});

	it("runs a reconnect job after the disconnected source scan finishes", async () => {
		let releaseFirstScan = () => {};
		let syncCalls = 0;
		let purges = 0;
		const firstScanGate = new Promise<void>((resolve) => {
			releaseFirstScan = resolve;
		});
		const app = new Hono();
		registerSourcesRoutes(app, {
			agentsDir: dir,
			startBridge: (sources: readonly NativeMemorySource[], bridgeOptions: NativeMemoryBridgeOptions) => {
				syncCalls++;
				const call = syncCalls;
				return {
					syncExisting: async () => {
						if (call === 1) await firstScanGate;
						bridgeOptions.onFileIndexed?.({
							source: sources[0] as NativeMemorySource,
							filePath: join(vault, "permanent", "Note.md"),
							indexed: true,
							scanned: 1,
							total: 1,
							changed: call,
						});
						return call;
					},
					close: async () => {},
				} satisfies NativeMemoryBridgeHandle;
			},
			purgeNativeSource: () => {
				purges++;
				return 1;
			},
		});
		const first = (await (
			await app.request("/api/sources/obsidian", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ path: vault, name: "Reconnect Vault" }),
			})
		).json()) as { source: { id: string } };
		await waitFor(() => syncCalls === 1);

		expect(
			(await app.request(`/api/sources/${encodeURIComponent(first.source.id)}`, { method: "DELETE" })).status,
		).toBe(200);
		expect(purges).toBe(1);
		const reconnect = (await (
			await app.request("/api/sources/obsidian", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ path: vault, name: "Reconnect Vault" }),
			})
		).json()) as { source: { id: string } };
		expect(reconnect.source.id).toBe(first.source.id);

		releaseFirstScan();
		await waitFor(() => syncCalls === 2);
		await waitFor(() => loadSourcesConfig(dir).sources[0]?.lastIndexedAt !== undefined);

		const sources = (await (await app.request("/api/sources")).json()) as {
			sources: Array<{ indexJob?: { indexed?: number; status?: string } }>;
		};
		expect(sources.sources[0]?.indexJob).toMatchObject({ indexed: 2, status: "complete" });
		expect(purges).toBe(2);
	});

	it("purges tombstoned disconnected source artifacts when routes register after restart", async () => {
		let releaseScan = () => {};
		let scanStarted = false;
		let runtimePurges = 0;
		let startupPurges = 0;
		const syncGate = new Promise<void>((resolve) => {
			releaseScan = resolve;
		});
		const app = makeApp({ syncGate, onPurge: () => runtimePurges++, onSyncStart: () => (scanStarted = true) });
		const added = (await (
			await app.request("/api/sources/obsidian", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ path: vault, name: "Restart Cleanup Vault" }),
			})
		).json()) as { source: { id: string } };
		await waitFor(() => scanStarted);

		expect(
			(await app.request(`/api/sources/${encodeURIComponent(added.source.id)}`, { method: "DELETE" })).status,
		).toBe(200);
		expect(runtimePurges).toBe(1);

		const restarted = new Hono();
		registerSourcesRoutes(restarted, {
			agentsDir: dir,
			purgeNativeSource: () => {
				startupPurges++;
				return 1;
			},
		});
		expect(startupPurges).toBe(1);

		releaseScan();
		await waitFor(() => runtimePurges === 2);
	});

	it("reports source chunk stats using source-owned chunk id prefixes", async () => {
		const added = addObsidianSource({ root: vault, name: "Stats Vault" }, dir);
		expect(added.ok).toBe(true);
		if (added.ok === false) throw new Error(added.error);

		getDbAccessor().withWriteTx((db) => {
			db.prepare(
				`INSERT INTO memory_artifacts
				 (agent_id, source_path, source_sha256, source_kind, session_id, session_token, harness, captured_at, content, updated_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			).run(
				"default",
				join(vault, "permanent", "Note.md"),
				"sha",
				"source_obsidian_markdown",
				"session",
				"token",
				"obsidian",
				"2026-01-01T00:00:00.000Z",
				"# Note",
				"2026-01-01T00:00:00.000Z",
			);
			db.prepare(
				`INSERT INTO embeddings
				 (id, content_hash, vector, dimensions, source_type, source_id, chunk_text, created_at, agent_id)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			).run(
				"chunk-1",
				"chunk-hash-1",
				new Uint8Array([0]),
				1,
				"source_chunk",
				`${added.source.id}:permanent/Note.md#overview:1-3:0`,
				"source chunk",
				"2026-01-01T00:00:00.000Z",
				"default",
			);
		});

		const res = await makeApp().request("/api/sources");
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			sources: Array<{
				stats?: { artifacts: number; chunks: number; indexed: number };
				health?: { status?: string; purge?: { orphanChunks?: number } };
			}>;
		};
		expect(body.sources[0]?.stats).toEqual({ artifacts: 1, chunks: 1, indexed: 1 });
		expect(body.sources[0]?.health).toMatchObject({
			status: "healthy",
			purge: { orphanChunks: 0 },
		});
	});

	it("reports generic source stats for Discord source-owned artifacts and chunks", async () => {
		const added = addDiscordSource(
			{ guildIds: ["123456789012345678"], tokenRef: "DISCORD_BOT_TOKEN", name: "Stats Discord" },
			dir,
		);
		expect(added.ok).toBe(true);
		if (added.ok === false) throw new Error(added.error);

		getDbAccessor().withWriteTx((db) => {
			db.prepare(
				`INSERT INTO memory_artifacts
				 (agent_id, source_path, source_sha256, source_kind, source_id, source_root, session_id, session_token, harness, captured_at, content, updated_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			).run(
				"default",
				"discord://guild/123456789012345678",
				"sha",
				"source_discord_guild",
				added.source.id,
				added.source.root,
				"session",
				"token",
				"discord",
				"2026-01-01T00:00:00.000Z",
				"Guild",
				"2026-01-01T00:00:00.000Z",
			);
			db.prepare(
				`INSERT INTO embeddings
				 (id, content_hash, vector, dimensions, source_type, source_id, chunk_text, created_at, agent_id)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			).run(
				"discord-chunk-1",
				"discord-chunk-hash-1",
				new Uint8Array([0]),
				1,
				"source_chunk",
				`${added.source.id}:guild/123456789012345678#overview:1-3:0`,
				"discord source chunk",
				"2026-01-01T00:00:00.000Z",
				"default",
			);
		});

		const res = await makeApp().request("/api/sources");
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			sources: Array<{ stats?: { artifacts: number; chunks: number; indexed: number } }>;
		};
		expect(body.sources[0]?.stats).toEqual({ artifacts: 1, chunks: 1, indexed: 1 });
	});

	it("exports source snapshots while excluding local Discord cache DMs by default", async () => {
		const added = addDiscordSource(
			{
				name: "Snapshot Discord",
				desktopCachePath: join(dir, "discord"),
				syncMode: "desktop-cache",
			},
			dir,
		);
		expect(added.ok).toBe(true);
		if (added.ok === false) throw new Error(added.error);

		insertSourceArtifact({
			sourceId: added.source.id,
			sourceRoot: added.source.root,
			sourcePath: "discord-cache://guild/123/channel/456/message/789",
			sourceKind: "source_discord_message",
			content: "public cached message",
			metaJson: JSON.stringify({ guildId: "123", channelId: "456" }),
		});
		insertSourceArtifact({
			sourceId: added.source.id,
			sourceRoot: added.source.root,
			sourcePath: "discord-cache://guild/@me/channel/111/message/222",
			sourceKind: "source_discord_message",
			content: "private dm message",
			metaJson: JSON.stringify({ guildId: "@me", channelId: "111" }),
		});

		const res = await makeApp().request(`/api/sources/${encodeURIComponent(added.source.id)}/snapshot`);
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			artifacts: Array<{ sourcePath: string; content: string }>;
			skipped?: { localDiscordArtifacts?: number };
		};
		expect(body.artifacts).toHaveLength(1);
		expect(body.artifacts[0]?.content).toBe("public cached message");
		expect(body.artifacts[0]?.sourcePath).not.toContain("@me");
		expect(body.skipped?.localDiscordArtifacts).toBe(1);

		const local = await makeApp().request(
			`/api/sources/${encodeURIComponent(added.source.id)}/snapshot?includeLocalDiscord=true`,
		);
		const localBody = (await local.json()) as { artifacts: Array<{ sourcePath: string }> };
		expect(localBody.artifacts.map((artifact) => artifact.sourcePath)).toContain(
			"discord-cache://guild/@me/channel/111/message/222",
		);
	});

	it("imports source snapshots through existing source artifact provenance", async () => {
		const added = addDiscordSource(
			{ guildIds: ["123456789012345678"], tokenRef: "DISCORD_BOT_TOKEN", name: "Import Discord" },
			dir,
		);
		expect(added.ok).toBe(true);
		if (added.ok === false) throw new Error(added.error);

		insertSourceArtifact({
			sourceId: added.source.id,
			sourceRoot: added.source.root,
			sourcePath: "discord://guild/123/channel/456/message/stale",
			sourceKind: "source_discord_message",
			content: "stale message",
			metaJson: JSON.stringify({ guildId: "123", channelId: "456" }),
		});
		insertSourceChunk({
			id: "snapshot-stale-discord-chunk",
			sourceId: `${added.source.id}:guild/123/channel/456/message/stale#0`,
			chunkText: "source_path: discord://guild/123/channel/456/message/stale\n\nstale chunk",
		});
		const snapshot = {
			version: 1,
			exportedAt: "2026-05-24T00:00:00.000Z",
			source: { id: added.source.id, kind: "discord", name: "Import Discord", root: added.source.root },
			agentId: "default",
			artifacts: [
				sourceSnapshotArtifact({
					sourceId: added.source.id,
					sourceRoot: added.source.root,
					sourcePath: "discord://guild/123/channel/456/message/fresh",
					sourceKind: "source_discord_message",
					content: "fresh imported message",
					metaJson: JSON.stringify({ guildId: "123", channelId: "456" }),
				}),
			],
			skipped: { localDiscordArtifacts: 0 },
		};

		const res = await makeApp().request(`/api/sources/${encodeURIComponent(added.source.id)}/snapshot/import`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(snapshot),
		});
		expect(res.status).toBe(200);
		expect((await res.json()) as { imported: number }).toMatchObject({ imported: 1 });

		const rows = getDbAccessor().withReadDb(
			(db) =>
				db
					.prepare("SELECT source_path, content FROM memory_artifacts WHERE source_id = ? ORDER BY source_path")
					.all(added.source.id) as Array<{ source_path: string; content: string }>,
		);
		expect(rows).toEqual([
			{ source_path: "discord://guild/123/channel/456/message/fresh", content: "fresh imported message" },
		]);
		expect(sourceChunkRows(added.source.id)).toEqual([]);
	});

	it("preserves local Discord cache DM artifacts during default snapshot import", async () => {
		const added = addDiscordSource(
			{
				name: "Preserve Local Discord",
				desktopCachePath: join(dir, "discord"),
				syncMode: "desktop-cache",
			},
			dir,
		);
		expect(added.ok).toBe(true);
		if (added.ok === false) throw new Error(added.error);

		insertSourceArtifact({
			sourceId: added.source.id,
			sourceRoot: added.source.root,
			sourcePath: "discord-cache://guild/@me/channel/111/message/local",
			sourceKind: "source_discord_message",
			content: "local dm should remain",
			metaJson: JSON.stringify({ guildId: "@me", channelId: "111" }),
		});
		insertSourceArtifact({
			sourceId: added.source.id,
			sourceRoot: added.source.root,
			sourcePath: "discord-cache://guild/123/channel/456/message/stale",
			sourceKind: "source_discord_message",
			content: "stale public cache",
			metaJson: JSON.stringify({ guildId: "123", channelId: "456" }),
		});
		insertSourceChunk({
			id: "snapshot-local-discord-chunk",
			sourceId: `${added.source.id}:discord-cache://guild/@me/channel/111/message/local#0`,
			chunkText: "source_path: discord-cache://guild/@me/channel/111/message/local\n\nlocal dm chunk",
		});
		insertSourceChunk({
			id: "snapshot-public-discord-chunk",
			sourceId: `${added.source.id}:discord-cache://guild/123/channel/456/message/stale#0`,
			chunkText: "source_path: discord-cache://guild/123/channel/456/message/stale\n\nstale public chunk",
		});

		const snapshot = {
			version: 1,
			exportedAt: "2026-05-24T00:00:00.000Z",
			source: { id: added.source.id, kind: "discord", name: "Preserve Local Discord", root: added.source.root },
			agentId: "default",
			artifacts: [
				sourceSnapshotArtifact({
					sourceId: added.source.id,
					sourceRoot: added.source.root,
					sourcePath: "discord-cache://guild/123/channel/456/message/fresh",
					sourceKind: "source_discord_message",
					content: "fresh public cache",
					metaJson: JSON.stringify({ guildId: "123", channelId: "456" }),
				}),
				sourceSnapshotArtifact({
					sourceId: added.source.id,
					sourceRoot: added.source.root,
					sourcePath: "discord-cache://guild/@me/channel/111/message/imported",
					sourceKind: "source_discord_message",
					content: "imported dm should be skipped",
					metaJson: JSON.stringify({ guildId: "@me", channelId: "111" }),
				}),
			],
			skipped: { localDiscordArtifacts: 0 },
		};

		const res = await makeApp().request(`/api/sources/${encodeURIComponent(added.source.id)}/snapshot/import`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(snapshot),
		});
		expect(res.status).toBe(200);
		expect((await res.json()) as { imported: number; skipped: { localDiscordArtifacts: number } }).toMatchObject({
			imported: 1,
			skipped: { localDiscordArtifacts: 1 },
		});
		const rows = getDbAccessor().withReadDb(
			(db) =>
				db
					.prepare("SELECT source_path, content FROM memory_artifacts WHERE source_id = ? ORDER BY source_path")
					.all(added.source.id) as Array<{ source_path: string; content: string }>,
		);
		expect(rows).toEqual([
			{ source_path: "discord-cache://guild/123/channel/456/message/fresh", content: "fresh public cache" },
			{ source_path: "discord-cache://guild/@me/channel/111/message/local", content: "local dm should remain" },
		]);
		expect(sourceChunkRows(added.source.id)).toEqual([
			{
				id: "snapshot-local-discord-chunk",
				source_id: `${added.source.id}:discord-cache://guild/@me/channel/111/message/local#0`,
			},
		]);
	});

	it("rejects source snapshots that would overwrite another source path", async () => {
		const added = addDiscordSource(
			{ guildIds: ["123456789012345678"], tokenRef: "DISCORD_BOT_TOKEN", name: "Import Conflict Discord" },
			dir,
		);
		expect(added.ok).toBe(true);
		if (added.ok === false) throw new Error(added.error);

		insertSourceArtifact({
			sourceId: "obsidian:other",
			sourceRoot: vault,
			sourcePath: "discord://guild/123/channel/456/message/shared",
			sourceKind: "source_obsidian_markdown",
			content: "other source content",
			metaJson: JSON.stringify({ provider: "obsidian" }),
		});
		const snapshot = {
			version: 1,
			exportedAt: "2026-05-24T00:00:00.000Z",
			source: { id: added.source.id, kind: "discord", name: "Import Conflict Discord", root: added.source.root },
			agentId: "default",
			artifacts: [
				sourceSnapshotArtifact({
					sourceId: added.source.id,
					sourceRoot: added.source.root,
					sourcePath: "discord://guild/123/channel/456/message/shared",
					sourceKind: "source_discord_message",
					content: "attacker controlled content",
					metaJson: JSON.stringify({ guildId: "123", channelId: "456" }),
				}),
			],
			skipped: { localDiscordArtifacts: 0 },
		};

		const res = await makeApp().request(`/api/sources/${encodeURIComponent(added.source.id)}/snapshot/import`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(snapshot),
		});
		expect(res.status).toBe(400);
		expect(((await res.json()) as { error: string }).error).toContain("already owned by another source");
		const row = getDbAccessor().withReadDb(
			(db) =>
				db
					.prepare("SELECT source_id, content FROM memory_artifacts WHERE source_path = ?")
					.get("discord://guild/123/channel/456/message/shared") as { source_id: string; content: string },
		);
		expect(row).toEqual({ source_id: "obsidian:other", content: "other source content" });
	});

	it("rejects source snapshot import while indexing is active", async () => {
		const added = addDiscordSource(
			{ guildIds: ["123456789012345678"], tokenRef: "DISCORD_BOT_TOKEN", name: "Busy Import Discord" },
			dir,
		);
		expect(added.ok).toBe(true);
		if (added.ok === false) throw new Error(added.error);

		const job = beginSourceIndexJob(added.source.id);
		markSourceIndexJobRunning(added.source.id, job.id);
		markSourceIndexInFlight(added.source.id);

		const res = await makeApp().request(`/api/sources/${encodeURIComponent(added.source.id)}/snapshot/import`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({}),
		});

		expect(res.status).toBe(409);
		expect(((await res.json()) as { error: string }).error).toContain("cannot run while source indexing");
	});

	it("reserves the source while snapshot import is parsing", async () => {
		const added = addDiscordSource(
			{ guildIds: ["123456789012345678"], tokenRef: "DISCORD_BOT_TOKEN", name: "Reserved Import Discord" },
			dir,
		);
		expect(added.ok).toBe(true);
		if (added.ok === false) throw new Error(added.error);

		const snapshot = {
			version: 1,
			exportedAt: "2026-05-24T00:00:00.000Z",
			source: { id: added.source.id, kind: "discord", name: "Reserved Import Discord", root: added.source.root },
			agentId: "default",
			artifacts: [],
			skipped: { localDiscordArtifacts: 0 },
		};
		let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
		const body = new ReadableStream<Uint8Array>({
			start(next) {
				controller = next;
			},
		});
		const app = makeApp();
		const first = app.request(
			new Request(`http://localhost/api/sources/${encodeURIComponent(added.source.id)}/snapshot/import`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body,
				duplex: "half",
			} as RequestInit & { duplex: "half" }),
		);

		const second = await app.request(`/api/sources/${encodeURIComponent(added.source.id)}/snapshot/import`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(snapshot),
		});
		expect(second.status).toBe(409);

		controller?.enqueue(new TextEncoder().encode(JSON.stringify(snapshot)));
		controller?.close();
		expect((await first).status).toBe(200);
	});

	it("surfaces background source sync progress in the sources response", async () => {
		const added = addObsidianSource({ root: vault, name: "Background Vault" }, dir);
		expect(added.ok).toBe(true);
		if (added.ok === false) throw new Error(added.error);

		const job = beginSourceIndexJob(added.source.id, "source-startup");
		markSourceIndexJobRunning(added.source.id, job.id);
		updateSourceIndexJobProgress(added.source.id, job.id, {
			scanned: 3,
			total: 10,
			indexed: 2,
			currentPath: join(vault, "permanent", "Note.md"),
		});

		const res = await makeApp().request("/api/sources");
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			sources: Array<{ indexJob?: { status?: string; scanned?: number; total?: number; indexed?: number } }>;
		};
		expect(body.sources[0]?.indexJob).toMatchObject({ status: "running", scanned: 3, total: 10, indexed: 2 });

		completeSourceIndexJob(added.source.id, job.id, 2);
		updateSourceIndexJobProgress(added.source.id, job.id, {
			scanned: 4,
			total: 10,
			indexed: 3,
			currentPath: join(vault, "permanent", "Note.md"),
		});
		const completed = (await (await makeApp().request("/api/sources")).json()) as {
			sources: Array<{ indexJob?: { status?: string; scanned?: number; indexed?: number } }>;
		};
		expect(completed.sources[0]?.indexJob).toMatchObject({ status: "complete", scanned: 3, indexed: 2 });
	});

	it("reports source health diagnostics from artifacts, chunks, failures, and checkpoints", async () => {
		const added = addDiscordSource(
			{
				guildIds: ["123456789012345678"],
				tokenRef: "DISCORD_BOT_TOKEN",
				name: "Health Discord",
			},
			dir,
		);
		expect(added.ok).toBe(true);
		if (added.ok === false) throw new Error(added.error);

		insertSourceArtifact({
			sourceId: added.source.id,
			sourceRoot: added.source.root,
			sourcePath: "discord://guild/123/channel/456/message/789",
			sourceKind: "source_discord_message",
			content: "health test message",
			metaJson: "{}",
		});
		insertSourceArtifact({
			sourceId: added.source.id,
			sourceRoot: added.source.root,
			sourcePath: `discord://source/${added.source.id}/checkpoint/123/456`,
			sourceKind: "source_discord_checkpoint",
			content: "partial checkpoint",
			metaJson: JSON.stringify({ status: "partial", recordType: "checkpoint" }),
		});
		insertSourceArtifact({
			sourceId: added.source.id,
			sourceRoot: added.source.root,
			sourcePath: `discord://source/${added.source.id}/failure/rate-limit`,
			sourceKind: "source_discord_failure",
			content: "recoverable failure",
			metaJson: JSON.stringify({ recoverable: true, status: 429 }),
		});
		insertSourceChunk({
			id: "health-discord-chunk",
			sourceId: `${added.source.id}:discord://guild/123/channel/456/message/789#0`,
			chunkText: "health test message",
		});

		const res = await makeApp().request("/api/sources");
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			sources: Array<{
				stats?: { artifacts?: number; chunks?: number };
				health?: {
					status?: string;
					failures?: { total?: number; recoverable?: number };
					checkpoints?: { total?: number; partial?: number };
					latestArtifactAt?: string | null;
					latestCheckpointAt?: string | null;
				};
			}>;
		};
		expect(body.sources[0]?.stats).toMatchObject({ artifacts: 3, chunks: 1 });
		expect(body.sources[0]?.health).toMatchObject({
			status: "degraded",
			failures: { total: 1, recoverable: 1 },
			checkpoints: { total: 1, partial: 1 },
		});
		expect(body.sources[0]?.health?.latestArtifactAt).toBe("2026-05-24T00:00:00.000Z");
		expect(body.sources[0]?.health?.latestCheckpointAt).toBe("2026-05-24T00:00:00.000Z");

		const healthRes = await makeApp().request(`/api/sources/${encodeURIComponent(added.source.id)}/health`);
		expect(healthRes.status).toBe(200);
		const healthBody = (await healthRes.json()) as {
			stats?: { artifacts?: number; chunks?: number };
			health?: { status?: string; failures?: { total?: number }; checkpoints?: { partial?: number } };
		};
		expect(healthBody.stats).toMatchObject({ artifacts: 3, chunks: 1 });
		expect(healthBody.health).toMatchObject({
			status: "degraded",
			failures: { total: 1 },
			checkpoints: { partial: 1 },
		});
	});

	it("reports orphan source chunks when live artifacts still exist", async () => {
		const added = addDiscordSource(
			{
				guildIds: ["123456789012345678"],
				tokenRef: "DISCORD_BOT_TOKEN",
				name: "Orphan Chunk Discord",
			},
			dir,
		);
		expect(added.ok).toBe(true);
		if (added.ok === false) throw new Error(added.error);

		insertSourceArtifact({
			sourceId: added.source.id,
			sourceRoot: added.source.root,
			sourcePath: "discord://guild/123/channel/456/message/live",
			sourceKind: "source_discord_message",
			content: "live message",
			metaJson: "{}",
		});
		insertSourceChunk({
			id: "live-discord-chunk",
			sourceId: `${added.source.id}:guild/123/channel/456/message/live#0`,
			chunkText: "source_path: discord://guild/123/channel/456/message/live\n\nlive message",
		});
		insertSourceChunk({
			id: "orphan-discord-chunk",
			sourceId: `${added.source.id}:guild/123/channel/456/message/deleted#0`,
			chunkText: "deleted message",
		});

		const res = await makeApp().request(`/api/sources/${encodeURIComponent(added.source.id)}/health`);
		expect(res.status).toBe(200);
		const body = (await res.json()) as { health?: { status?: string; purge?: { orphanChunks?: number } } };
		expect(body.health).toMatchObject({
			status: "degraded",
			purge: { orphanChunks: 1 },
		});
	});

	it("degrades source health when only deleted artifact residue remains", async () => {
		const added = addDiscordSource(
			{
				guildIds: ["123456789012345678"],
				tokenRef: "DISCORD_BOT_TOKEN",
				name: "Deleted Residue Discord",
			},
			dir,
		);
		expect(added.ok).toBe(true);
		if (added.ok === false) throw new Error(added.error);

		insertSourceArtifact({
			sourceId: added.source.id,
			sourceRoot: added.source.root,
			sourcePath: "discord://guild/123/channel/456/message/deleted",
			sourceKind: "source_discord_message",
			content: "deleted message",
			metaJson: "{}",
		});
		getDbAccessor().withWriteTx((db) => {
			db.prepare("UPDATE memory_artifacts SET is_deleted = 1 WHERE source_id = ?").run(added.source.id);
		});

		const res = await makeApp().request(`/api/sources/${encodeURIComponent(added.source.id)}/health`);
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			stats?: { artifacts?: number; chunks?: number };
			health?: { status?: string; purge?: { deletedArtifacts?: number } };
		};
		expect(body.stats).toMatchObject({ artifacts: 0, chunks: 0 });
		expect(body.health).toMatchObject({
			status: "degraded",
			purge: { deletedArtifacts: 1 },
		});
	});

	it("returns a clear 404 for source health on an unknown source", async () => {
		const res = await makeApp().request("/api/sources/discord%3Amissing/health");
		expect(res.status).toBe(404);
		expect(((await res.json()) as { error: string }).error).toContain("Source not found");
	});

	it("marks source health unhealthy when diagnostics queries fail", async () => {
		const added = addDiscordSource(
			{
				guildIds: ["123456789012345678"],
				tokenRef: "DISCORD_BOT_TOKEN",
				name: "Broken Health Discord",
			},
			dir,
		);
		expect(added.ok).toBe(true);
		if (added.ok === false) throw new Error(added.error);

		getDbAccessor().withWriteTx((db) => {
			db.prepare("DROP TABLE memory_artifacts").run();
		});

		const res = await makeApp().request(`/api/sources/${encodeURIComponent(added.source.id)}/health`);
		expect(res.status).toBe(200);
		const body = (await res.json()) as { health?: { status?: string; error?: string } };
		expect(body.health?.status).toBe("unhealthy");
		expect(body.health?.error).toContain("Source health diagnostics failed");
	});

	it("marks source health unhealthy when semantic diagnostics queries fail", async () => {
		const added = addDiscordSource(
			{
				guildIds: ["123456789012345678"],
				tokenRef: "DISCORD_BOT_TOKEN",
				name: "Broken Semantic Health Discord",
			},
			dir,
		);
		expect(added.ok).toBe(true);
		if (added.ok === false) throw new Error(added.error);

		getDbAccessor().withWriteTx((db) => {
			db.prepare("DROP TABLE entity_communities").run();
		});

		const res = await makeApp().request(`/api/sources/${encodeURIComponent(added.source.id)}/health`);
		expect(res.status).toBe(200);
		const body = (await res.json()) as { health?: { status?: string; error?: string } };
		expect(body.health?.status).toBe("unhealthy");
		expect(body.health?.error).toContain("Source health diagnostics failed");
	});

	it("completes startup source jobs from their own progress, not aggregate bridge counts", () => {
		const active = beginSourceIndexJob("obsidian:active", "source-startup");
		const empty = beginSourceIndexJob("obsidian:empty", "source-startup");
		markSourceIndexJobRunning("obsidian:active", active.id);
		markSourceIndexJobRunning("obsidian:empty", empty.id);
		updateSourceIndexJobProgress("obsidian:active", active.id, {
			scanned: 2,
			total: 2,
			indexed: 2,
			currentPath: join(vault, "permanent", "Note.md"),
		});

		completeSourceIndexJobFromProgress("obsidian:active", active.id);
		completeSourceIndexJobFromProgress("obsidian:empty", empty.id);

		expect(getSourceIndexJob("obsidian:active")?.indexed).toBe(2);
		expect(getSourceIndexJob("obsidian:empty")?.indexed).toBe(0);
	});

	it("disconnects a source, removes config, and returns purge count", async () => {
		const app = makeApp({ indexed: 1, purged: 9 });
		const added = (await (
			await app.request("/api/sources/obsidian", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ path: vault, name: "Route Vault" }),
			})
		).json()) as { source: { id: string } };

		const res = await app.request(`/api/sources/${encodeURIComponent(added.source.id)}`, { method: "DELETE" });
		expect(res.status).toBe(200);
		const body = (await res.json()) as { purged: number; source: { id: string } };
		expect(body.source.id).toBe(added.source.id);
		expect(body.purged).toBe(9);
		expect(loadSourcesConfig(dir).sources).toHaveLength(0);
	});

	it("returns a clear 404 for disconnecting an unknown source", async () => {
		const res = await makeApp().request("/api/sources/obsidian%3Amissing", { method: "DELETE" });
		expect(res.status).toBe(404);
		expect(((await res.json()) as { error: string }).error).toContain("Source not found");
	});

	function insertSourceArtifact(input: {
		sourceId: string;
		sourceRoot: string;
		sourcePath: string;
		sourceKind: string;
		content: string;
		metaJson: string;
	}): void {
		getDbAccessor().withWriteTx((db) => {
			db.prepare(
				`INSERT INTO memory_artifacts
				 (agent_id, source_path, source_sha256, source_kind, source_id, source_root,
				  source_external_id, source_meta_json, session_id, session_token, harness,
				  captured_at, content, updated_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			).run(
				"default",
				input.sourcePath,
				hashNormalizedBody(input.content),
				input.sourceKind,
				input.sourceId,
				input.sourceRoot,
				`artifact:${input.sourcePath}`,
				input.metaJson,
				`native:discord:${input.sourcePath}`,
				"snapshot-token",
				"discord",
				"2026-05-24T00:00:00.000Z",
				input.content,
				"2026-05-24T00:00:00.000Z",
			);
		});
	}

	function insertSourceChunk(input: { id: string; sourceId: string; chunkText: string }): void {
		getDbAccessor().withWriteTx((db) => {
			db.prepare(
				`INSERT INTO embeddings
				 (id, content_hash, vector, dimensions, source_type, source_id, chunk_text, created_at, agent_id)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			).run(
				input.id,
				`${input.id}-hash`,
				new Uint8Array([0]),
				1,
				"source_chunk",
				input.sourceId,
				input.chunkText,
				"2026-05-24T00:00:00.000Z",
				"default",
			);
		});
	}

	function sourceChunkRows(sourceId: string): Array<{ id: string; source_id: string }> {
		return getDbAccessor().withReadDb(
			(db) =>
				db
					.prepare(
						`SELECT id, source_id
						   FROM embeddings
						  WHERE agent_id = ?
						    AND source_type = ?
						    AND source_id >= ?
						    AND source_id < ?
						  ORDER BY id`,
					)
					.all("default", "source_chunk", `${sourceId}:`, `${sourceId}:\uffff`) as Array<{
					id: string;
					source_id: string;
				}>,
		);
	}

	function sourceSnapshotArtifact(input: {
		sourceId: string;
		sourceRoot: string;
		sourcePath: string;
		sourceKind: string;
		content: string;
		metaJson: string;
	}): Record<string, unknown> {
		return {
			sourcePath: input.sourcePath,
			sourceSha256: hashNormalizedBody(input.content),
			sourceKind: input.sourceKind,
			sessionId: `native:discord:${input.sourcePath}`,
			sessionKey: "native:discord",
			sessionToken: "snapshot-token",
			project: null,
			harness: "discord",
			capturedAt: "2026-05-24T00:00:00.000Z",
			startedAt: "2026-05-24T00:00:00.000Z",
			endedAt: "2026-05-24T00:00:00.000Z",
			manifestPath: null,
			sourceNodeId: null,
			memorySentence: "snapshot artifact",
			memorySentenceQuality: "fallback",
			content: input.content,
			updatedAt: "2026-05-24T00:00:00.000Z",
			sourceMtimeMs: Date.parse("2026-05-24T00:00:00.000Z"),
			sourceId: input.sourceId,
			sourceRoot: input.sourceRoot,
			sourceExternalId: `artifact:${input.sourcePath}`,
			sourceParentPath: null,
			sourceMetaJson: input.metaJson,
		};
	}
});

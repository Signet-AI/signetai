import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addObsidianSource, loadSourcesConfig } from "@signet/core";
import { Hono } from "hono";
import { closeDbAccessor, getDbAccessor, initDbAccessor } from "../db-accessor";
import type { NativeMemoryBridgeHandle, NativeMemoryBridgeOptions, NativeMemorySource } from "../native-memory-sources";
import {
	beginSourceIndexJob,
	clearSourceIndexProgressForTests,
	completeSourceIndexJob,
	completeSourceIndexJobFromProgress,
	getSourceIndexJob,
	markSourceIndexJobRunning,
	updateSourceIndexJobProgress,
} from "../source-index-progress";
import { registerSourcesRoutes } from "./sources-routes";

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
			sources: Array<{ stats?: { artifacts: number; chunks: number; indexed: number } }>;
		};
		expect(body.sources[0]?.stats).toEqual({ artifacts: 1, chunks: 1, indexed: 1 });
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
});

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addObsidianSource, loadSourcesConfig } from "@signet/core";
import { Hono } from "hono";
import { closeDbAccessor, getDbAccessor, initDbAccessor } from "../db-accessor";
import { loadMemoryConfig } from "../memory-config";
import type { NativeMemoryBridgeHandle, NativeMemorySource } from "../native-memory-sources";
import { registerSourcesRoutes } from "./sources-routes";

describe("Sources routes", () => {
	let dir = "";
	let vault = "";
	let previousSignetPath: string | undefined;
	let previousSignetAgentId: string | undefined;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "signet-sources-routes-"));
		vault = join(dir, "vault");
		mkdirSync(join(vault, "permanent"), { recursive: true });
		writeFileSync(join(vault, "permanent", "Note.md"), "# Note\n\nRoute test source note.");
		previousSignetPath = process.env.SIGNET_PATH;
		previousSignetAgentId = process.env.SIGNET_AGENT_ID;
		process.env.SIGNET_PATH = dir;
		Reflect.deleteProperty(process.env, "SIGNET_AGENT_ID");
		mkdirSync(join(dir, "memory"), { recursive: true });
		initDbAccessor(join(dir, "memory", "memories.db"));
	});

	afterEach(() => {
		closeDbAccessor();
		if (previousSignetPath === undefined) Reflect.deleteProperty(process.env, "SIGNET_PATH");
		else process.env.SIGNET_PATH = previousSignetPath;
		if (previousSignetAgentId === undefined) Reflect.deleteProperty(process.env, "SIGNET_AGENT_ID");
		else process.env.SIGNET_AGENT_ID = previousSignetAgentId;
		rmSync(dir, { recursive: true, force: true });
	});

	function makeApp(options: { indexed?: number; purged?: number } = {}): Hono {
		const app = new Hono();
		registerSourcesRoutes(app, {
			agentsDir: dir,
			loadMemoryConfig,
			startBridge: (sources: readonly NativeMemorySource[]) => {
				expect(sources).toHaveLength(1);
				expect(sources[0]?.sourceId).toStartWith("obsidian:");
				return {
					syncExisting: async () => options.indexed ?? 1,
					close: async () => {},
				} satisfies NativeMemoryBridgeHandle;
			},
			purgeNativeSource: (source, agentId) => {
				expect(source.sourceId).toStartWith("obsidian:");
				expect(agentId).toBe(process.env.SIGNET_AGENT_ID?.trim() || "default");
				return options.purged ?? 7;
			},
		});
		return app;
	}

	it("lists no configured sources by default", async () => {
		const res = await makeApp().request("/api/sources");
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ version: 1, sources: [] });
	});

	it("connects an Obsidian source, indexes it, and records lastIndexedAt", async () => {
		const res = await makeApp({ indexed: 3 }).request("/api/sources/obsidian", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ path: vault, name: "Route Vault" }),
		});

		expect(res.status).toBe(200);
		const body = (await res.json()) as { created: boolean; indexed: number; source: { id: string; root: string } };
		expect(body.created).toBe(true);
		expect(body.indexed).toBe(3);
		expect(body.source.root).toBe(vault);

		const stored = loadSourcesConfig(dir).sources[0];
		expect(stored?.id).toBe(body.source.id);
		expect(stored?.lastIndexedAt).toBeTruthy();
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
				"source_obsidian_chunk",
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

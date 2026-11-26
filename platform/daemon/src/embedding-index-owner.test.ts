import { Database } from "bun:sqlite";
import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { findSqliteVecExtension, runMigrations } from "@signet/core";
import { migrationFixtureDb } from "./test-support/migration-fixture-db";
import type { DbAccessor, WriteDb } from "./db-accessor";
import { createDbOwnerClient } from "./db-owner-client";
import { startEmbeddingIndexMigration } from "./embedding-index-migration";
import { ensureEmbeddingIndexState } from "./embedding-index-state";
import type { EmbeddingConfig } from "./memory-config";

const activeConfig: EmbeddingConfig = {
	provider: "ollama",
	model: "nomic-embed-text",
	dimensions: 4,
	base_url: "http://127.0.0.1:11434",
};
const stagingConfig: EmbeddingConfig = {
	...activeConfig,
	model: "qwen3-embedding:0.6b",
	dimensions: 2,
};

function ownerAccessor(): DbAccessor {
	return {
		withWriteTxAsync: async () => {
			throw new Error("owner test must not use the daemon write accessor");
		},
		withReadDbAsync: async () => {
			throw new Error("owner test must not use the daemon read accessor");
		},
		close: () => undefined,
	};
}

interface OwnerStateSnapshot {
	readonly state: string;
	readonly active_profile_json: string;
	readonly staging_profile_json: string | null;
	readonly last_error: string | null;
	readonly projection_cursor_last_id: string | null;
	readonly projection_cursor_slot: string | null;
	readonly staged_count: number;
}

function readOwnerState(path: string, extension: string): OwnerStateSnapshot {
	const database = new Database(path);
	database.exec("PRAGMA busy_timeout = 1000");
	database.loadExtension(extension);
	const state = database
		.prepare(
			"SELECT state, active_profile_json, staging_profile_json, last_error, projection_cursor_last_id, projection_cursor_slot, (SELECT count(*) FROM embeddings_staging) AS staged_count FROM embedding_index_state WHERE id = 1",
		)
		.get() as OwnerStateSnapshot;
	database.close();
	return state;
}

async function waitForOwnerState(
	path: string,
	extension: string,
	predicate: (state: OwnerStateSnapshot) => boolean,
	timeoutMs = 5_000,
): Promise<OwnerStateSnapshot> {
	const startedAt = Date.now();
	while (Date.now() - startedAt < timeoutMs) {
		const state = readOwnerState(path, extension);
		if (predicate(state)) return state;
		await new Promise<void>((resolve) => setTimeout(resolve, 5));
	}
	throw new Error("DB owner state did not reach the expected checkpoint");
}

describe("embedding index DB-owner routing", () => {
	let owner: ReturnType<typeof createDbOwnerClient> | null = null;
	let directory: string | null = null;

	afterEach(async () => {
		await owner?.close();
		owner = null;
		if (directory !== null) rmSync(directory, { recursive: true, force: true });
		directory = null;
	});

	it("recovers staged embeddings and atomically promotes without daemon SQLite calls", async () => {
		const extension = findSqliteVecExtension();
		if (extension === null) return;
		const rawDirectory = mkdtempSync(join(tmpdir(), "signet-embedding-owner-"));
		directory = rawDirectory;
		const path = join(rawDirectory, "memories.db");
		const raw = new Database(path);
		raw.exec("PRAGMA journal_mode = WAL");
		raw.loadExtension(extension);
		runMigrations(migrationFixtureDb(raw));
		raw.exec(`
			DROP TABLE IF EXISTS vec_embeddings;
			DROP TABLE IF EXISTS vec_embeddings_staging;
			CREATE VIRTUAL TABLE vec_embeddings USING vec0(id TEXT PRIMARY KEY, embedding FLOAT[4] distance_metric=cosine);
			CREATE VIRTUAL TABLE vec_embeddings_staging USING vec0(id TEXT PRIMARY KEY, embedding FLOAT[2] distance_metric=cosine);
			INSERT INTO agents(id,name,created_at,updated_at) VALUES('agent-a','A','now','now'),('agent-b','B','now','now');
		`);
		const insertMemory = raw.prepare(
			"INSERT INTO memories (id, content, type, agent_id, embedding_model, created_at, updated_at, updated_by) VALUES (?, ?, 'fact', ?, ?, 'now', 'now', 'fixture')",
		);
		const insertEmbedding = raw.prepare(
			"INSERT INTO embeddings(id,content_hash,vector,dimensions,source_type,source_id,chunk_text,created_at,agent_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
		);
		const insertProjection = raw.prepare("INSERT INTO vec_embeddings (id, embedding) VALUES (?, ?)");
		raw.exec("BEGIN");
		for (let index = 0; index < 205; index++) {
			const id = `memory-${index}`;
			const embeddingId = `embedding-${index}`;
			const agentId = index % 2 === 0 ? "agent-a" : "agent-b";
			insertMemory.run(id, `owner-routed embedding ${index}`, agentId, "nomic-embed-text");
			insertEmbedding.run(
				embeddingId,
				`hash-${index}`,
				new Float32Array([1, 0, 0, 0]),
				4,
				"memory",
				id,
				`owner-routed embedding ${index}`,
				"2026-01-01",
				agentId,
			);
			insertProjection.run(embeddingId, new Float32Array([1, 0, 0, 0]));
		}
		raw.exec("COMMIT");
		ensureEmbeddingIndexState(raw as unknown as WriteDb, activeConfig);
		raw.close();

		owner = createDbOwnerClient({ dbPath: path });
		const handle = await startEmbeddingIndexMigration({
			accessor: ownerAccessor(),
			configured: stagingConfig,
			fetchEmbedding: async () => [0.25, 0.75],
			checkProvider: async () => ({ available: true }),
			pollMs: 10,
			batchSize: 205,
			owner,
		});
		if (handle === null) throw new Error("owner migration did not start");
		let crashedDuringStaging = false;
		await waitForOwnerState(path, extension, (state) => {
			if (state.last_error) throw new Error(state.last_error);
			if (state.state !== "building" || state.staged_count <= 0 || state.staged_count >= 205) return false;
			const pid = owner?.health().pid;
			if (pid === null || pid === undefined) throw new Error("owner did not publish a pid before staging crash");
			process.kill(pid, "SIGKILL");
			crashedDuringStaging = true;
			return true;
		});
		expect(crashedDuringStaging).toBe(true);
		await waitForOwnerState(
			path,
			extension,
			(state) => state.state === "ready" && state.active_profile_json.includes(stagingConfig.model),
		);
		expect(owner.health().generation).toBeGreaterThan(1);
		await handle.stop();

		const verify = new Database(path);
		verify.loadExtension(extension);
		const state = verify
			.prepare(
				"SELECT state, active_profile_json, last_error, projection_cursor_last_id, projection_cursor_slot FROM embedding_index_state WHERE id = 1",
			)
			.get() as {
			state: string;
			active_profile_json: string;
			last_error: string | null;
			projection_cursor_last_id: string | null;
			projection_cursor_slot: string | null;
		};
		const active = JSON.parse(state.active_profile_json) as { model: string; dimensions: number };
		expect(state.state, state.last_error ?? "").toBe("ready");
		expect(active.model).toBe(stagingConfig.model);
		expect(active.dimensions).toBe(stagingConfig.dimensions);
		expect(state.projection_cursor_last_id).toBeNull();
		expect(state.projection_cursor_slot).toBeNull();
		expect(verify.prepare("SELECT COUNT(*) AS count FROM embeddings").get()).toEqual({ count: 205 });
		expect(verify.prepare("SELECT COUNT(*) AS count FROM embeddings_staging").get()).toEqual({ count: 205 });
		expect(verify.prepare("SELECT COUNT(*) AS count FROM vec_embeddings_staging").get()).toEqual({ count: 205 });
		expect(
			verify.prepare("SELECT agent_id, COUNT(*) AS count FROM embeddings GROUP BY agent_id ORDER BY agent_id").all(),
		).toEqual([
			{ agent_id: "agent-a", count: 103 },
			{ agent_id: "agent-b", count: 102 },
		]);
		verify.close();
	});

	it("recovers endpoint-only building state through the DB owner without losing active recall", async () => {
		const extension = findSqliteVecExtension();
		if (extension === null) return;
		const rawDirectory = mkdtempSync(join(tmpdir(), "signet-embedding-owner-endpoint-recovery-"));
		directory = rawDirectory;
		const path = join(rawDirectory, "memories.db");
		const oldConfig: EmbeddingConfig = {
			provider: "ollama",
			model: "custom-embed",
			dimensions: 3,
			base_url: "http://127.0.0.1:11434",
		};
		const currentConfig = { ...oldConfig, base_url: "http://192.168.1.10:11434" };
		const raw = new Database(path);
		raw.loadExtension(extension);
		raw.exec(`
			CREATE TABLE memories (id TEXT PRIMARY KEY, embedding_model TEXT);
			CREATE TABLE embeddings (id TEXT PRIMARY KEY, source_id TEXT);
			CREATE TABLE embeddings_staging (id TEXT PRIMARY KEY, source_id TEXT);
			CREATE TABLE embedding_index_state (
				id INTEGER PRIMARY KEY CHECK (id = 1), active_profile_json TEXT NOT NULL,
				staging_profile_json TEXT, state TEXT NOT NULL, last_error TEXT,
				created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
				migration_phase TEXT, progress_staged INTEGER NOT NULL DEFAULT 0,
				progress_total INTEGER NOT NULL DEFAULT 0, projection_cursor_last_id TEXT,
				projection_cursor_slot TEXT, no_progress_ticks INTEGER NOT NULL DEFAULT 0,
				provider_endpoint TEXT
			);
			CREATE VIRTUAL TABLE vec_embeddings USING vec0(id TEXT PRIMARY KEY, embedding FLOAT[3] distance_metric=cosine);
			CREATE VIRTUAL TABLE vec_embeddings_staging USING vec0(id TEXT PRIMARY KEY, embedding FLOAT[3] distance_metric=cosine);
		`);
		ensureEmbeddingIndexState(raw as unknown as WriteDb, oldConfig);
		const active = JSON.parse(
			(
				raw.prepare("SELECT active_profile_json FROM embedding_index_state WHERE id = 1").get() as {
					active_profile_json: string;
				}
			).active_profile_json,
		) as Record<string, unknown>;
		active.fingerprint = JSON.stringify({
			profile: "custom:ollama:custom-embed",
			provider: oldConfig.provider,
			model: oldConfig.model,
			dimensions: oldConfig.dimensions,
			baseUrl: oldConfig.base_url,
		});
		const staging = {
			...active,
			fingerprint: JSON.stringify({
				profile: "custom:ollama:custom-embed",
				provider: oldConfig.provider,
				model: oldConfig.model,
				dimensions: oldConfig.dimensions,
			}),
			baseUrl: currentConfig.base_url,
			projectionSlot: "staging",
			projectionRebuild: true,
		};
		raw
			.prepare(
				"UPDATE embedding_index_state SET active_profile_json = ?, staging_profile_json = ?, state = 'building' WHERE id = 1",
			)
			.run(JSON.stringify(active), JSON.stringify(staging));
		raw.exec(`
			INSERT INTO embeddings VALUES ('new', 'new-memory');
			INSERT INTO embeddings_staging VALUES ('old', 'old-memory');
		`);
		raw.prepare("INSERT INTO vec_embeddings (id, embedding) VALUES (?, ?)").run("old", new Float32Array([1, 0, 0]));
		raw
			.prepare("INSERT INTO vec_embeddings_staging (id, embedding) VALUES (?, ?)")
			.run("new", new Float32Array([0, 1, 0]));
		raw.close();

		owner = createDbOwnerClient({ dbPath: path });
		const handle = await startEmbeddingIndexMigration({
			accessor: ownerAccessor(),
			configured: currentConfig,
			fetchEmbedding: async () => [1, 0, 0],
			checkProvider: async () => ({ available: true }),
			pollMs: 10,
			batchSize: 1,
			owner,
		});
		expect(handle).toBeNull();
		const state = await waitForOwnerState(path, extension, (snapshot) => snapshot.state === "ready");
		expect(state.staging_profile_json).toBeNull();
		expect(JSON.parse(state.active_profile_json).baseUrl).toBe(currentConfig.base_url);

		const verify = new Database(path);
		verify.loadExtension(extension);
		expect(verify.prepare("SELECT id FROM embeddings").get()).toEqual({ id: "old" });
		expect(verify.prepare("SELECT COUNT(*) AS count FROM embeddings_staging").get()).toEqual({ count: 0 });
		expect(verify.prepare("SELECT id FROM vec_embeddings").get()).toEqual({ id: "old" });
		expect(verify.prepare("SELECT COUNT(*) AS count FROM vec_embeddings_staging").get()).toEqual({ count: 0 });
		verify.close();
	});

	it("routes provider exhaustion failure persistence through the owner", async () => {
		const extension = findSqliteVecExtension();
		if (extension === null) return;
		const rawDirectory = mkdtempSync(join(tmpdir(), "signet-embedding-owner-exhaustion-"));
		directory = rawDirectory;
		const path = join(rawDirectory, "memories.db");
		const raw = new Database(path);
		raw.loadExtension(extension);
		raw.exec(`
			CREATE TABLE embeddings (
				id TEXT PRIMARY KEY, content_hash TEXT UNIQUE, vector BLOB, dimensions INTEGER,
				source_type TEXT, source_id TEXT, chunk_text TEXT, created_at TEXT, agent_id TEXT
			);
			CREATE TABLE embeddings_staging (
				id TEXT PRIMARY KEY, content_hash TEXT UNIQUE, vector BLOB, dimensions INTEGER,
				source_type TEXT, source_id TEXT, chunk_text TEXT, created_at TEXT, agent_id TEXT
			);
			CREATE TABLE embedding_index_state (
				id INTEGER PRIMARY KEY CHECK (id = 1), active_profile_json TEXT NOT NULL,
				staging_profile_json TEXT, state TEXT NOT NULL, last_error TEXT,
				created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
				migration_phase TEXT, progress_staged INTEGER NOT NULL DEFAULT 0,
				progress_total INTEGER NOT NULL DEFAULT 0, projection_cursor_last_id TEXT,
				projection_cursor_slot TEXT, no_progress_ticks INTEGER NOT NULL DEFAULT 0,
				provider_endpoint TEXT
			);
			CREATE VIRTUAL TABLE vec_embeddings USING vec0(id TEXT PRIMARY KEY, embedding FLOAT[4] distance_metric=cosine);
			CREATE VIRTUAL TABLE vec_embeddings_staging USING vec0(id TEXT PRIMARY KEY, embedding FLOAT[2] distance_metric=cosine);
		`);
		ensureEmbeddingIndexState(raw as unknown as WriteDb, activeConfig);
		raw.close();

		owner = createDbOwnerClient({ dbPath: path });
		let providerChecks = 0;
		const handle = await startEmbeddingIndexMigration({
			accessor: ownerAccessor(),
			configured: stagingConfig,
			fetchEmbedding: async () => [0.25, 0.75],
			checkProvider: async () => {
				providerChecks++;
				return { available: false };
			},
			pollMs: 1,
			batchSize: 1,
			owner,
		});
		if (handle === null) throw new Error("owner exhaustion migration did not start");

		const state = await waitForOwnerState(path, extension, (snapshot) => snapshot.state === "failed");
		expect(providerChecks).toBeGreaterThanOrEqual(1);
		expect(JSON.parse(state.last_error ?? "{}").message).toBe(
			"Embedding provider unavailable after 6 consecutive checks; aborting the build",
		);
		await handle.stop();
	});
});

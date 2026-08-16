import { Database } from "bun:sqlite";
import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { findSqliteVecExtension } from "@signet/core";
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
}

function readOwnerState(path: string, extension: string): OwnerStateSnapshot {
	const database = new Database(path);
	database.exec("PRAGMA busy_timeout = 1000");
	database.loadExtension(extension);
	const state = database
		.prepare("SELECT state, active_profile_json, staging_profile_json FROM embedding_index_state WHERE id = 1")
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

	it("completes staging, projection rebuild, and promotion without daemon SQLite calls", async () => {
		const extension = findSqliteVecExtension();
		if (extension === null) return;
		const rawDirectory = mkdtempSync(join(tmpdir(), "signet-embedding-owner-"));
		directory = rawDirectory;
		const path = join(rawDirectory, "memories.db");
		const raw = new Database(path);
		raw.loadExtension(extension);
		raw.exec(`
			CREATE TABLE memories (id TEXT PRIMARY KEY, embedding_model TEXT);
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
				created_at TEXT NOT NULL, updated_at TEXT NOT NULL
			);
			CREATE VIRTUAL TABLE vec_embeddings USING vec0(id TEXT PRIMARY KEY, embedding FLOAT[4] distance_metric=cosine);
			CREATE VIRTUAL TABLE vec_embeddings_staging USING vec0(id TEXT PRIMARY KEY, embedding FLOAT[2] distance_metric=cosine);
		`);
		const insertMemory = raw.prepare("INSERT INTO memories (id, embedding_model) VALUES (?, ?)");
		const insertEmbedding = raw.prepare("INSERT INTO embeddings VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)");
		const insertProjection = raw.prepare("INSERT INTO vec_embeddings (id, embedding) VALUES (?, ?)");
		for (let index = 0; index < 205; index++) {
			const id = `memory-${index}`;
			const embeddingId = `embedding-${index}`;
			const agentId = index % 2 === 0 ? "agent-a" : "agent-b";
			insertMemory.run(id, "nomic-embed-text");
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
		let crashedDuringRebuild = false;
		await waitForOwnerState(path, extension, (state) => {
			if (state.staging_profile_json?.includes('"projectionRebuild":true') !== true) return false;
			const pid = owner?.health().pid;
			if (pid === null || pid === undefined) throw new Error("owner did not publish a pid before rebuild crash");
			process.kill(pid, "SIGKILL");
			crashedDuringRebuild = true;
			return true;
		});
		expect(crashedDuringRebuild).toBe(true);
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
			.prepare("SELECT state, active_profile_json, last_error FROM embedding_index_state WHERE id = 1")
			.get() as {
			state: string;
			active_profile_json: string;
			last_error: string | null;
		};
		const active = JSON.parse(state.active_profile_json) as { model: string; dimensions: number };
		expect(state.state, state.last_error ?? "").toBe("ready");
		expect(active.model).toBe(stagingConfig.model);
		expect(active.dimensions).toBe(stagingConfig.dimensions);
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
});

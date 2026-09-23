import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { up as embeddingIndexGenerations } from "../../core/src/migrations/091-embedding-index-generations";
import {
	beginEmbeddingIndexBuild,
	ensureEmbeddingIndexState,
	failEmbeddingIndexBuild,
	isActiveEmbeddingConfig,
	readEmbeddingIndexMigrationProgress,
	readEmbeddingIndexState,
	resolveActiveEmbeddingConfig,
} from "./embedding-index-state";
import type { WriteDb } from "./db-accessor";
import type { EmbeddingConfig } from "./memory-config";

const config: EmbeddingConfig = {
	provider: "native",
	model: "nomic-embed-text-v1.5",
	dimensions: 768,
	base_url: "",
};

describe("embedding index state", () => {
	it("seeds one legacy raw active profile and preserves it on later starts", () => {
		const raw = new Database(":memory:");
		embeddingIndexGenerations(raw as unknown as Parameters<typeof embeddingIndexGenerations>[0]);
		const db = raw as unknown as WriteDb;

		const initial = ensureEmbeddingIndexState(db, config, "2026-01-01T00:00:00.000Z");
		expect(initial.state).toBe("ready");
		expect(initial.active.profile).toBeUndefined();
		expect(initial.active.model).toBe("nomic-embed-text-v1.5");
		expect(readEmbeddingIndexState(db)).toEqual(initial);

		const changedConfig = { ...config, model: "qwen3-embedding:0.6b", dimensions: 1024 };
		const later = ensureEmbeddingIndexState(db, changedConfig, "2026-01-02T00:00:00.000Z");
		expect(later.active).toEqual(initial.active);
		expect(resolveActiveEmbeddingConfig(db, changedConfig)).toMatchObject({
			provider: "native",
			model: "nomic-embed-text-v1.5",
			dimensions: 768,
			profile: undefined,
		});
		expect(raw.prepare("SELECT COUNT(*) AS count FROM embedding_index_state").get() as { count: number }).toEqual({
			count: 1,
		});
	});

	it("builds Qwen in staging without changing the legacy active profile", () => {
		const raw = new Database(":memory:");
		embeddingIndexGenerations(raw as unknown as Parameters<typeof embeddingIndexGenerations>[0]);
		raw.exec(
			`CREATE TABLE embeddings_staging (id TEXT PRIMARY KEY, content_hash TEXT UNIQUE, vector BLOB, dimensions INTEGER, source_type TEXT, source_id TEXT, chunk_text TEXT, created_at TEXT, agent_id TEXT)`,
		);
		const db = raw as unknown as WriteDb;
		const active = ensureEmbeddingIndexState(db, config);
		const staged = beginEmbeddingIndexBuild(db, {
			...config,
			provider: "ollama",
			model: "qwen3-embedding:0.6b",
			dimensions: 1024,
		});

		expect(staged.state).toBe("building");
		expect(staged.active).toEqual(active.active);
		expect(staged.staging?.profile).toBe("qwen3-embedding");
		failEmbeddingIndexBuild(db, "provider unavailable");
		expect(ensureEmbeddingIndexState(db, config).state).toBe("failed");
		expect(ensureEmbeddingIndexState(db, config).active).toEqual(active.active);
	});

	it("keeps provider-unavailable failure durable across a file-backed restart until its retry time", () => {
		const dir = mkdtempSync(join(tmpdir(), "embedding-index-state-restart-"));
		const dbPath = join(dir, "memory.db");
		try {
			const first = new Database(dbPath);
			embeddingIndexGenerations(first as unknown as Parameters<typeof embeddingIndexGenerations>[0]);
			first.exec(
				"CREATE TABLE embeddings_staging (id TEXT PRIMARY KEY, content_hash TEXT UNIQUE, vector BLOB, dimensions INTEGER)",
			);
			const staged = beginEmbeddingIndexBuild(first as unknown as WriteDb, {
				...config,
				provider: "ollama",
				model: "qwen3-embedding:0.6b",
				dimensions: 1024,
			});
			first
				.prepare(
					"INSERT INTO embeddings_staging (id, content_hash, vector, dimensions) VALUES ('s1', 'h1', X'00', 1024)",
				)
				.run();
			failEmbeddingIndexBuild(first as unknown as WriteDb, "provider unavailable", "2026-01-01T00:00:00.000Z", {
				cause: "provider-unavailable",
				nextAttemptAt: "2026-01-02T00:00:00.000Z",
			});
			first.close();

			const reopened = new Database(dbPath);
			const reopenedDb = reopened as unknown as WriteDb;
			const persisted = readEmbeddingIndexState(reopenedDb);
			expect(persisted?.state).toBe("failed");
			expect(persisted?.staging?.fingerprint).toBe(staged.staging?.fingerprint);
			expect(
				JSON.parse(
					(
						reopened.prepare("SELECT last_error FROM embedding_index_state WHERE id = 1").get() as {
							last_error: string;
						}
					).last_error,
				).nextAttemptAt,
			).toBe("2026-01-02T00:00:00.000Z");
			expect(reopened.prepare("SELECT COUNT(*) AS n FROM embeddings_staging").get()).toEqual({ n: 1 });
			expect(
				beginEmbeddingIndexBuild(
					reopenedDb,
					{ ...config, provider: "ollama", model: "qwen3-embedding:0.6b", dimensions: 1024 },
					"2026-01-01T12:00:00.000Z",
				).state,
			).toBe("failed");
			reopened.close();

			const afterDeadline = new Database(dbPath);
			const resumed = beginEmbeddingIndexBuild(
				afterDeadline as unknown as WriteDb,
				{ ...config, provider: "ollama", model: "qwen3-embedding:0.6b", dimensions: 1024 },
				"2026-01-02T00:00:00.000Z",
			);
			expect(resumed.state).toBe("building");
			afterDeadline.close();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("stages unknown model changes with identity formatting instead of silently skipping them", () => {
		const raw = new Database(":memory:");
		embeddingIndexGenerations(raw as unknown as Parameters<typeof embeddingIndexGenerations>[0]);
		raw.exec(
			`CREATE TABLE embeddings_staging (id TEXT PRIMARY KEY, content_hash TEXT UNIQUE, vector BLOB, dimensions INTEGER, source_type TEXT, source_id TEXT, chunk_text TEXT, created_at TEXT, agent_id TEXT)`,
		);
		const db = raw as unknown as WriteDb;
		ensureEmbeddingIndexState(db, { ...config, model: "custom-a" });
		const staging = beginEmbeddingIndexBuild(db, { ...config, model: "custom-b" });
		expect(staging.state).toBe("building");
		expect(staging.staging?.profile).toBeUndefined();
		expect(staging.staging?.model).toBe("custom-b");
	});

	it("abandons an in-flight build when the config flips back to the active generation (#1160)", () => {
		const raw = new Database(":memory:");
		embeddingIndexGenerations(raw as unknown as Parameters<typeof embeddingIndexGenerations>[0]);
		raw.exec(
			"CREATE TABLE embeddings_staging (id TEXT PRIMARY KEY, content_hash TEXT UNIQUE, vector BLOB, dimensions INTEGER, source_type TEXT, source_id TEXT, chunk_text TEXT, created_at TEXT, agent_id TEXT)",
		);
		const db = raw as unknown as WriteDb;
		// Unknown models get the identity profile on both sides, so a config
		// whose fingerprint equals the active generation's must NOT keep an
		// in-flight build alive — that build would promote a generation the
		// current config no longer wants.
		const activeConfig: EmbeddingConfig = {
			provider: "ollama",
			model: "custom-a",
			dimensions: 3,
			base_url: "http://127.0.0.1:11434",
		};
		ensureEmbeddingIndexState(db, activeConfig);
		beginEmbeddingIndexBuild(db, { ...activeConfig, model: "custom-b" });
		db.prepare(
			"INSERT INTO embeddings_staging (id, content_hash, vector, dimensions) VALUES ('s1', 'h1', X'00', 3)",
		).run();
		const cancelled = beginEmbeddingIndexBuild(db, activeConfig);
		expect(cancelled.state).toBe("ready");
		expect(cancelled.staging).toBeNull();
		expect(db.prepare("SELECT COUNT(*) AS n FROM embeddings_staging").get() as { n: number }).toEqual({
			n: 0,
		});
	});

	it("rejects writes that captured a superseded active generation", () => {
		const raw = new Database(":memory:");
		embeddingIndexGenerations(raw as unknown as Parameters<typeof embeddingIndexGenerations>[0]);
		raw.exec(
			`CREATE TABLE embeddings_staging (id TEXT PRIMARY KEY, content_hash TEXT UNIQUE, vector BLOB, dimensions INTEGER, source_type TEXT, source_id TEXT, chunk_text TEXT, created_at TEXT, agent_id TEXT)`,
		);
		const db = raw as unknown as WriteDb;
		ensureEmbeddingIndexState(db, config);
		expect(isActiveEmbeddingConfig(db, config)).toBe(true);
		beginEmbeddingIndexBuild(db, { ...config, model: "qwen3-embedding:0.6b", dimensions: 1024 });
		raw
			.prepare(
				"UPDATE embedding_index_state SET active_profile_json = staging_profile_json, staging_profile_json = NULL, state = 'ready' WHERE id = 1",
			)
			.run();
		expect(isActiveEmbeddingConfig(db, config)).toBe(false);
	});

	it("rejects the old active generation while the swapped projection rebuilds", () => {
		const raw = new Database(":memory:");
		embeddingIndexGenerations(raw as unknown as Parameters<typeof embeddingIndexGenerations>[0]);
		raw.exec(
			"CREATE TABLE embeddings_staging (id TEXT PRIMARY KEY, content_hash TEXT UNIQUE, vector BLOB, dimensions INTEGER, source_type TEXT, source_id TEXT, chunk_text TEXT, created_at TEXT, agent_id TEXT)",
		);
		const db = raw as unknown as WriteDb;
		ensureEmbeddingIndexState(db, config);
		const staged = beginEmbeddingIndexBuild(db, { ...config, model: "qwen3-embedding:0.6b", dimensions: 1024 });
		expect(isActiveEmbeddingConfig(db, config)).toBe(true);
		raw
			.prepare("UPDATE embedding_index_state SET staging_profile_json = ? WHERE id = 1")
			.run(JSON.stringify({ ...staged.staging, projectionRebuild: true }));

		expect(isActiveEmbeddingConfig(db, config)).toBe(false);
	});

	it("alternates the inactive projection slot across promotions", () => {
		const raw = new Database(":memory:");
		embeddingIndexGenerations(raw as unknown as Parameters<typeof embeddingIndexGenerations>[0]);
		raw.exec(
			"CREATE TABLE embeddings_staging (id TEXT PRIMARY KEY, content_hash TEXT UNIQUE, vector BLOB, dimensions INTEGER)",
		);
		const db = raw as unknown as WriteDb;
		ensureEmbeddingIndexState(db, config);
		const first = beginEmbeddingIndexBuild(db, { ...config, provider: "ollama", model: "custom-a", dimensions: 3 });
		expect(first.staging?.projectionSlot).toBe("staging");
		raw
			.prepare(
				"UPDATE embedding_index_state SET active_profile_json = staging_profile_json, staging_profile_json = NULL, state = 'ready' WHERE id = 1",
			)
			.run();
		const second = beginEmbeddingIndexBuild(db, { ...config, provider: "ollama", model: "custom-b", dimensions: 3 });
		expect(second.active.projectionSlot).toBe("staging");
		expect(second.staging?.projectionSlot).toBe("active");
	});
	it("normalizes malformed config before it becomes durable state", () => {
		const raw = new Database(":memory:");
		embeddingIndexGenerations(raw as unknown as Parameters<typeof embeddingIndexGenerations>[0]);
		const db = raw as unknown as WriteDb;
		const malformed = { ...config, provider: "not-a-provider", dimensions: 0 } as unknown as EmbeddingConfig;
		const initial = ensureEmbeddingIndexState(db, malformed);
		expect(initial.active.provider).toBe("native");
		expect(initial.active.dimensions).toBe(768);
		expect(ensureEmbeddingIndexState(db, malformed)).toEqual(initial);
	});

	it("surfaces durable migration phase, counts, cursor, and endpoint", () => {
		const raw = new Database(":memory:");
		embeddingIndexGenerations(raw as unknown as Parameters<typeof embeddingIndexGenerations>[0]);
		raw.exec(
			`CREATE TABLE embeddings (id TEXT PRIMARY KEY); CREATE TABLE embeddings_staging (id TEXT PRIMARY KEY);
			 ALTER TABLE embedding_index_state ADD COLUMN migration_phase TEXT;
			 ALTER TABLE embedding_index_state ADD COLUMN progress_staged INTEGER NOT NULL DEFAULT 0;
			 ALTER TABLE embedding_index_state ADD COLUMN progress_total INTEGER NOT NULL DEFAULT 0;
			 ALTER TABLE embedding_index_state ADD COLUMN projection_cursor_last_id TEXT;
			 ALTER TABLE embedding_index_state ADD COLUMN projection_cursor_slot TEXT;
			 ALTER TABLE embedding_index_state ADD COLUMN no_progress_ticks INTEGER NOT NULL DEFAULT 0;
			 ALTER TABLE embedding_index_state ADD COLUMN provider_endpoint TEXT`,
		);
		const db = raw as unknown as WriteDb;
		ensureEmbeddingIndexState(db, config);
		beginEmbeddingIndexBuild(db, {
			...config,
			provider: "ollama",
			model: "custom-embed",
			dimensions: 3,
			base_url: "http://192.168.1.10:11434",
		});
		raw.prepare("INSERT INTO embeddings VALUES ('a'), ('b'), ('c')").run();
		raw.prepare("INSERT INTO embeddings_staging VALUES ('a')").run();
		raw
			.prepare(
				`UPDATE embedding_index_state SET migration_phase = 'projection', progress_staged = 1, progress_total = 3,
			 projection_cursor_last_id = 'a', projection_cursor_slot = 'staging', provider_endpoint = ? WHERE id = 1`,
			)
			.run("http://192.168.1.10:11434");

		expect(
			readEmbeddingIndexMigrationProgress(db, {
				...config,
				base_url: "http://192.168.1.10:11434",
			}),
		).toEqual({
			state: "building",
			staged: 1,
			total: 3,
			phase: "projection",
			providerEndpoint: "http://192.168.1.10:11434",
			lastError: null,
			projectionCursor: { lastId: "a", slot: "staging" },
		});
	});

	it("keeps an endpoint-only change ready and normalizes the legacy fingerprint", () => {
		const raw = new Database(":memory:");
		embeddingIndexGenerations(raw as unknown as Parameters<typeof embeddingIndexGenerations>[0]);
		raw.exec("CREATE TABLE embeddings (id TEXT PRIMARY KEY); CREATE TABLE embeddings_staging (id TEXT PRIMARY KEY);");
		const db = raw as unknown as WriteDb;
		const oldConfig: EmbeddingConfig = {
			provider: "ollama",
			model: "custom-embed",
			dimensions: 3,
			base_url: "http://127.0.0.1:11434",
		};
		ensureEmbeddingIndexState(db, oldConfig);
		const persisted = JSON.parse(
			(
				raw.prepare("SELECT active_profile_json FROM embedding_index_state WHERE id = 1").get() as {
					active_profile_json: string;
				}
			).active_profile_json,
		) as Record<string, unknown>;
		persisted.fingerprint = JSON.stringify({
			profile: "custom:ollama:custom-embed",
			provider: persisted.provider,
			model: persisted.model,
			dimensions: persisted.dimensions,
			baseUrl: oldConfig.base_url,
		});
		raw.prepare("UPDATE embedding_index_state SET active_profile_json = ? WHERE id = 1").run(JSON.stringify(persisted));

		const current = { ...oldConfig, base_url: "http://192.168.1.10:11434" };
		const state = beginEmbeddingIndexBuild(db, current);
		expect(state.state).toBe("ready");
		expect(state.staging).toBeNull();
		expect(isActiveEmbeddingConfig(db, current)).toBe(true);
		const normalized = JSON.parse(
			(
				raw.prepare("SELECT active_profile_json FROM embedding_index_state WHERE id = 1").get() as {
					active_profile_json: string;
				}
			).active_profile_json,
		) as Record<string, unknown>;
		expect(normalized.baseUrl).toBe(current.base_url);
		expect(JSON.parse(String(normalized.fingerprint))).not.toHaveProperty("baseUrl");
	});

	it("recovers an endpoint-only mid-promotion build without deleting active recall", () => {
		const raw = new Database(":memory:");
		embeddingIndexGenerations(raw as unknown as Parameters<typeof embeddingIndexGenerations>[0]);
		raw.exec(`
			CREATE TABLE memories (id TEXT PRIMARY KEY, embedding_model TEXT);
			CREATE TABLE embeddings (id TEXT PRIMARY KEY);
			CREATE TABLE embeddings_staging (id TEXT PRIMARY KEY);
			CREATE TABLE vec_embeddings (id TEXT PRIMARY KEY);
			CREATE TABLE vec_embeddings_staging (id TEXT PRIMARY KEY);
		`);
		const db = raw as unknown as WriteDb;
		const oldConfig: EmbeddingConfig = {
			provider: "ollama",
			model: "custom-embed",
			dimensions: 3,
			base_url: "http://127.0.0.1:11434",
		};
		const currentConfig = { ...oldConfig, base_url: "http://192.168.1.10:11434" };
		ensureEmbeddingIndexState(db, oldConfig);
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
		// Model the state after promotion's durable swap: the old active pair
		// remains the only recall-safe projection while the new projection rebuilds.
		raw.exec(`
			INSERT INTO embeddings VALUES ('new');
			INSERT INTO embeddings_staging VALUES ('old');
			INSERT INTO vec_embeddings VALUES ('old');
			INSERT INTO vec_embeddings_staging VALUES ('new');
		`);

		const recovered = beginEmbeddingIndexBuild(db, currentConfig);

		expect(recovered.state).toBe("ready");
		expect(recovered.staging).toBeNull();
		expect(raw.prepare("SELECT id FROM embeddings").get()).toEqual({ id: "old" });
		expect(raw.prepare("SELECT COUNT(*) AS count FROM embeddings_staging").get()).toEqual({ count: 0 });
		expect(raw.prepare("SELECT id FROM vec_embeddings").get()).toEqual({ id: "old" });
		expect(raw.prepare("SELECT COUNT(*) AS count FROM vec_embeddings_staging").get()).toEqual({ count: 0 });
		expect(readEmbeddingIndexState(db)?.active.baseUrl).toBe(currentConfig.base_url);
	});
});

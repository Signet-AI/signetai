import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { up as embeddingIndexGenerations } from "../../core/src/migrations/091-embedding-index-generations";
import {
	beginEmbeddingIndexBuild,
	ensureEmbeddingIndexState,
	failEmbeddingIndexBuild,
	isActiveEmbeddingConfig,
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
});

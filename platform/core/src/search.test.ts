import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { findSqliteVecExtension } from "./database";
import { vectorSearch } from "./search";

describe("vector search during embedding projection cutover", () => {
	it("joins the consistent old view during rebuild and the new view after completion", () => {
		const extension = findSqliteVecExtension();
		if (!extension) return;
		const raw = new Database(":memory:");
		raw.loadExtension(extension);
		raw.exec(`
			CREATE TABLE memories (id TEXT PRIMARY KEY, type TEXT);
			CREATE TABLE embeddings (id TEXT PRIMARY KEY, source_id TEXT);
			CREATE TABLE embeddings_staging (id TEXT PRIMARY KEY, source_id TEXT);
			CREATE TABLE embedding_index_state (
				id INTEGER PRIMARY KEY,
				active_profile_json TEXT NOT NULL,
				staging_profile_json TEXT,
				state TEXT NOT NULL
			);
			CREATE VIRTUAL TABLE vec_embeddings USING vec0(
				id TEXT PRIMARY KEY,
				embedding FLOAT[3] distance_metric=cosine
			);
			INSERT INTO memories VALUES ('memory-old', 'fact'), ('memory-new', 'fact');
			INSERT INTO embeddings VALUES ('new-id', 'memory-new');
			INSERT INTO embeddings_staging VALUES ('old-id', 'memory-old');
			INSERT INTO embedding_index_state VALUES (
				1,
				'{"model":"new-model","dimensions":4}',
				'{"model":"new-model","dimensions":4,"projectionRebuild":true}',
				'building'
			);
		`);
		raw.prepare("INSERT INTO vec_embeddings (id, embedding) VALUES (?, ?)").run("old-id", new Float32Array([1, 0, 0]));

		const duringRebuild = vectorSearch(raw, new Float32Array([1, 0, 0]), { limit: 1 });
		expect(duringRebuild).toEqual([{ id: "memory-old", score: 1 }]);

		raw.exec("DROP TABLE vec_embeddings");
		raw.exec(`
			CREATE VIRTUAL TABLE vec_embeddings USING vec0(
				id TEXT PRIMARY KEY,
				embedding FLOAT[4] distance_metric=cosine
			);
		`);
		raw
			.prepare("INSERT INTO vec_embeddings (id, embedding) VALUES (?, ?)")
			.run("new-id", new Float32Array([0, 1, 0, 0]));
		raw
			.prepare(
				"UPDATE embedding_index_state SET active_profile_json = ?, staging_profile_json = NULL, state = 'ready' WHERE id = 1",
			)
			.run('{"model":"new-model","dimensions":4}');

		const afterCompletion = vectorSearch(raw, new Float32Array([0, 1, 0, 0]), { limit: 1 });
		expect(afterCompletion).toEqual([{ id: "memory-new", score: 1 }]);
	});
});

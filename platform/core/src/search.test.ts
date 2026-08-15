import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

	it("keeps a non-empty old view when promotion commits between state and projection reads", () => {
		const extension = findSqliteVecExtension();
		if (!extension) return;
		const directory = mkdtempSync(join(tmpdir(), "signet-search-cutover-"));
		const databasePath = join(directory, "search.db");
		const raw = new Database(databasePath);
		const promotion = new Database(databasePath);
		try {
			raw.exec("PRAGMA journal_mode = WAL");
			raw.loadExtension(extension);
			promotion.loadExtension(extension);
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
		CREATE VIRTUAL TABLE vec_embeddings_staging USING vec0(
		id TEXT PRIMARY KEY,
		embedding FLOAT[3] distance_metric=cosine
		);
		INSERT INTO memories VALUES ('memory-old', 'fact'), ('memory-new', 'fact');
		INSERT INTO embeddings VALUES ('old-id', 'memory-old');
		INSERT INTO embeddings_staging VALUES ('new-id', 'memory-new');
		INSERT INTO embedding_index_state VALUES (
		1,
		'{"model":"old-model","dimensions":3}',
		'{"model":"new-model","dimensions":3,"projectionSlot":"staging"}',
		'building'
		);
		`);
			raw
				.prepare("INSERT INTO vec_embeddings (id, embedding) VALUES (?, ?)")
				.run("old-id", new Float32Array([1, 0, 0]));
			promotion
				.prepare("INSERT INTO vec_embeddings_staging (id, embedding) VALUES (?, ?)")
				.run("new-id", new Float32Array([0, 1, 0]));

			const commitPromotion = (): void => {
				promotion.exec("BEGIN IMMEDIATE");
				try {
					promotion.exec("ALTER TABLE embeddings_staging RENAME TO embeddings_next");
					promotion.exec("ALTER TABLE embeddings RENAME TO embeddings_staging");
					promotion.exec("ALTER TABLE embeddings_next RENAME TO embeddings");
					promotion
						.prepare("UPDATE embedding_index_state SET staging_profile_json = ? WHERE id = 1")
						.run('{"model":"new-model","dimensions":3,"projectionSlot":"staging","projectionRebuild":true}');
					promotion.exec("COMMIT");
				} catch (error) {
					promotion.exec("ROLLBACK");
					throw error;
				}
			};

			let promoted = false;
			const searchDb = {
				exec: (sql: string): void => {
					raw.exec(sql);
				},
				prepare: (sql: string) => {
					const statement = raw.prepare(sql);
					const compatible = statement as unknown as {
						run(...params: unknown[]): void;
						get(...params: unknown[]): Record<string, unknown> | undefined;
						all(...params: unknown[]): Record<string, unknown>[];
					};
					return {
						run: (...params: unknown[]) => {
							compatible.run(...params);
						},
						get: (...params: unknown[]) => {
							const row = compatible.get(...params);
							if (!promoted && sql.includes("FROM embedding_index_state")) {
								promoted = true;
								commitPromotion();
							}
							return row;
						},
						all: (...params: unknown[]) => compatible.all(...params),
					};
				},
			} as Parameters<typeof vectorSearch>[0];

			expect(vectorSearch(searchDb, new Float32Array([1, 0, 0]), { limit: 1 })).toEqual([
				{ id: "memory-old", score: 1 },
			]);
			expect(promoted).toBe(true);
		} finally {
			raw.close();
			promotion.close();
			rmSync(directory, { recursive: true, force: true });
		}
	});
});

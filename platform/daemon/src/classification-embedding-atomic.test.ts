import { up as writeMigration } from "../../core/src/migrations/178-write-inheritance";
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { stageEmbeddingBatch } from "./embedding-index-migration";
import { initDbAccessorLite, getDbAccessor, closeDbAccessor } from "./db-accessor";
import { compartmentFor, findSqliteVecExtension } from "@signet/core";
import { classificationFixture } from "./test-support/classification-fixture.test";
import { executeEmbeddingProjection } from "./embedding-projection-owner";
import { syncVecInsert } from "./db-helpers";
import { createDbOwnerClient } from "./db-owner-client";

function vectorFixture() {
	const db = classificationFixture(),
		extension = findSqliteVecExtension();
	if (!extension) throw new Error("sqlite-vec required");
	db.loadExtension(extension);
	db.exec(
		"DROP TABLE IF EXISTS vec_embeddings;CREATE VIRTUAL TABLE vec_embeddings USING vec0(id TEXT PRIMARY KEY,embedding FLOAT[3] distance_metric=cosine)",
	);
	return db;
}
test("id projection never touches equal hashes belonging to another parent", () => {
	const db = vectorFixture();
	db.exec(
		"DROP TABLE embeddings;CREATE TABLE embeddings(id TEXT PRIMARY KEY,content_hash TEXT,vector BLOB,dimensions INTEGER,source_type TEXT,source_id TEXT,chunk_text TEXT,created_at TEXT,agent_id TEXT,compartment_id INTEGER,projection_compartment_id INTEGER)",
	);
	for (const id of ["a", "b"])
		db.prepare(
			"INSERT INTO embeddings(id,content_hash,vector,dimensions,source_type,source_id,chunk_text,created_at,agent_id) VALUES(?,'same',?,3,'memory','m','x','now','default')",
		).run(id, new Float32Array([1, 0, 0]));
	executeEmbeddingProjection(db, {
		store: "embeddings",
		projection: "vec_embeddings",
		ids: ["a"],
	});
	expect(db.prepare("SELECT id FROM vec_embeddings ORDER BY id").all()).toEqual([{ id: "a" }]);
	db.close();
});
test("legacy syncVecInsert leaves canonical data intact when optional projection rejects the vector", () => {
	const db = vectorFixture();
	db.prepare(
		"INSERT INTO embeddings(id,content_hash,vector,dimensions,source_type,source_id,chunk_text,created_at,agent_id) VALUES('bad','bad',?,4,'memory','m','x','now','default')",
	).run(new Float32Array([1, 0, 0, 0]));
	expect(() => syncVecInsert(db, "bad", [1, 0, 0, 0])).not.toThrow();
	expect(db.prepare("SELECT id FROM embeddings WHERE id='bad'").get()).toEqual({ id: "bad" });
	db.close();
});
for (const dimensions of [3, 4])
	test(`embedding batch atomically publishes or rolls back its ${dimensions} dimensional projection`, async () => {
		const directory = mkdtempSync(join(tmpdir(), "embedding-atomic-")),
			path = join(directory, "db.sqlite"),
			db = vectorFixture();
		db.prepare("VACUUM INTO ?").run(path);
		db.close();
		const owner = createDbOwnerClient({ dbPath: path });
		try {
			await owner.start();
			const result = owner.submit(
				{
					kind: "batch",
					statements: [
						{
							sql: "INSERT INTO embeddings(id,content_hash,vector,dimensions,source_type,source_id,chunk_text,created_at,agent_id) VALUES('new','new',?,?,'memory','m','x','now','default')",
							params: [
								{
									type: "bytes",
									base64: Buffer.from(
										new Float32Array(Array.from({ length: dimensions }, (_, i) => (i === 0 ? 1 : 0))).buffer,
									).toString("base64"),
								},
								dimensions,
							],
							result: "run",
						},
					],
					embeddingProjection: { store: "embeddings", projection: "vec_embeddings", ids: ["new"] },
				},
				{ operation: "test.atomic-embedding", lane: "write", deadlineMs: 5000 },
			).result;
			if (dimensions === 4) await expect(result).rejects.toThrow();
			else await result;
			const state = await owner.submit(
				{
					kind: "query",
					statement: {
						sql: "SELECT (SELECT count(*) FROM embeddings WHERE id='new') canonical,(SELECT count(*) FROM vec_embeddings WHERE id='new') projected",
						result: "get",
					},
				},
				{ operation: "test.embedding-state", lane: "read", deadlineMs: 5000 },
			).result;
			expect(state).toEqual({ canonical: dimensions === 3 ? 1 : 0, projected: dimensions === 3 ? 1 : 0 });
		} finally {
			await owner.close();
			rmSync(directory, { recursive: true, force: true });
		}
	}, 30000);

test("the staging producer inherits and publishes classified rows in its owner batch", async () => {
	const directory = mkdtempSync(join(tmpdir(), "classified-stage-")),
		path = join(directory, "db.sqlite"),
		db = vectorFixture();
	db.exec(
		"CREATE VIRTUAL TABLE vec_embeddings_staging USING vec0(id TEXT PRIMARY KEY,embedding FLOAT[4] distance_metric=cosine);INSERT INTO classifications(id,name) VALUES('cls_hr','HR')",
	);
	const c = compartmentFor(db, ["cls_hr"]);
	db.prepare("UPDATE memories SET compartment_id=? WHERE id='m'").run(c);
	db.prepare(
		"INSERT INTO embeddings(id,content_hash,vector,dimensions,source_type,source_id,chunk_text,created_at,agent_id,compartment_id) VALUES('old','hash',?,3,'memory','m','secret','now','default',?)",
	).run(new Float32Array([1, 0, 0]), c);
	writeMigration(db);
	db.exec(
		"INSERT INTO memories(id,content,agent_id,created_at,updated_at) VALUES('public-parent','public','default','now','now')",
	);
	db.prepare(
		"INSERT INTO embeddings(id,content_hash,vector,dimensions,source_type,source_id,chunk_text,created_at,agent_id) VALUES('public-embedding','hash',?,3,'memory','public-parent','public','now','default')",
	).run(new Float32Array([0, 1, 0]));
	const active = {
			fingerprint: "old",
			provider: "ollama",
			model: "old",
			dimensions: 3,
			baseUrl: "http://127.0.0.1:1",
			projectionSlot: "active",
		},
		staging = { ...active, fingerprint: "new", model: "new", dimensions: 4, projectionSlot: "staging" };
	db.prepare(
		"INSERT INTO embedding_index_state(id,active_profile_json,staging_profile_json,state,created_at,updated_at) VALUES(1,?,?,'building','now','now')",
	).run(JSON.stringify(active), JSON.stringify(staging));
	db.prepare("VACUUM INTO ?").run(path);
	db.close();
	const owner = createDbOwnerClient({ dbPath: path });
	try {
		const extension = findSqliteVecExtension();
		if (!extension) throw new Error("sqlite-vec required");
		initDbAccessorLite(path, extension);
		await owner.start();
		const result = await stageEmbeddingBatch({
			accessor: getDbAccessor(),
			owner,
			configured: { provider: "ollama", model: "new", dimensions: 4, base_url: "http://127.0.0.1:1" },
			fetchEmbedding: async () => [0, 1, 0, 0],
			batchSize: 10,
		});
		expect(result.staged).toBe(2);
		const state = await owner.submit(
			{
				kind: "query",
				statement: {
					sql: `SELECT (SELECT count(*) FROM embeddings_staging WHERE compartment_id=${c}) canonical,(SELECT count(*) FROM vec_embeddings_staging__c${c}) projected,(SELECT count(*) FROM vec_embeddings_staging) base`,
					result: "get",
				},
			},
			{ operation: "test.staged-compartment", lane: "read", deadlineMs: 5000 },
		).result;
		expect(state).toEqual({ canonical: 1, projected: 1, base: 1 });
	} finally {
		await closeDbAccessor();
		await owner.close();
		rmSync(directory, { recursive: true, force: true });
	}
}, 30000);

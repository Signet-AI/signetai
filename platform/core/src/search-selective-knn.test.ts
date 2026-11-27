import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { findSqliteVecExtension } from "./database";
import { vectorSearchWithMetadata } from "./search";

test("selective indexed KNN remains exact beyond vec0's maximum k without raw vector blobs", () => {
	const db = new Database(":memory:");
	try {
		const extension = findSqliteVecExtension();
		if (!extension) throw new Error("sqlite-vec required");
		db.loadExtension(extension);
		db.exec(
			"CREATE TABLE memories(id TEXT PRIMARY KEY,agent_id TEXT,compartment_id INTEGER,project TEXT,visibility TEXT,type TEXT,source_type TEXT); CREATE TABLE embeddings(id TEXT PRIMARY KEY,source_id TEXT,agent_id TEXT,compartment_id INTEGER); CREATE VIRTUAL TABLE vec_embeddings USING vec0(id TEXT PRIMARY KEY,embedding FLOAT[3] distance_metric=cosine)",
		);
		db.exec(
			"ALTER TABLE memories ADD COLUMN is_deleted INTEGER DEFAULT 0; ALTER TABLE memories ADD COLUMN superseded_by TEXT; ALTER TABLE memories ADD COLUMN stale_at TEXT; ALTER TABLE memories ADD COLUMN scope TEXT",
		);
		const memory = db.prepare(
			"INSERT INTO memories(id,agent_id,compartment_id,project,visibility,type,source_type) VALUES (?,?,NULL,NULL,'global','fact',NULL)",
		);
		const embedding = db.prepare("INSERT INTO embeddings VALUES (?,?,?,NULL)");
		const projection = db.prepare("INSERT INTO vec_embeddings VALUES (?,?)");
		for (let index = 0; index < 5003; index++) {
			const id = `v${String(index).padStart(5, "0")}`;
			const agent = index >= 4995 ? "alice" : "bob";
			memory.run(id, agent);
			embedding.run(id, id, agent);
			projection.run(id, new Float32Array([1, index / 10000, 0]));
		}
		const response = vectorSearchWithMetadata(db, new Float32Array([1, 0, 0]), {
			limit: 2,
			readScope: { reach: { kind: "own", agentId: "alice" }, compartments: [], projects: null },
		});
		expect(response.completeness).toBe("complete");
		expect(response.results.map((row) => row.id)).toEqual(["v04995", "v04996"]);
		db.exec(
			"UPDATE memories SET is_deleted=1 WHERE id='v04995'; UPDATE memories SET superseded_by='v04999' WHERE id='v04996'; UPDATE memories SET stale_at='now' WHERE id='v04997'; UPDATE memories SET scope='other' WHERE id='v04998'",
		);
		const current = vectorSearchWithMetadata(db, new Float32Array([1, 0, 0]), {
			limit: 2,
			currentOnly: true,
			memoryScope: null,
			readScope: { reach: { kind: "own", agentId: "alice" }, compartments: [], projects: null },
		});
		expect(current.completeness).toBe("complete");
		expect(current.results.map((row) => row.id)).toEqual(["v04999", "v05000"]);
	} finally {
		db.close();
	}
}, 30000);

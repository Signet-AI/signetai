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
		const memory = db.prepare("INSERT INTO memories VALUES (?,?,NULL,NULL,'global','fact',NULL)");
		const embedding = db.prepare("INSERT INTO embeddings VALUES (?,?,?,NULL)");
		const projection = db.prepare("INSERT INTO vec_embeddings VALUES (?,?)");
		for (let index = 0; index < 5000; index++) {
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
	} finally {
		db.close();
	}
}, 30000);

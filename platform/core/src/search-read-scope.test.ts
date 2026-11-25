import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { ensureCompartmentShards, rebuildBaseCompartmentFts } from "./compartment-shards";
import { findSqliteVecExtension } from "./database";
import { keywordSearch, vectorSearchWithMetadata } from "./search";

function fixture() {
	const db = new Database(":memory:");
	db.exec(`CREATE TABLE agents(id TEXT PRIMARY KEY, archived_at TEXT);
		INSERT INTO agents VALUES ('alice',NULL),('bob',NULL),('old','2026-01-01');
		CREATE TABLE memories(id TEXT PRIMARY KEY, content TEXT, agent_id TEXT, compartment_id INTEGER, project TEXT, visibility TEXT DEFAULT 'global', type TEXT, source_type TEXT);
		CREATE VIRTUAL TABLE memories_fts USING fts5(content,content='memories',content_rowid='rowid');
		CREATE TABLE embeddings(id TEXT PRIMARY KEY, source_id TEXT, agent_id TEXT, compartment_id INTEGER, project TEXT, source_type TEXT, dimensions INTEGER, vector BLOB);
		INSERT INTO memories(id,content,agent_id,type) VALUES ('visible','atlas deploy pipeline','alice','fact'),('peer','atlas canary deploy','bob','fact'),('archived','atlas deploy','old','fact');`);
	rebuildBaseCompartmentFts(db);
	ensureCompartmentShards(db, 7, 0);
	return db;
}
const scope = { reach: { kind: "all" as const }, compartments: [], projects: null };

describe("scoped search noninterference", () => {
	it("keeps FTS scores and order invariant under hidden shard mutations", () => {
		const db = fixture();
		try {
			const before = keywordSearch(db, "atlas", 10, scope);
			expect(before.map((r) => r.id).sort()).toEqual(["peer", "visible"]);
			db.exec(
				"INSERT INTO memories(id,content,agent_id,compartment_id,type) VALUES ('hidden','atlas atlas atlas secret','bob',7,'fact')",
			);
			expect(keywordSearch(db, "atlas", 10, scope)).toEqual(before);
			db.exec("UPDATE memories SET content='atlas deploy classified pipeline' WHERE id='hidden'");
			expect(keywordSearch(db, "atlas", 10, scope)).toEqual(before);
			expect(keywordSearch(db, "atlas", 10, { ...scope, compartments: [7] }).map((r) => r.id)).toContain("hidden");
		} finally {
			db.close();
		}
	});
	it("filters cosine scans before their admission window", () => {
		const db = fixture();
		try {
			const insert = db.prepare("INSERT INTO embeddings VALUES (?,?,?, ?,NULL,'memory',3,?)");
			insert.run("ev", "visible", "alice", null, new Float32Array([1, 0, 0]));
			const options = { readScope: scope, limit: 1, maxScanRows: 1 };
			const before = vectorSearchWithMetadata(db, new Float32Array([1, 0, 0]), options);
			expect(before.results).toEqual([{ id: "visible", score: 1 }]);
			db.exec("INSERT INTO memories(id,content,agent_id,compartment_id,type) VALUES ('hidden','atlas','bob',7,'fact')");
			insert.run("eh", "hidden", "bob", 7, new Float32Array([1, 0, 0]));
			expect(vectorSearchWithMetadata(db, new Float32Array([1, 0, 0]), options)).toEqual(before);
		} finally {
			db.close();
		}
	});
	it("prefilters indexed KNN and merges readable vector shards", () => {
		const extension = findSqliteVecExtension();
		expect(extension).toBeTruthy();
		if (!extension) throw new Error("sqlite-vec required");
		const db = fixture();
		try {
			db.loadExtension(extension);
			db.exec(
				"CREATE VIRTUAL TABLE vec_embeddings USING vec0(id TEXT PRIMARY KEY,embedding FLOAT[3] distance_metric=cosine)",
			);
			ensureCompartmentShards(db, 7, 3);
			db.exec("INSERT INTO memories(id,content,agent_id,compartment_id,type) VALUES ('hidden','atlas','bob',7,'fact')");
			const insert = db.prepare("INSERT INTO embeddings VALUES (?,?,?, ?,NULL,'memory',3,?)");
			insert.run("ev", "visible", "alice", null, new Float32Array([0.8, 0.2, 0]));
			insert.run("ep", "peer", "bob", null, new Float32Array([1, 0, 0]));
			insert.run("eh", "hidden", "bob", 7, new Float32Array([1, 0, 0]));
			db.prepare("INSERT INTO vec_embeddings VALUES (?,?)").run("ev", new Float32Array([0.8, 0.2, 0]));
			db.prepare("INSERT INTO vec_embeddings VALUES (?,?)").run("ep", new Float32Array([1, 0, 0]));
			db.prepare("INSERT INTO vec_embeddings__c7 VALUES (?,?)").run("eh", new Float32Array([1, 0, 0]));
			const own = { ...scope, reach: { kind: "own" as const, agentId: "alice" } };
			expect(
				vectorSearchWithMetadata(db, new Float32Array([1, 0, 0]), { limit: 1, readScope: own }).results.map(
					(r) => r.id,
				),
			).toEqual(["visible"]);
			expect(
				vectorSearchWithMetadata(db, new Float32Array([1, 0, 0]), {
					limit: 3,
					readScope: { ...scope, compartments: [7] },
				}).results.map((r) => r.id),
			).toContain("hidden");
		} finally {
			db.close();
		}
	});
});

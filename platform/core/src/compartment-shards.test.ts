import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { findSqliteVecExtension } from "./database";
import {
	compartmentFor,
	deleteCompartmentVectors,
	missingCompartmentVectorSql,
	ensureCompartmentShards,
	ftsShardTables,
	rebuildBaseCompartmentFts,
	syncEmbeddingCompartment,
	vecShardTables,
} from "./compartment-shards";

test("warm vector writes touch only the previous shard without catalog work", () => {
	const db = new Database(":memory:");
	const extension = findSqliteVecExtension();
	if (!extension) throw new Error("sqlite-vec required");
	db.loadExtension(extension);
	db.exec(
		"CREATE TABLE embeddings(id TEXT PRIMARY KEY,vector BLOB,dimensions INTEGER,compartment_id INTEGER,projection_compartment_id INTEGER);CREATE VIRTUAL TABLE vec_embeddings USING vec0(id TEXT PRIMARY KEY,embedding FLOAT[3] distance_metric=cosine)",
	);
	for (let c = 1; c <= 12; c++)
		db.exec(
			`CREATE VIRTUAL TABLE vec_embeddings__c${c} USING vec0(id TEXT PRIMARY KEY,embedding FLOAT[3] distance_metric=cosine)`,
		);
	db.prepare("INSERT INTO embeddings(id,vector,dimensions,compartment_id) VALUES('hot',?,3,1)").run(
		new Float32Array([1, 0, 0]),
	);
	const sql: string[] = [];
	const traced = new Proxy(db, {
		get(target, key, receiver) {
			if (key === "prepare")
				return (query: string) => {
					sql.push(query);
					return target.prepare(query);
				};
			if (key === "exec")
				return (query: string) => {
					sql.push(query);
					return target.exec(query);
				};
			return Reflect.get(target, key, receiver);
		},
	});
	syncEmbeddingCompartment(traced, "embeddings", "hot");
	sql.length = 0;
	db.prepare("UPDATE embeddings SET compartment_id=2 WHERE id='hot'").run();
	syncEmbeddingCompartment(traced, "embeddings", "hot");
	expect(sql.filter((q) => /sqlite_master|pragma\s+table_info|CREATE\s/i.test(q))).toEqual([]);
	expect(sql.filter((q) => /^DELETE FROM vec_embeddings/i.test(q))).toHaveLength(1);
	expect(db.prepare("SELECT id FROM vec_embeddings__c1").all()).toEqual([]);
	expect(db.prepare("SELECT id FROM vec_embeddings__c2").all()).toEqual([{ id: "hot" }]);
	db.close();
});

test("shard admission intersects physical tables with the readable compartments", () => {
	const db = new Database(":memory:");
	db.exec(
		"CREATE TABLE memories_fts(content TEXT);CREATE TABLE memories_fts__c1(content TEXT);CREATE TABLE memories_fts__c2(content TEXT);CREATE TABLE vec_embeddings(id TEXT);CREATE TABLE vec_embeddings__c1(id TEXT);CREATE TABLE vec_embeddings__c2(id TEXT)",
	);
	expect(ftsShardTables("memories_fts", [1, 3], db)).toEqual(["memories_fts", "memories_fts__c1"]);
	expect(vecShardTables([1, 3], db)).toEqual(["vec_embeddings", "vec_embeddings__c1"]);
	db.close();
});

test("hidden FTS and vec rows cannot change base scores, order, counts or top-k and moves roll back atomically", () => {
	const db = new Database(":memory:");
	const extension = findSqliteVecExtension();
	expect(extension).not.toBeNull();
	if (!extension) throw new Error("sqlite-vec required");
	db.loadExtension(extension);
	db.exec(
		`CREATE TABLE memories(id TEXT PRIMARY KEY,content TEXT,compartment_id INTEGER); CREATE VIRTUAL TABLE memories_fts USING fts5(content,content='memories',content_rowid='rowid',tokenize='porter unicode61'); CREATE TABLE embeddings(id TEXT PRIMARY KEY,vector BLOB,dimensions INTEGER,compartment_id INTEGER,projection_compartment_id INTEGER); CREATE VIRTUAL TABLE vec_embeddings USING vec0(id TEXT PRIMARY KEY,embedding FLOAT[3] distance_metric=cosine); CREATE TABLE compartments(id INTEGER PRIMARY KEY AUTOINCREMENT,key TEXT UNIQUE,created_at TEXT);CREATE TABLE compartment_members(compartment_id INTEGER,classification_id TEXT,PRIMARY KEY(compartment_id,classification_id));`,
	);
	rebuildBaseCompartmentFts(db);
	const c = compartmentFor(db, ["cls_hr"]);
	if (c === null) throw new Error("missing compartment");
	ensureCompartmentShards(db, c, 3);
	const add = (id: string, content: string, comp: number | null, vector: number[]) => {
		db.prepare("INSERT INTO memories VALUES(?,?,?)").run(id, content, comp);
		db.prepare("INSERT INTO embeddings(id,vector,dimensions,compartment_id) VALUES(?,?,3,?)").run(
			id,
			new Float32Array(vector),
			comp,
		);
		syncEmbeddingCompartment(db, "embeddings", id);
	};
	add("a", "apple apple banana", null, [1, 0, 0]);
	add("b", "apple banana", null, [0.8, 0.2, 0]);
	const fts = () =>
		JSON.stringify(
			db
				.prepare(
					"SELECT m.id,bm25(memories_fts) score FROM memories_fts JOIN memories m ON m.rowid=memories_fts.rowid WHERE memories_fts MATCH 'apple' ORDER BY score,m.id",
				)
				.all(),
		);
	const vec = () =>
		JSON.stringify(
			db
				.prepare("SELECT id,distance FROM vec_embeddings WHERE embedding MATCH ? AND k=2 ORDER BY distance")
				.all(new Float32Array([1, 0, 0])),
		);
	const counts = () =>
		JSON.stringify(
			db
				.prepare("SELECT (SELECT count(*) FROM memories_fts_docsize) fts,(SELECT count(*) FROM vec_embeddings) vec")
				.get(),
		);
	const before = [fts(), vec(), counts()];
	for (let i = 0; i < 50; i++) add(`hidden${i}`, "apple secret secret", c, [1, 0, 0]);
	db.prepare("UPDATE memories SET content='apple secret updated' WHERE id='hidden1'").run();
	expect(db.prepare(`SELECT count(*) n FROM memories_fts__c${c}_docsize`).get()).toEqual({ n: 50 });
	expect([fts(), vec(), counts()]).toEqual(before);
	expect(
		db.prepare(`SELECT count(*) n FROM memories_fts__c${c} WHERE memories_fts__c${c} MATCH 'secret'`).get(),
	).toEqual({ n: 50 });
	expect(ftsShardTables("memories_fts", [c, c], db)).toEqual(["memories_fts", `memories_fts__c${c}`]);
	expect(vecShardTables([c], db)).toEqual(["vec_embeddings", `vec_embeddings__c${c}`]);
	const combined = [
		...db
			.prepare("SELECT id,distance FROM vec_embeddings WHERE embedding MATCH ? AND k=1")
			.all(new Float32Array([1, 0, 0])),
		...db
			.prepare(`SELECT id,distance FROM vec_embeddings__c${c} WHERE embedding MATCH ? AND k=1`)
			.all(new Float32Array([1, 0, 0])),
	];
	expect(
		combined.some(
			(row) =>
				typeof row === "object" &&
				row !== null &&
				"id" in row &&
				typeof row.id === "string" &&
				row.id.startsWith("hidden"),
		),
	).toBe(true);
	expect(
		db
			.prepare(`SELECT count(*) n FROM embeddings e WHERE ${missingCompartmentVectorSql(db, "vec_embeddings", "e")}`)
			.get(),
	).toEqual({ n: 0 });
	db.transaction(() => {
		add("reclassified", "apple secret", null, [1, 0, 0]);
		db.prepare("UPDATE memories SET compartment_id=? WHERE id=?").run(c, "reclassified");
		db.prepare("UPDATE embeddings SET compartment_id=? WHERE id=?").run(c, "reclassified");
		syncEmbeddingCompartment(db, "embeddings", "reclassified");
	})();
	expect([fts(), vec(), counts()]).toEqual(before);
	expect(() =>
		db.transaction(() => {
			db.prepare("UPDATE memories SET compartment_id=NULL WHERE id=?").run("hidden0");
			db.prepare("UPDATE embeddings SET compartment_id=NULL WHERE id=?").run("hidden0");
			syncEmbeddingCompartment(db, "embeddings", "hidden0");
			throw new Error("crash");
		})(),
	).toThrow("crash");
	expect([fts(), vec(), counts()]).toEqual(before);
	db.transaction(() => {
		db.prepare("UPDATE memories SET compartment_id=NULL WHERE id=?").run("hidden0");
		db.prepare("UPDATE embeddings SET compartment_id=NULL WHERE id=?").run("hidden0");
		syncEmbeddingCompartment(db, "embeddings", "hidden0");
	})();
	expect(db.prepare("SELECT count(*) n FROM memories_fts WHERE memories_fts MATCH 'secret'").get()).toEqual({ n: 1 });
	expect(db.prepare(`SELECT count(*) n FROM vec_embeddings__c${c} WHERE id='hidden0'`).get()).toEqual({ n: 0 });
	const removed = [...Array.from({ length: 49 }, (_, i) => `hidden${i + 1}`), "reclassified"];
	deleteCompartmentVectors(db, removed);
	db.prepare("DELETE FROM memories WHERE compartment_id=?").run(c);
	db.prepare("DELETE FROM embeddings WHERE compartment_id=?").run(c);
	expect(db.prepare(`SELECT count(*) n FROM memories_fts__c${c}_docsize`).get()).toEqual({ n: 0 });
	expect(db.prepare(`SELECT count(*) n FROM vec_embeddings__c${c}`).get()).toEqual({ n: 0 });
	db.close();
});

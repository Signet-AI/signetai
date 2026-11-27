import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { up } from "./186-vector-admission-shards";

test("vector admission migration declares only metadata on fresh and repeated runs", () => {
	const db = new Database(":memory:");
	try {
		up(db);
		up(db);
		expect(db.query("SELECT phase FROM vector_shard_repairs ORDER BY projection").all()).toEqual([
			{ phase: "ready" },
			{ phase: "ready" },
		]);
		expect(db.query("SELECT name FROM sqlite_master WHERE sql LIKE '%USING vec0%'").all()).toEqual([]);
	} finally {
		db.close();
	}
});

test("legacy vector payloads remain untouched with a resumable repair marker", () => {
	const db = new Database(":memory:");
	try {
		db.exec(
			"CREATE TABLE embeddings(id TEXT PRIMARY KEY,vector BLOB);INSERT INTO embeddings VALUES('legacy',X'01020304')",
		);
		up(db);
		expect(db.query("SELECT phase FROM vector_shard_repairs WHERE projection='vec_embeddings'").get()).toEqual({
			phase: "pending",
		});
		db.exec("UPDATE vector_shard_repairs SET cursor='checkpoint' WHERE projection='vec_embeddings'");
		up(db);
		expect(db.query("SELECT cursor FROM vector_shard_repairs WHERE projection='vec_embeddings'").get()).toEqual({
			cursor: "checkpoint",
		});
		expect(db.query("SELECT hex(vector) payload FROM embeddings").get()).toEqual({ payload: "01020304" });
		expect(db.query("SELECT COUNT(*) n FROM vector_shard_members").get()).toEqual({ n: 0 });
	} finally {
		db.close();
	}
});

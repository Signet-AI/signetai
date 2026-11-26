import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import ts from "typescript";
import Database from "../sqlite";

test("vector table rebuild preserves equal content hashes", () => {
	const source = ts.createSourceFile(
		"vector.ts",
		readFileSync(new URL("./vector.ts", import.meta.url), "utf8"),
		ts.ScriptTarget.Latest,
		true,
	);
	let rebuild: string | undefined;
	function visit(node: ts.Node): void {
		if (ts.isNoSubstitutionTemplateLiteral(node) && node.text.includes("CREATE TABLE embeddings_new"))
			rebuild = node.text;
		ts.forEachChild(node, visit);
	}
	visit(source);
	if (!rebuild) throw new Error("Missing vector table rebuild");
	const db = Database(":memory:");
	try {
		db.exec(
			"CREATE TABLE embeddings(id TEXT PRIMARY KEY,content_hash TEXT NOT NULL,vector BLOB,dimensions INTEGER NOT NULL,source_type TEXT NOT NULL,source_id TEXT NOT NULL,chunk_text TEXT NOT NULL,created_at TEXT NOT NULL)",
		);
		db.exec(
			"INSERT INTO embeddings VALUES('a','equal',NULL,3,'memory','a','text','now'),('b','equal',NULL,3,'memory','b','text','now')",
		);
		db.exec(rebuild);
		expect(
			db
				.prepare("PRAGMA table_info(embeddings)")
				.all()
				.some((row) => row.name === "vector"),
		).toBe(false);
		expect(db.prepare("SELECT count(*) n FROM embeddings WHERE content_hash='equal'").get()).toEqual({ n: 2 });
		db.prepare("INSERT INTO embeddings VALUES('c','equal',3,'memory','c','text','now')").run();
	} finally {
		db.close();
	}
});

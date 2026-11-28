import { Database } from "bun:sqlite";
import assert from "node:assert/strict";
import { up } from "../183-legacy-child-scope";
export function repairFixture(size: number): Database {
	const db = new Database(":memory:");
	db.exec(`CREATE TABLE embeddings(id TEXT PRIMARY KEY,source_id TEXT,source_type TEXT,agent_id TEXT,compartment_id INTEGER);
		CREATE INDEX idx_embeddings_source ON embeddings(source_type,source_id);
		CREATE TABLE memories(id TEXT PRIMARY KEY,agent_id TEXT,compartment_id INTEGER);`);
	const insert = db.prepare("INSERT INTO embeddings VALUES(?,?,'memory',NULL,NULL)");
	db.transaction(() => {
		for (let i = 0; i < size; i++) insert.run(`e${i}`, `missing${i}`);
	})();
	return db;
}

if (import.meta.main) {
	const measure = (size: number): number => {
		const db = repairFixture(size);
		try {
			const started = performance.now();
			up(db);
			const elapsed = performance.now() - started;
			assert.deepEqual(
				db.query("SELECT unresolved FROM legacy_child_scope_repairs WHERE table_name='embeddings'").get(),
				{ unresolved: size },
			);
			return elapsed;
		} finally {
			db.close();
		}
	};
	measure(1000);
	const small = [measure(20000), measure(20000), measure(20000)].sort((a, b) => a - b)[1] ?? 0;
	const large = [measure(40000), measure(40000), measure(40000)].sort((a, b) => a - b)[1] ?? Infinity;
	console.log(JSON.stringify({ small, large }));
}

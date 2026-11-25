import { Database, type SQLQueryBindings } from "bun:sqlite";

function bindings(args: readonly unknown[]): SQLQueryBindings[] {
	return args.map((value): SQLQueryBindings => {
		if (value === null) return null;
		if (
			typeof value === "string" ||
			typeof value === "number" ||
			typeof value === "boolean" ||
			typeof value === "bigint" ||
			value instanceof Float32Array ||
			value instanceof Uint8Array
		)
			return value;
		throw new Error("Unsupported SQLite binding");
	});
}
import { expect, test } from "bun:test";
import { findSqliteVecExtension } from "./database";
import { vectorSearchWithMetadata } from "./search";

test("exact scoped KNN starts at four times k and doubles only until eligible hits or exhaustion", () => {
	const db = new Database(":memory:");
	try {
		const extension = findSqliteVecExtension();
		if (!extension) throw new Error("sqlite-vec required");
		db.loadExtension(extension);
		db.exec(
			"CREATE TABLE memories(id TEXT PRIMARY KEY,agent_id TEXT,compartment_id INTEGER,project TEXT,visibility TEXT,type TEXT,source_type TEXT); CREATE TABLE embeddings(id TEXT PRIMARY KEY,source_id TEXT,agent_id TEXT,compartment_id INTEGER); CREATE VIRTUAL TABLE vec_embeddings USING vec0(id TEXT PRIMARY KEY,embedding FLOAT[3] distance_metric=cosine)",
		);
		for (let i = 0; i < 50; i++) {
			const id = `v${String(i).padStart(2, "0")}`;
			db.prepare("INSERT INTO memories VALUES (?,?,NULL,NULL,'global','fact',NULL)").run(id, i < 40 ? "bob" : "alice");
			db.prepare("INSERT INTO embeddings VALUES (?,?,?,NULL)").run(id, id, i < 40 ? "bob" : "alice");
			db.prepare("INSERT INTO vec_embeddings VALUES (?,?)").run(id, new Float32Array([1, i / 50, 0]));
		}
		const probes: number[] = [];
		const countedTables: string[] = [];
		const wrapped = {
			exec: (sql: string) => {
				db.exec(sql);
			},
			prepare: (sql: string) => {
				const count = /SELECT COUNT\(\*\) AS count FROM (\w+)/.exec(sql);
				if (count?.[1]) countedTables.push(count[1]);
				const statement = db.prepare<Record<string, unknown>, SQLQueryBindings[]>(sql);
				return {
					run: (...args: unknown[]) => {
						statement.run(...bindings(args));
					},
					get: (...args: unknown[]) => statement.get(...bindings(args)),
					all: (...args: unknown[]) => {
						if (/embedding MATCH/.test(sql) && typeof args[1] === "number") probes.push(args[1]);
						return statement.all(...bindings(args));
					},
				};
			},
		};
		const result = vectorSearchWithMetadata(wrapped, new Float32Array([1, 0, 0]), {
			limit: 2,
			readScope: { reach: { kind: "own", agentId: "alice" }, compartments: [], projects: null },
		});
		expect(result.results.map((row) => row.id)).toEqual(["v40", "v41"]);
		expect(probes).toEqual([8, 16, 32, 50]);
		expect(countedTables).toEqual(["vec_embeddings_rowids"]);
		expect(result.completeness).toBe("complete");
	} finally {
		db.close();
	}
});

import { Database, type SQLQueryBindings } from "bun:sqlite";
import { writeFileSync } from "node:fs";

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

test("exact scoped KNN bounds oversampling before selective admission", () => {
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
		const selectivePlans: string[] = [];
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
						if (sql.includes("v.id IN ("))
							selectivePlans.push(
								...db
									.prepare<{ detail: string }, SQLQueryBindings[]>(`EXPLAIN QUERY PLAN ${sql}`)
									.all(...bindings(args))
									.map((row) => row.detail),
							);
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
		expect(probes).toEqual([8, 16, 2]);
		expect(countedTables).toEqual(["vec_embeddings_rowids"]);
		expect(selectivePlans.length).toBeGreaterThan(0);
		expect(selectivePlans.filter((detail) => /eligible.*VIRTUAL TABLE/.test(detail))).toEqual([]);
		expect(result.completeness).toBe("complete");
	} finally {
		db.close();
	}
});

test("scoped KNN drives hits before embedding lookups for every limit from 1 through 64", () => {
	const db = new Database(":memory:");
	try {
		const extension = findSqliteVecExtension();
		if (!extension) throw new Error("sqlite-vec required");
		db.loadExtension(extension);
		db.exec(`CREATE TABLE memories(id TEXT PRIMARY KEY,agent_id TEXT,compartment_id INTEGER,project TEXT,visibility TEXT,type TEXT,source_type TEXT);
			CREATE TABLE embeddings(id TEXT PRIMARY KEY,source_id TEXT,agent_id TEXT,compartment_id INTEGER);
			CREATE INDEX idx_embeddings_compartment ON embeddings(agent_id,compartment_id);
			CREATE INDEX idx_memories_compartment ON memories(agent_id,compartment_id);
			CREATE VIRTUAL TABLE vec_embeddings USING vec0(id TEXT PRIMARY KEY,embedding FLOAT[3] distance_metric=cosine)`);
		const memory = db.prepare("INSERT INTO memories VALUES (?,'alice',NULL,NULL,'global','fact',NULL)");
		const embedding = db.prepare("INSERT INTO embeddings VALUES (?,?,'alice',NULL)");
		const projection = db.prepare("INSERT INTO vec_embeddings VALUES (?,?)");
		db.exec("BEGIN");
		for (let index = 0; index < 5000; index++) {
			const id = `memory-${String(index).padStart(5, "0")}`;
			memory.run(id);
			embedding.run(id, id);
			projection.run(id, new Float32Array([1, index / 5000, 0]));
		}
		db.exec("COMMIT");
		const plans: Array<{ limit: number; details: string[]; outer: string[] }> = [];
		let limit = 0;
		const observed = {
			exec: (sql: string) => {
				db.exec(sql);
			},
			prepare: (sql: string) => {
				const statement = db.prepare<Record<string, unknown>, SQLQueryBindings[]>(sql);
				return {
					run: (...args: unknown[]) => {
						statement.run(...bindings(args));
					},
					get: (...args: unknown[]) => statement.get(...bindings(args)),
					all: (...args: unknown[]) => {
						if (sql.startsWith("WITH hits AS MATERIALIZED")) {
							const plan = db
								.prepare<{ parent: number; detail: string }, SQLQueryBindings[]>(`EXPLAIN QUERY PLAN ${sql}`)
								.all(...bindings(args));
							plans.push({
								limit,
								details: plan.map((row) => row.detail),
								outer: plan
									.filter((row) => row.parent === 0 && /^(SCAN|SEARCH) /.test(row.detail))
									.map((row) => row.detail),
							});
						}
						return statement.all(...bindings(args));
					},
				};
			},
		};
		for (limit = 1; limit <= 64; limit++) {
			const result = vectorSearchWithMetadata(observed, new Float32Array([1, 0, 0]), {
				limit,
				excludeAggregateRecall: true,
				readScope: { reach: { kind: "own", agentId: "alice" }, compartments: [], projects: null },
			});
			expect(result.results.length).toBe(limit);
			expect(result.completeness).toBe("complete");
		}
		const output = process.env.SIGNET_KNN_PLAN_OUTPUT;
		if (output) writeFileSync(output, JSON.stringify(plans, null, 2), { flag: "wx" });
		expect(plans.length).toBe(64);
		expect(
			plans.filter(
				(plan) =>
					plan.outer[0] !== "SCAN hits" ||
					plan.details.some((detail) => /SEARCH e USING INDEX idx_embeddings_compartment/.test(detail)),
			),
		).toEqual([]);
	} finally {
		db.close();
	}
}, 30000);

import { Database, type SQLQueryBindings } from "bun:sqlite";
import { expect, test, spyOn } from "bun:test";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	compartmentFor,
	deleteCompartmentVectors,
	syncEmbeddingCompartment,
	admittedVectorPartitions,
	beginVectorAdmissionRepairInTx,
	stepVectorAdmissionRepairInTx,
	publishVectorAdmissionRepairInTx,
	repairVectorAdmissionStepInTx,
} from "./compartment-shards";
import { findSqliteVecExtension } from "./database";
import { runMigrations } from "./migrations";
import { readScopeSql, type ReadScope } from "./read-scope";
import { vectorSearchWithMetadata } from "./search";

function fixture(path = ":memory:"): Database {
	const db = new Database(path);
	if (path !== ":memory:") db.exec("PRAGMA journal_mode=WAL;PRAGMA synchronous=FULL");
	const extension = findSqliteVecExtension();
	if (!extension) throw new Error("sqlite-vec required");
	db.loadExtension(extension);
	runMigrations(db);
	db.exec(`DELETE FROM embedding_index_state;
		DROP TABLE IF EXISTS vec_embeddings;
		CREATE VIRTUAL TABLE vec_embeddings USING vec0(id TEXT PRIMARY KEY,embedding FLOAT[3] distance_metric=cosine);
		INSERT INTO agents(id,name,kind,created_at,updated_at) VALUES('other','Other','legacy','2020','2020'),('third','Third','legacy','2020','2020');
		INSERT INTO classifications(id,name) VALUES('cls_hidden_a','Hidden A'),('cls_hidden_b','Hidden B')`);
	repairVectorAdmissionStepInTx(db, "vec_embeddings", "embeddings");
	return db;
}
function add(db: Database, id: string, agent: string, offset: number, kind = "memory"): void {
	if (kind === "memory")
		db.prepare(
			"INSERT INTO memories(id,content,agent_id,visibility,type,created_at,updated_at) VALUES(?,? ,?,'global','fact','2020','2020')",
		).run(id, id, agent);
	db.prepare(
		"INSERT INTO embeddings(id,content_hash,source_id,source_type,agent_id,vector,dimensions,chunk_text,created_at) VALUES(?,?,?,?,?,?,3,'','2020')",
	).run(id, id, id, kind, agent, new Float32Array([1, offset, 0]));
	syncEmbeddingCompartment(db, "embeddings", id);
}
function bindings(values: readonly unknown[]): SQLQueryBindings[] {
	return values.map((value): SQLQueryBindings => {
		if (value === null) return null;
		if (
			typeof value === "string" ||
			typeof value === "number" ||
			typeof value === "boolean" ||
			typeof value === "bigint" ||
			value instanceof Uint8Array ||
			value instanceof Float32Array
		)
			return value;
		throw new Error("Unsupported binding");
	});
}
function observed(db: Database, windows: unknown[], plans?: string[]) {
	return {
		exec: (sql: string) => db.exec(sql),
		prepare: (sql: string) => {
			const q = db.prepare<Record<string, unknown>, SQLQueryBindings[]>(sql);
			return {
				run: (...args: unknown[]) => {
					q.run(...bindings(args));
				},
				get: (...args: unknown[]) => q.get(...bindings(args)),
				all: (...args: unknown[]) => {
					if (sql.includes("embedding MATCH")) windows.push(args[1]);
					if (plans && (sql.includes("FROM vector_shard_keys k WHERE") || sql.includes("embedding MATCH")))
						for (const row of db
							.prepare<Record<string, unknown>, SQLQueryBindings[]>("EXPLAIN QUERY PLAN " + sql)
							.all(...bindings(args)))
							if (typeof row.detail === "string") plans.push(row.detail);
					return q.all(...bindings(args));
				},
			};
		},
	};
}
test("single-row vector writes never scan admission payloads", () => {
	const db = fixture();
	try {
		add(db, "write-target", "default", 0);
		add(db, "unrelated", "other", 1);
		for (const sql of [
			"UPDATE embeddings SET vector=vector WHERE id='write-target'",
			"DELETE FROM embeddings WHERE id='write-target'",
		]) {
			const statement = db.prepare<Record<string, unknown>, []>(`EXPLAIN ${sql}`);
			try {
				const bytecode = statement.all();
				expect(bytecode.filter((row) => row.opcode === "VFilter" && row.p4 === "1")).toEqual([]);
			} finally {
				statement.finalize();
			}
		}
		db.exec("BEGIN IMMEDIATE;UPDATE embeddings SET vector=vector WHERE id='write-target';ROLLBACK");
		expect(recall(db).response.results.map((row) => row.id)).toEqual(["write-target"]);
		db.prepare("DELETE FROM embeddings WHERE id=?").run("write-target");
		expect(recall(db).response.results).toEqual([]);
		expect(
			recall(db, { ...own, reach: { kind: "own", agentId: "other" } }).response.results.map((row) => row.id),
		).toEqual(["unrelated"]);
	} finally {
		db.close();
	}
});

const own: ReadScope = {
	organizationMode: true,
	reach: { kind: "own", agentId: "default" },
	projects: null,
	compartments: [],
	inFlightUserId: "reader",
};
function recall(
	db: Database,
	scope: ReadScope = own,
	existingSnapshot = false,
	filters: Partial<Omit<import("./search").VectorSearchOptions, "readScope" | "limit">> = {},
) {
	const windows: unknown[] = [];
	const tracked = observed(db, windows);
	const kernel: typeof import("@signet/native") = createRequire(import.meta.url)("@signet/native");
	const original = kernel.scanAdmittedVectors;
	const admittedInputs: string[] = [];
	const scan = spyOn(kernel, "scanAdmittedVectors").mockImplementation((query, chunks, limit) => {
		windows.push(limit);
		const rows: string[] = [];
		for (const chunk of chunks)
			for (let row = 0; row < chunk.rowids.length / 8; row++) {
				if ((chunk.validity[row >> 3] & (1 << (row & 7))) === 0) continue;
				rows.push(
					JSON.stringify([
						chunk.rowids.readBigInt64LE(row * 8).toString(),
						(chunk.eligibility[row >> 3] >> (row & 7)) & 1,
						createHash("sha256")
							.update(chunk.vectors.subarray(row * query.length * 4, (row + 1) * query.length * 4))
							.digest("hex"),
					]),
				);
			}
		admittedInputs.push(createHash("sha256").update(JSON.stringify(rows.sort())).digest("hex"));
		return original(query, chunks, limit);
	});
	try {
		const response = vectorSearchWithMetadata(
			existingSnapshot ? { prepare: tracked.prepare } : tracked,
			new Float32Array([1, 0, 0]),
			{ limit: 2, currentOnly: true, memoryScope: null, readScope: scope, ...filters },
		);
		return { response, windows, admittedInputs };
	} finally {
		scan.mockRestore();
	}
}

function uncachedRecall(db: Database, scope: ReadScope = own) {
	db.exec("SAVEPOINT without_singletons");
	try {
		db.exec("DELETE FROM vector_shard_singletons");
		return recall(db, scope, true);
	} finally {
		db.exec("ROLLBACK TO without_singletons;RELEASE without_singletons");
	}
}

test("singleton distances match native payload overrides through mutation and purge", () => {
	const db = fixture();
	try {
		add(db, "a", "default", 0.6);
		add(db, "b", "default", 0.2);
		db.exec("UPDATE memories SET project=id WHERE id IN ('a','b')");
		syncEmbeddingCompartment(db, "embeddings", "a", undefined, new Float32Array([1, 0.05, 0]));
		expect(db.query("SELECT COUNT(*) n FROM vector_shard_singletons").get()).toEqual({ n: 2 });
		expect(recall(db).response.results.map((r) => r.id)).toEqual(["a", "b"]);
		expect(recall(db)).toEqual(uncachedRecall(db));
		add(db, "second-a", "default", 0.4);
		db.exec("UPDATE memories SET project='a' WHERE id='second-a'");
		expect(recall(db)).toEqual(uncachedRecall(db));
		db.exec("DELETE FROM embeddings WHERE id='second-a'");
		expect(recall(db)).toEqual(uncachedRecall(db));
		db.exec("UPDATE memories SET is_deleted=1 WHERE id='a'");
		expect(recall(db)).toEqual(uncachedRecall(db));
		db.exec("DELETE FROM memories;DELETE FROM embeddings");
		expect(db.query("SELECT COUNT(*) n FROM vector_shard_singletons").get()).toEqual({ n: 0 });
	} finally {
		db.close();
	}
});

test("admitted eligibility keeps nearest memory hits beyond non-memory vectors", () => {
	const db = fixture();
	try {
		add(db, "chunk-a", "default", 0, "source_chunk");
		add(db, "chunk-b", "default", 0.01, "source_chunk");
		for (let i = 0; i < 10; i++) add(db, `memory-${i}`, "default", 0.2 + i / 100);
		const result = recall(db);
		expect(result.response.completeness).toBe("complete");
		expect(result.response.results.map((row) => row.id)).toEqual(["memory-0", "memory-1"]);
		expect(result.windows).toEqual([2]);
		expect(result.admittedInputs).toHaveLength(1);
		deleteCompartmentVectors(db, ["chunk-a", "chunk-b"]);
		expect(recall(db).response.results.map((row) => row.id)).toEqual(["memory-0", "memory-1"]);
	} finally {
		db.close();
	}
});

test("shard sync keeps recall eligibility counts through parent and vector mutations", () => {
	const db = fixture();
	try {
		add(db, "count-a", "default", 0);
		add(db, "count-b", "default", 0.1);
		add(db, "count-chunk", "default", 0.2, "source_chunk");
		const counts = () =>
			db
				.query(
					"SELECT SUM(row_count) rows,SUM(recall_indexed_count) indexed_rows,SUM(recall_eligible_count) eligible FROM vector_shard_keys WHERE row_count>0",
				)
				.get();
		expect(counts()).toEqual({ rows: 3, indexed_rows: 3, eligible: 2 });
		db.exec("UPDATE memories SET stale_at='2020' WHERE id='count-a'");
		expect(counts()).toEqual({ rows: 3, indexed_rows: 3, eligible: 1 });
		db.exec("UPDATE memories SET scope='session' WHERE id='count-b'");
		expect(counts()).toEqual({ rows: 3, indexed_rows: 3, eligible: 0 });
		db.exec("UPDATE memories SET stale_at=NULL,scope=NULL");
		expect(counts()).toEqual({ rows: 3, indexed_rows: 3, eligible: 2 });
		db.exec("DELETE FROM embeddings WHERE id='count-a'");
		expect(counts()).toEqual({ rows: 2, indexed_rows: 2, eligible: 1 });
	} finally {
		db.close();
	}
});

test("memory and non-memory vectors use separate admitted KNN shards", () => {
	const db = fixture();
	try {
		db.exec("BEGIN");
		for (let i = 0; i < 128; i++) {
			add(db, `separate-memory-${i}`, "default", 0.2 + i / 1000);
			add(db, `separate-chunk-${i}`, "default", i / 1000, "source_chunk");
		}
		db.exec("COMMIT");
		const result = recall(db);
		expect(result.response.results.map((row) => row.id)).toEqual(["separate-memory-0", "separate-memory-1"]);
		expect(db.query("SELECT COUNT(*) n FROM vector_shard_keys WHERE row_count>0").get()).toEqual({ n: 2 });
		expect(result.windows).toHaveLength(1);
		expect(result.admittedInputs).toEqual([]);
	} finally {
		db.close();
	}
});

test("dense admitted shards stay inside SQLite through hidden mutations", () => {
	const db = fixture();
	try {
		db.exec("BEGIN");
		for (let i = 0; i < 128; i++) add(db, `dense-${i}`, "default", i / 1000);
		db.exec("UPDATE memories SET stale_at='2020' WHERE id LIKE 'dense-%' AND CAST(substr(id,7) AS INTEGER)<100;COMMIT");
		const before = recall(db);
		expect(before.response.completeness).toBe("complete");
		expect(before.response.results.map((row) => row.id)).toEqual(["dense-100", "dense-101"]);
		expect(before.admittedInputs).toEqual([]);
		expect(before.windows).toHaveLength(1);
		for (const limit of [1, 5, 20, 64]) {
			const plans: string[] = [];
			const response = vectorSearchWithMetadata(observed(db, [], plans), new Float32Array([1, 0, 0]), {
				limit,
				currentOnly: true,
				memoryScope: null,
				readScope: own,
			});
			expect(response.completeness).toBe("complete");
			expect(plans.some((plan) => plan.includes("SEARCH e USING INDEX"))).toBe(true);
			expect(plans.some((plan) => /^SCAN [em]\b/.test(plan))).toBe(false);
		}
		db.exec("BEGIN");
		for (let i = 0; i < 256; i++) add(db, `hidden-dense-${i}`, "other", 0);
		db.exec("COMMIT");
		expect(recall(db)).toEqual(before);
		db.exec("BEGIN");
		for (let i = 0; i < 16; i++)
			db.prepare(
				"INSERT INTO embeddings(id,content_hash,source_id,source_type,agent_id,vector,dimensions,chunk_text,created_at) VALUES(?,?,'dense-100','memory','default',?,3,'','2020')",
			).run(`duplicate-${i}`, `duplicate-${i}`, new Float32Array([1, i / 1000, 0]));
		db.exec("COMMIT");
		expect(recall(db).response.results.map((row) => row.id)).toEqual(["dense-100", "dense-101"]);
		db.exec("DELETE FROM embeddings WHERE id LIKE 'duplicate-%'");
		db.exec("UPDATE memories SET stale_at=NULL,scope='session' WHERE id='dense-0'");
		expect(recall(db).response.results).toEqual(before.response.results);
		db.exec("UPDATE memories SET scope=NULL WHERE id='dense-0'");
		expect(recall(db).response.results.map((row) => row.id)).toEqual(["dense-0", "dense-100"]);
	} finally {
		db.close();
	}
});

test("current filtering resolves a fourfold cohort in one native pass", () => {
	const db = fixture();
	try {
		for (let i = 0; i < 6; i++) add(db, `stale-${i}`, "default", i / 100);
		add(db, "current-a", "default", 0.2);
		add(db, "current-b", "default", 0.3);
		db.exec("UPDATE memories SET stale_at='2020' WHERE id LIKE 'stale-%'");
		const result = recall(db);
		expect(result.response.results.map((row) => row.id)).toEqual(["current-a", "current-b"]);
		expect(result.response.completeness).toBe("complete");
		expect(result.windows).toEqual([2]);
		expect(result.admittedInputs).toHaveLength(1);
	} finally {
		db.close();
	}
});

test.each([
	{ tags: "selected" },
	{ who: "selected" },
	{ pinned: true },
	{ importanceMin: 0.8 },
	{ since: "2021" },
	{ until: "2019" },
	{ project: "selected" },
])("metadata eligibility applies before the single native heap: %j", (filter) => {
	const db = fixture();
	try {
		add(db, "nearest-ineligible", "default", 0);
		add(db, "eligible-a", "default", 0.2);
		add(db, "eligible-b", "default", 0.3);
		db.exec(
			"UPDATE memories SET tags='selected',who='selected',pinned=1,importance=0.9,created_at='2022' WHERE id LIKE 'eligible-%'",
		);
		if ("until" in filter) db.exec("UPDATE memories SET created_at='2018' WHERE id LIKE 'eligible-%'");
		if ("project" in filter) db.exec("UPDATE memories SET project='selected' WHERE id LIKE 'eligible-%'");
		const result = recall(db, own, false, filter);
		expect(result.response.results.map((row) => row.id)).toEqual(["eligible-a", "eligible-b"]);
		expect(result.windows).toEqual([2]);
		expect(result.admittedInputs).toHaveLength(1);
	} finally {
		db.close();
	}
});

test("admitted fan-out batches 192 physical shards without losing the nearest hits", () => {
	const db = fixture();
	try {
		db.exec("BEGIN IMMEDIATE");
		for (let i = 0; i < 192; i++) {
			const agent = `fanout-${i}`;
			db.prepare("INSERT INTO agents(id,name,kind,created_at,updated_at) VALUES(?,?,'legacy','2020','2020')").run(
				agent,
				agent,
			);
			add(db, `admitted-${i}`, agent, i / 1000);
		}
		db.exec("COMMIT");
		const scope: ReadScope = { ...own, reach: { kind: "shared", agentId: "default" }, compartments: [] };
		const result = recall(db, scope);
		expect(result.response.results.map((r) => r.id)).toEqual(["admitted-0", "admitted-1"]);
		expect(result.windows.length).toBeLessThanOrEqual(1);
		const plans: string[] = [];
		admittedVectorPartitions(observed(db, [], plans), "vec_embeddings", scope);
		expect(plans.some((p) => p.includes("USING COVERING INDEX idx_vector_shard_keys_admission"))).toBe(true);
		for (let i = 0; i < 12; i++) {
			db.exec("BEGIN");
			add(db, `private-${i}`, "other", 0);
			db.prepare("UPDATE memories SET visibility='private' WHERE id=?").run(`private-${i}`);
			db.exec("COMMIT");
			expect(recall(db, scope)).toEqual(result);
			expect(uncachedRecall(db, scope)).toEqual(result);
		}
	} finally {
		db.close();
	}
});

test("a single admitted cohort cannot exceed the native candidate budget", () => {
	const db = fixture();
	try {
		for (const row of db
			.query<{ name: string }, []>(
				"SELECT name FROM temp.sqlite_master WHERE type='trigger' AND name GLOB 'vec_embeddings_admission_*'",
			)
			.all())
			db.exec(`DROP TRIGGER temp.${row.name}`);
		const memory = db.prepare(
			"INSERT INTO memories(id,content,agent_id,visibility,type,created_at,updated_at) VALUES(?,'fixture','default','global','fact','2020','2020')",
		);
		const embedding = db.prepare(
			"INSERT INTO embeddings(id,content_hash,source_id,source_type,agent_id,vector,dimensions,chunk_text,created_at) VALUES(?,?,?,'memory','default',?,3,'','2020')",
		);
		const key = db.prepare(
			"INSERT INTO vector_shard_keys(id,projection,generation,fingerprint,agent_id,visibility,in_flight_jobs) VALUES(?,'vec_embeddings',?,?,'default','global','[]')",
		);
		const vector = db.prepare("INSERT INTO vec_embeddings__admission_0(id,admission,embedding) VALUES(?,?,?)");
		const member = db.prepare("INSERT INTO vector_shard_members VALUES('vec_embeddings',?,?,?)");
		db.exec("BEGIN IMMEDIATE");
		for (let i = 0; i < 2050; i++) {
			const generation = i + 2,
				partition = i + 1;
			key.run(partition, generation, JSON.stringify(["default", "global", null, null, null, []]));
			for (let j = 0; j < 2; j++) {
				const id = `budget-${i}-${j}`;
				memory.run(id);
				embedding.run(id, id, id, new Float32Array([1, 0, 0]));
				vector.run(JSON.stringify([id, generation]), partition, new Float32Array([1, 0, 0]));
				member.run(generation, id, partition);
			}
		}
		db.prepare(
			"UPDATE vector_shard_repairs SET active_generation=2051,last_generation=2051 WHERE projection='vec_embeddings'",
		).run();
		db.exec("COMMIT");
		expect(recall(db)).toEqual({
			response: { results: [], completeness: "unavailable" },
			windows: [],
			admittedInputs: [],
		});
		const tracked = observed(db, []);
		const indexed = {
			...tracked,
			prepare(sql: string) {
				if (sql.includes("e.vector")) throw new Error("unexpected_cosine_fallback");
				return tracked.prepare(sql);
			},
		};
		expect(
			vectorSearchWithMetadata(indexed, new Float32Array([1, 0, 0]), { limit: 1, readScope: own }).results,
		).toHaveLength(1);
	} finally {
		db.close();
	}
});

test("hidden memory id collisions cannot turn source chunks into candidate work", () => {
	const db = fixture();
	try {
		add(db, "chunk-a", "default", 0, "source_chunk");
		add(db, "chunk-b", "default", 0.01, "source_chunk");
		add(db, "visible-a", "default", 0.2);
		add(db, "visible-b", "default", 0.3);
		const before = recall(db);
		expect(before.response.results.map((row) => row.id)).toEqual(["visible-a", "visible-b"]);
		expect(before.admittedInputs).toHaveLength(1);
		for (const id of ["chunk-a", "chunk-b"])
			db.prepare(
				"INSERT INTO memories(id,content,agent_id,visibility,type,created_at,updated_at) VALUES(?,'hidden','other','private','fact','2020','2020')",
			).run(id);
		expect(recall(db)).toEqual(before);
	} finally {
		db.close();
	}
});

test("hidden agent vectors cannot change a fully admitted shard's visible results", () => {
	const db = fixture();
	try {
		add(db, "chunk-a", "default", 0, "source_chunk");
		add(db, "chunk-b", "default", 0.01, "source_chunk");
		add(db, "visible-a", "default", 0.2);
		add(db, "visible-b", "default", 0.3);
		const before = recall(db);
		add(db, "hidden", "other", 10);
		expect(recall(db).response).toEqual(before.response);
		expect(recall(db).windows).toEqual(before.windows);
	} finally {
		db.close();
	}
});

test.each(
	[4097, 65537, 104729, 271828].flatMap((initialSeed) => [0, 63, 64].map((padding) => ({ initialSeed, padding }))),
)(
	"seeded hidden insertions deletions and reclassifications preserve ids order and windows: %j",
	({ initialSeed, padding }) => {
		const db = fixture();
		try {
			add(db, "visible-a", "default", 0.2);
			add(db, "visible-b", "default", 0.3);
			db.exec("UPDATE memories SET project=id WHERE id IN ('visible-a','visible-b');BEGIN");
			for (let i = 0; i < padding; i++) {
				add(db, `padding-${i}`, "default", 2 + i / 1000);
				db.prepare("UPDATE memories SET project='visible-a' WHERE id=?").run(`padding-${i}`);
			}
			db.exec("COMMIT");
			const compartments = [compartmentFor(db, ["cls_hidden_a"]), compartmentFor(db, ["cls_hidden_b"])];
			const before = recall(db);
			const states: ReturnType<typeof recall>[] = [];
			const hidden: string[] = [];
			expect(before.response.results.map((row) => row.id)).toEqual(["visible-a", "visible-b"]);
			const counts = { insertions: 0, deletions: 0, reclassifications: 0 };
			let seed = initialSeed;
			const random = () => {
				seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
				return seed;
			};
			for (let step = 0; step < 96; step++) {
				const action = step % 3;
				if (action === 0 || hidden.length === 0) {
					counts.insertions++;
					const id = `hidden-${step}`;
					hidden.push(id);
					add(db, id, "other", (random() % 100) / 10000);
				} else {
					const index = random() % hidden.length;
					const id = hidden[index];
					if (!id) throw new Error("fixture id missing");
					if (action === 1) {
						counts.deletions++;
						deleteCompartmentVectors(db, [id]);
						db.prepare("DELETE FROM embeddings WHERE id=?").run(id);
						db.prepare("DELETE FROM memories WHERE id=?").run(id);
						hidden.splice(index, 1);
					} else {
						counts.reclassifications++;
						db.prepare("UPDATE memories SET compartment_id=?,visibility=? WHERE id=?").run(
							compartments[random() % 2] ?? null,
							random() % 2 ? "global" : "private",
							id,
						);
						syncEmbeddingCompartment(db, "embeddings", id);
					}
				}
				const state = recall(db);
				states.push(state);
				expect(state).toEqual(uncachedRecall(db));
			}
			expect(Object.values(counts).every((count) => count > 0)).toBe(true);
			for (const state of states) expect(state).toEqual(before);
		} finally {
			db.close();
		}
	},
);

test("project and pending-target restrictions distinguish otherwise identical admission tuples", () => {
	const db = fixture();
	try {
		add(db, "visible-a", "default", 0.2);
		add(db, "visible-b", "default", 0.3);
		db.exec(
			"UPDATE memories SET project='alpha' WHERE id='visible-a';UPDATE memories SET project='beta' WHERE id='visible-b'",
		);
		expect(
			db.query("SELECT DISTINCT agent_id,visibility,compartment_id FROM memories ORDER BY agent_id").all(),
		).toEqual([{ agent_id: "default", visibility: "global", compartment_id: null }]);
		expect(recall(db, { ...own, projects: ["alpha"] }).response.results.map((row) => row.id)).toEqual(["visible-a"]);
		db.prepare(
			"INSERT INTO org_jobs(id,kind,status,params_json,created_at) VALUES('pending','classify','pending',?,'2020')",
		).run(JSON.stringify({ id: "cls_hidden_a", target: { kind: "memory", id: "visible-a", agentId: "default" } }));
		expect(recall(db).response.results.map((row) => row.id)).toEqual(["visible-b"]);
	} finally {
		db.close();
	}
});

test("randomized row predicates and physical shard admission agree for every reader", () => {
	const db = fixture();
	try {
		db.exec(
			"UPDATE agents SET policy_group='team' WHERE id='other';INSERT INTO classification_audience VALUES('cls_hidden_a','user','reader-a'),('cls_hidden_b','user','reader-b')",
		);
		const jobs = [
			{ id: "cls_hidden_a", target: { kind: "agent", id: "third", agentId: "third" } },
			{ id: "cls_hidden_b", target: { kind: "session", id: "run-1", agentId: "other" } },
			{ id: "cls_hidden_a", target: { kind: "source", id: "vault", agentId: "default" } },
			{ id: "cls_hidden_b", target: { kind: "memory", id: "row-0", agentId: "default" } },
		];
		for (const [i, job] of jobs.entries())
			db.prepare(
				"INSERT INTO org_jobs(id,kind,status,params_json,created_at) VALUES(?,'classify','pending',?,'2020')",
			).run(`job-${i}`, JSON.stringify(job));
		const compartments = [
			null,
			compartmentFor(db, ["cls_hidden_a"]),
			compartmentFor(db, ["cls_hidden_b"]),
			compartmentFor(db, ["cls_hidden_a", "cls_hidden_b"]),
		];
		let seed = 271828;
		const random = () => {
			seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
			return seed >>> 8;
		};
		for (let i = 0; i < 72; i++) {
			const agent = i === 0 ? "default" : (["default", "other", "third"][random() % 3] ?? "default");
			add(db, `row-${i}`, agent, (i + 1) / 100);
			db.prepare("UPDATE memories SET project=?,visibility=?,compartment_id=?,source_id=? WHERE id=?").run(
				[null, "alpha", "beta"][random() % 3] ?? null,
				[null, "private", "global", "archived"][random() % 4] ?? null,
				compartments[random() % 4] ?? null,
				i % 2 ? `session:run-${i % 3}` : `vault:doc-${i}`,
				`row-${i}`,
			);
			syncEmbeddingCompartment(db, "embeddings", `row-${i}`);
		}
		const scopes: ReadScope[] = [];
		for (const user of ["reader-a", "reader-b", "reader-none"])
			for (const reach of [
				{ kind: "own", agentId: "default" },
				{ kind: "own", agentId: "other" },
				{ kind: "all" },
				{ kind: "shared", agentId: "default" },
				{ kind: "group", agentId: "default", group: "team" },
			] as const)
				for (const projects of [null, ["alpha"], ["beta"]])
					for (const allowed of ["all", [], compartments.flatMap((c) => (c === null ? [] : [c]))] as const)
						scopes.push({ reach, projects, compartments: allowed, inFlightUserId: user });
		let members = db
			.query<{ embedding_id: string; partition_id: number }, []>(
				"SELECT embedding_id,partition_id FROM vector_shard_members WHERE projection='vec_embeddings'",
			)
			.all();
		expect(members.length).toBe(72);
		const check = () => {
			for (const scope of scopes) {
				const parent = readScopeSql("m", scope);
				const child = readScopeSql(
					"e",
					{ ...scope, projects: null, reach: scope.reach.kind === "own" ? scope.reach : { kind: "all" } },
					{ visibility: null, memory: "source_id", source: "source_id", session: null },
				);
				const predicate = new Set(
					db
						.prepare<{ id: string }, SQLQueryBindings[]>(
							`SELECT e.id FROM embeddings e JOIN memories m ON m.id=e.source_id WHERE 1=1${parent.sql}${child.sql}`,
						)
						.all(...bindings([...parent.args, ...child.args]))
						.map((r) => r.id),
				);
				const admitted = admittedVectorPartitions(db, "vec_embeddings", scope);
				if (!admitted) throw new Error("physical projection missing");
				const ids = new Set(admitted.ids);
				for (const row of members) expect(ids.has(row.partition_id)).toBe(predicate.has(row.embedding_id));
			}
		};
		check();
		for (const status of ["running", "complete", "failed"]) {
			db.prepare("UPDATE org_jobs SET status=? WHERE ?!='running' OR id='job-0'").run(status, status);
			check();
		}
		add(db, "late-failed-row", "third", 0.9);
		members = db
			.query<{ embedding_id: string; partition_id: number }, []>(
				"SELECT embedding_id,partition_id FROM vector_shard_members WHERE projection='vec_embeddings'",
			)
			.all();
		expect(members.length).toBe(73);
		check();
		db.exec("INSERT INTO classification_assignments VALUES('agent','third','third','cls_hidden_a',NULL,'2020')");
		check();
	} finally {
		db.close();
	}
});

test("classification preparation preserves old admission until verified atomic publication", () => {
	const db = fixture();
	try {
		add(db, "visible-a", "default", 0.2);
		add(db, "visible-b", "default", 0.3);
		const before = recall(db);
		db.prepare(
			"INSERT INTO org_jobs(id,kind,status,params_json,created_at) VALUES('prepare','classify-preparing','pending',?,'2020')",
		).run(JSON.stringify({ id: "cls_hidden_a", target: { kind: "memory", id: "visible-a", agentId: "default" } }));
		db.exec("BEGIN IMMEDIATE");
		beginVectorAdmissionRepairInTx(db, "vec_embeddings", "embeddings", "prepare");
		db.exec("COMMIT");
		expect(recall(db)).toEqual(before);
		let phase = "copying";
		for (let i = 0; i < 20 && phase !== "prepared"; i++) {
			db.exec("BEGIN IMMEDIATE");
			phase = stepVectorAdmissionRepairInTx(db, "vec_embeddings", 1).phase;
			db.exec("COMMIT");
			expect(recall(db)).toEqual(before);
		}
		expect(phase).toBe("prepared");
		db.exec("BEGIN IMMEDIATE");
		publishVectorAdmissionRepairInTx(db, "vec_embeddings", "prepare");
		db.exec("ROLLBACK");
		expect(recall(db)).toEqual(before);
		expect(db.query("SELECT kind FROM org_jobs WHERE id='prepare'").get()).toEqual({ kind: "classify-preparing" });
		db.exec("BEGIN IMMEDIATE");
		publishVectorAdmissionRepairInTx(db, "vec_embeddings", "prepare");
		db.exec("COMMIT");
		expect(recall(db).response.results.map((r) => r.id)).toEqual(["visible-b"]);
		expect(db.query("SELECT kind FROM org_jobs WHERE id='prepare'").get()).toEqual({ kind: "classify" });
	} finally {
		db.close();
	}
});

test("restarted connections preserve admission across preparation and publication crashes", () => {
	const directory = mkdtempSync(join(tmpdir(), "signet-vector-crash-"));
	const path = join(directory, "fixture.db");
	const extension = findSqliteVecExtension();
	if (!extension) throw new Error("sqlite-vec required");
	try {
		const db = fixture(path);
		db.exec("BEGIN IMMEDIATE");
		for (const [id, agent, offset] of [
			["a", "default", 0.1],
			["b", "default", 0.2],
			["c", "default", 0.3],
			["other-row", "other", 0.05],
		] as const) {
			add(db, id, agent, offset);
			db.prepare("UPDATE memories SET project='alpha' WHERE id=?").run(id);
		}
		db.prepare(
			"INSERT INTO org_jobs(id,kind,status,params_json,created_at) VALUES('restart-job','classify-preparing','pending',?,'2020')",
		).run(JSON.stringify({ id: "cls_hidden_a", target: { kind: "memory", id: "a", agentId: "default" } }));
		db.exec("COMMIT");
		db.close();
		const crash = (action: string, commit = true) => {
			const script = `import{Database}from'bun:sqlite';import{bindVectorAdmissionWriters,beginVectorAdmissionRepairInTx,stepVectorAdmissionRepairInTx,publishVectorAdmissionRepairInTx}from${JSON.stringify(import.meta.resolve("./compartment-shards"))};const db=new Database(${JSON.stringify(path)});db.loadExtension(${JSON.stringify(extension)});db.exec('PRAGMA synchronous=FULL');bindVectorAdmissionWriters(db);db.exec('BEGIN IMMEDIATE');${action};${commit ? "db.exec('COMMIT');" : ""}process.kill(process.pid,'SIGKILL');`;
			const result = Bun.spawnSync([process.execPath, "-e", script], { stdout: "pipe", stderr: "pipe" });
			expect({ signal: result.signalCode, error: new TextDecoder().decode(result.stderr) }).toEqual({
				signal: "SIGKILL",
				error: "",
			});
		};
		const inspect = (expected: readonly string[]) => {
			const reader = new Database(path, { readonly: true });
			reader.loadExtension(extension);
			try {
				expect(recall(reader, { ...own, projects: ["alpha"] }).response.results.map((r) => r.id)).toEqual([
					...expected,
				]);
				expect(
					recall(reader, { ...own, reach: { kind: "own", agentId: "other" } }).response.results.map((r) => r.id),
				).toEqual(["other-row"]);
				return reader
					.query<{ phase: string }, []>("SELECT phase FROM vector_shard_repairs WHERE projection='vec_embeddings'")
					.get()?.phase;
			} finally {
				reader.close();
			}
		};
		crash("beginVectorAdmissionRepairInTx(db,'vec_embeddings','embeddings','restart-job')");
		expect(inspect(["a", "b"])).toBe("copying");
		crash("stepVectorAdmissionRepairInTx(db,'vec_embeddings',1)");
		expect(inspect(["a", "b"])).toBe("copying");
		crash("db.prepare(\"UPDATE memories SET project='beta' WHERE id='b'\").run()");
		let phase = inspect(["a", "c"]);
		for (let i = 0; i < 10 && phase !== "prepared"; i++) {
			crash("stepVectorAdmissionRepairInTx(db,'vec_embeddings')");
			phase = inspect(["a", "c"]);
		}
		expect(phase).toBe("prepared");
		crash("publishVectorAdmissionRepairInTx(db,'vec_embeddings','restart-job')", false);
		expect(inspect(["a", "c"])).toBe("prepared");
		crash("publishVectorAdmissionRepairInTx(db,'vec_embeddings','restart-job')");
		expect(inspect(["c"])).toBe("ready");
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});

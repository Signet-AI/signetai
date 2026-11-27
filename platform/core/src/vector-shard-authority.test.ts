import { Database, type SQLQueryBindings } from "bun:sqlite";
import { expect, test } from "bun:test";
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
function observed(db: Database, windows: unknown[]) {
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
					return q.all(...bindings(args));
				},
			};
		},
	};
}
const own: ReadScope = {
	organizationMode: true,
	reach: { kind: "own", agentId: "default" },
	projects: null,
	compartments: [],
	inFlightUserId: "reader",
};
function recall(db: Database, scope: ReadScope = own) {
	const windows: unknown[] = [];
	const response = vectorSearchWithMetadata(observed(db, windows), new Float32Array([1, 0, 0]), {
		limit: 2,
		currentOnly: true,
		memoryScope: null,
		readScope: scope,
	});
	return { response, windows };
}

test("fully admitted public shard preserves main's plain KNN candidate window", () => {
	const db = fixture();
	try {
		add(db, "chunk-a", "default", 0, "source_chunk");
		add(db, "chunk-b", "default", 0.01, "source_chunk");
		for (let i = 0; i < 10; i++) add(db, `memory-${i}`, "default", 0.2 + i / 100);
		const result = recall(db);
		expect(result.response).toEqual({ results: [], completeness: "complete" });
		expect(result.windows).toEqual([2]);
		deleteCompartmentVectors(db, ["chunk-a", "chunk-b"]);
		expect(recall(db).response.results.map((row) => row.id)).toEqual(["memory-0", "memory-1"]);
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
		const result = recall(db, { ...own, reach: { kind: "all" }, compartments: "all" });
		expect(result.response.results.map((r) => r.id)).toEqual(["admitted-0", "admitted-1"]);
		expect(result.windows.length).toBeLessThanOrEqual(2);
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
		expect(recall(db)).toEqual({ response: { results: [], completeness: "unavailable" }, windows: [] });
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
		expect(before.response.results).toEqual([]);
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

test.each([4097, 65537, 104729, 271828])(
	"seeded hidden insertions deletions and reclassifications preserve ids order and windows: %s",
	(initialSeed) => {
		const db = fixture();
		try {
			add(db, "visible-a", "default", 0.2);
			add(db, "visible-b", "default", 0.3);
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
				states.push(recall(db));
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

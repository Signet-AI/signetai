import { Database, type SQLQueryBindings } from "bun:sqlite";
import { expect, test } from "bun:test";
import { compartmentFor, deleteCompartmentVectors, syncEmbeddingCompartment } from "./compartment-shards";
import { findSqliteVecExtension } from "./database";
import { runMigrations } from "./migrations";
import type { ReadScope } from "./read-scope";
import { vectorSearchWithMetadata } from "./search";

function fixture(): Database {
	const db = new Database(":memory:");
	const extension = findSqliteVecExtension();
	if (!extension) throw new Error("sqlite-vec required");
	db.loadExtension(extension);
	runMigrations(db);
	db.exec(`DELETE FROM embedding_index_state;
		DROP TABLE IF EXISTS vec_embeddings;
		CREATE VIRTUAL TABLE vec_embeddings USING vec0(id TEXT PRIMARY KEY,embedding FLOAT[3] distance_metric=cosine);
		INSERT INTO agents(id,name,kind,created_at,updated_at) VALUES('other','Other','legacy','2020','2020'),('third','Third','legacy','2020','2020');
		INSERT INTO classifications(id,name) VALUES('cls_hidden_a','Hidden A'),('cls_hidden_b','Hidden B')`);
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

import { expect, test } from "bun:test";
import { classificationFixture } from "./test-support/classification-fixture.test";
import { computeProjectionForQuery } from "./test-support/projection-query.test";
import { getQueueDiagnosticsSnapshot } from "./diagnostics-queue";
import { readDatabaseSchemaAsync, readTableSampleAsync } from "./routes/database-diagnostics";
import type { ReadDb } from "./db-accessor";
import type { ReadScope } from "./read-scope";

const scope: ReadScope = { reach: { kind: "all" }, compartments: [], projects: null };
const audience: ReadScope = { ...scope, compartments: [1] };

function fixture() {
	const db = classificationFixture();
	db.exec("INSERT INTO compartments(id,key) VALUES(1,'secret'); UPDATE memories SET compartment_id=1 WHERE id='m'");
	db.exec(
		"INSERT INTO memories(id,content,agent_id,created_at,updated_at) VALUES('visible','visible','default','2026-01-01','2026-01-01')",
	);
	return db;
}

test("projection geometry and pagination use only readable memories", async () => {
	const db = fixture();
	try {
		const insert = db.prepare(
			"INSERT INTO embeddings(id,content_hash,source_type,source_id,vector,dimensions,created_at,agent_id,compartment_id,chunk_text) VALUES(?,?,'memory',?,?,2,'now','default',?,'chunk')",
		);
		insert.run("visible-e", "visible-h", "visible", new Float32Array([1, 0]), null);
		const before = await computeProjectionForQuery(db, 2, { limit: 1, scope });
		insert.run("hidden-e", "hidden-h", "m", new Float32Array([0, 1]), 1);
		expect(await computeProjectionForQuery(db, 2, { limit: 1, scope })).toEqual(before);
		db.exec("UPDATE memories SET content='changed hidden content', created_at='9999' WHERE id='m'");
		expect(await computeProjectionForQuery(db, 2, { limit: 1, scope })).toEqual(before);
		expect((await computeProjectionForQuery(db, 2, { scope: audience })).count).toBe(2);
		db.exec("UPDATE memories SET compartment_id=1 WHERE id='visible'");
		expect((await computeProjectionForQuery(db, 2, { scope })).count).toBe(0);
		expect((await computeProjectionForQuery(db, 2, { scope: { ...audience, projects: [] } })).count).toBe(0);
	} finally {
		db.close();
	}
});

test("queue diagnostics scope counts and oldest ids before limits without shared cache", async () => {
	const db = fixture();
	try {
		const before = getQueueDiagnosticsSnapshot(db, { fresh: true, scope });
		db.exec(
			"INSERT INTO memory_jobs(id,memory_id,job_type,status,error,created_at,updated_at) VALUES('hidden-job','m','embed','dead','hidden error','2000','2000')",
		);
		expect(getQueueDiagnosticsSnapshot(db, { fresh: true, scope })).toEqual(before);
		db.exec("UPDATE memory_jobs SET error='changed secret', attempts=5 WHERE id='hidden-job'");
		expect(getQueueDiagnosticsSnapshot(db, { fresh: true, scope })).toEqual(before);
		expect(getQueueDiagnosticsSnapshot(db, { fresh: true, scope: audience }).oldestDeadMemoryJob?.id).toBe(
			"hidden-job",
		);
		db.exec("UPDATE memories SET compartment_id=NULL WHERE id='m'");
		expect(getQueueDiagnosticsSnapshot(db, { fresh: true, scope }).memory.dead).toBe(1);
	} finally {
		db.close();
	}
});

test("database samples and counts respect audience and deny unlabelled tables", async () => {
	const db = fixture();
	const accessor = {
		withReadDb<T>(fn: (db: ReadDb) => T): T {
			return fn(db);
		},
		withWriteTx<T>(fn: (db: ReadDb) => T): T {
			return fn(db);
		},
		close() {},
		async withReadDbAsync<T>(fn: (db: ReadDb) => T | Promise<T>): Promise<T> {
			return await fn(db);
		},
	};
	try {
		const sample = await readTableSampleAsync(accessor, "memories", 1, 0, scope);
		if ("error" in sample) throw new Error(sample.error);
		expect(sample.rowCount).toBe(1);
		expect(sample.rows.map((row) => row.id)).toEqual(["visible"]);
		db.exec("UPDATE memories SET content='updated hidden' WHERE id='m'");
		expect(await readTableSampleAsync(accessor, "memories", 1, 0, scope)).toEqual(sample);
		const schema = await readDatabaseSchemaAsync(accessor, scope);
		expect(schema.tables.find((t) => t.name === "memories")?.rowCount).toBe(1);
		const permitted = await readTableSampleAsync(accessor, "memories", 10, 0, audience);
		if ("error" in permitted) throw new Error(permitted.error);
		expect(permitted.rows).toHaveLength(2);
		expect(await readTableSampleAsync(accessor, "api_keys", 10, 0, scope)).toMatchObject({ status: 400 });
		db.exec("UPDATE memories SET compartment_id=1 WHERE id='visible'");
		const hidden = await readTableSampleAsync(accessor, "memories", 1, 0, scope);
		expect(hidden).toMatchObject({ rows: [], rowCount: 0, hasMore: false });
	} finally {
		db.close();
	}
});

test("diagnostic scopes preserve agent and project intersections and exclude archived agents", async () => {
	const db = fixture();
	try {
		db.exec("INSERT INTO agents(id,name,created_at,updated_at) VALUES('other','other','now','now')");
		db.exec("UPDATE memories SET project='atlas' WHERE id='visible'");
		db.exec(
			"INSERT INTO memories(id,content,agent_id,project,created_at,updated_at) VALUES('other-visible','other content','other','elsewhere','now','now')",
		);
		for (const id of ["visible", "other-visible"])
			db.prepare(
				"INSERT INTO embeddings(id,content_hash,chunk_text,source_type,source_id,vector,dimensions,created_at,agent_id) SELECT ?||'-e',?||'-h','chunk','memory',id,?,2,'now',agent_id FROM memories WHERE id=?",
			).run(id, id, new Float32Array([1, 0]), id);
		expect((await computeProjectionForQuery(db, 2, { scope })).count).toBe(2);
		expect(
			(await computeProjectionForQuery(db, 2, { scope: { ...scope, reach: { kind: "own", agentId: "default" } } }))
				.count,
		).toBe(1);
		expect(
			(await computeProjectionForQuery(db, 2, { scope: { ...scope, projects: ["atlas"] } })).result.nodes.map(
				(node) => node.id,
			),
		).toEqual(["visible"]);
		expect((await computeProjectionForQuery(db, 2, { scope: { ...scope, projects: [] } })).count).toBe(0);
		db.exec("UPDATE agents SET archived_at='now' WHERE id='other'");
		expect((await computeProjectionForQuery(db, 2, { scope })).result.nodes.map((node) => node.id)).toEqual([
			"visible",
		]);
		db.exec("UPDATE embeddings SET compartment_id=1 WHERE source_id='visible'");
		expect((await computeProjectionForQuery(db, 2, { scope })).count).toBe(0);
		expect((await computeProjectionForQuery(db, 2, { scope: audience })).count).toBe(1);
	} finally {
		db.close();
	}
});

test("projection workers release admission and terminate on cancellation before another projection", async () => {
	const { computeProjectionAsync, withProjectionAdmission } = await import("./embedding-projection-task");
	const rows = [1, 2, 3].map((index) => ({
		id: `memory-${index}`,
		content: `content ${index}`,
		who: null,
		importance: 0.5,
		type: "fact",
		tags: null,
		pinned: 0,
		source_type: "memory",
		source_id: `memory-${index}`,
		created_at: "2026",
		vector: new Uint8Array(new Float32Array([index, 1]).buffer),
		dimensions: 2,
	}));
	const controllers = [new AbortController(), new AbortController()];
	const pending = controllers.map((controller) =>
		withProjectionAdmission(() => computeProjectionAsync(rows, 2, controller.signal)),
	);
	const outcomes = Promise.allSettled(pending);
	await expect(withProjectionAdmission(() => computeProjectionAsync(rows, 2))).rejects.toThrow(
		"projection_admission_limit",
	);
	for (const controller of controllers) controller.abort(new Error("cancel projection"));
	for (const outcome of await outcomes) expect(outcome.status).toBe("rejected");
	const result = await withProjectionAdmission(() => computeProjectionAsync(rows, 2));
	expect(result.nodes.map((node) => node.id)).toEqual(["memory-1", "memory-2", "memory-3"]);
	expect(result.edges.length).toBeGreaterThan(0);
	for (const node of result.nodes) {
		expect(Number.isFinite(node.x)).toBe(true);
		expect(Number.isFinite(node.y)).toBe(true);
	}
});

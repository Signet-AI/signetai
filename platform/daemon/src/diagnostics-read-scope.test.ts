import { expect, test } from "bun:test";
import { classificationFixture } from "./test-support/classification-fixture.test";
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

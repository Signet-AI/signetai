import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { artifacts, up } from "./183-legacy-child-scope";
import { MIGRATIONS, runMigrations } from "./index";
import type { MigrationDb } from "./contract";

function repairFixture(size: number): Database {
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

test("legacy embedding pages use an ordered rowid range without a temporary sort", () => {
	const db = repairFixture(512);
	const plans: Record<string, unknown>[] = [];
	const database: MigrationDb = db;
	const observed: MigrationDb = {
		exec: (sql) => database.exec(sql),
		prepare: (sql) => {
			if (/SELECT child.rowid/.test(sql)) plans.push(...database.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(0));
			return database.prepare(sql);
		},
	};
	try {
		up(observed);
		expect(plans.length).toBeGreaterThan(0);
		expect(plans.some((row) => String(row.detail).includes("USE TEMP B-TREE"))).toBe(false);
	} finally {
		db.close();
	}
});

test("doubling legacy embeddings costs at most 2.5 times the repair time", () => {
	const measure = (size: number): number => {
		const db = repairFixture(size);
		try {
			const started = performance.now();
			up(db);
			const elapsed = performance.now() - started;
			expect(db.query("SELECT unresolved FROM legacy_child_scope_repairs WHERE table_name='embeddings'").get()).toEqual(
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
	expect(large / small).toBeLessThanOrEqual(2.5);
});

test("legacy vectors retain all parent-owned recall candidates after upgrade", () => {
	const db = new Database(":memory:");
	try {
		for (const migration of MIGRATIONS.filter((entry) => entry.version <= 175)) migration.up(db);
		const memory = db.prepare(
			"INSERT INTO memories(id,agent_id,content,created_at,updated_at) VALUES(?,?,?,'now','now')",
		);
		const embedding = db.prepare(
			"INSERT INTO embeddings(id,content_hash,vector,dimensions,source_type,source_id,chunk_text,created_at) VALUES(?,?,?,3,'memory',?,'fixture','now')",
		);
		db.exec("BEGIN");
		for (let index = 0; index < 6020; index++) {
			const id = `legacy-${index}`;
			memory.run(id, index % 2 === 0 ? "default" : "other", "Legacy evidence");
			embedding.run(id, id, new Float32Array([1, 0, 0]), id);
		}
		embedding.run("orphan", "orphan", new Float32Array([1, 0, 0]), "missing");
		db.exec("COMMIT");
		runMigrations(db);
		expect(
			db
				.query(
					"SELECT COUNT(*) AS n FROM embeddings e JOIN memories m ON m.id=e.source_id WHERE e.agent_id=m.agent_id AND e.compartment_id IS m.compartment_id",
				)
				.get(),
		).toEqual({ n: 6020 });
		expect(db.query("SELECT agent_id FROM embeddings WHERE id='orphan'").get()).toEqual({ agent_id: null });
		const migration = MIGRATIONS.find((entry) => entry.version === 183);
		if (!migration) throw new Error("Migration 183 missing");
		migration.up(db);
		expect(db.query("SELECT unresolved FROM legacy_child_scope_repairs WHERE table_name='embeddings'").get()).toEqual({
			unresolved: 1,
		});
		expect(db.query("SELECT COUNT(*) AS n FROM embeddings WHERE agent_id IS NOT NULL").get()).toEqual({ n: 6020 });
	} finally {
		db.close();
	}
});

test("partial checkpoint upgrades require one authoritative session owner", () => {
	const db = new Database(":memory:");
	try {
		db.exec(`CREATE TABLE session_checkpoints(id TEXT PRIMARY KEY,session_key TEXT,agent_id TEXT,compartment_id INTEGER);
			CREATE TABLE session_transcripts(session_key TEXT,agent_id TEXT,compartment_id INTEGER);
			CREATE TABLE session_claims(session_key TEXT,agent_id TEXT);
			INSERT INTO session_transcripts VALUES('one','owner',NULL),('mixed','owner',NULL);
			INSERT INTO session_claims VALUES('one','owner'),('mixed','other');
			INSERT INTO session_checkpoints VALUES('valid','one',NULL,NULL),('ambiguous','mixed',NULL,NULL),('orphan','absent',NULL,NULL);`);
		up(db);
		expect(db.query("SELECT id,agent_id FROM session_checkpoints ORDER BY id").all()).toEqual([
			{ id: "ambiguous", agent_id: null },
			{ id: "orphan", agent_id: null },
			{ id: "valid", agent_id: "owner" },
		]);
		expect(
			db.query("SELECT unresolved FROM legacy_child_scope_repairs WHERE table_name='session_checkpoints'").get(),
		).toEqual({ unresolved: 2 });
	} finally {
		db.close();
	}
});

test("partial schemas never erase a label when its membership table is missing", () => {
	const db = new Database(":memory:");
	try {
		db.exec(`CREATE TABLE memories(id TEXT PRIMARY KEY,agent_id TEXT,compartment_id INTEGER);
			CREATE TABLE memory_history(memory_id TEXT,agent_id TEXT,compartment_id INTEGER);
			INSERT INTO memories VALUES('private','owner',7);
			INSERT INTO memory_history VALUES('private',NULL,NULL);`);
		expect(() => up(db)).toThrow("legacy_scope_members_missing");
		expect(db.query("SELECT agent_id,compartment_id FROM memory_history").get()).toEqual({
			agent_id: null,
			compartment_id: null,
		});
	} finally {
		db.close();
	}
});

test("empty and partial legacy schemas are restart safe", () => {
	const db = new Database(":memory:");
	try {
		up(db);
		up(db);
		for (const table of artifacts.tables ?? [])
			expect(db.query("SELECT name FROM sqlite_master WHERE name=?").get(table)).toEqual({ name: table });
		db.exec(
			"CREATE TABLE embeddings(id TEXT PRIMARY KEY,agent_id TEXT); CREATE TABLE memories(id TEXT PRIMARY KEY,agent_id TEXT)",
		);
		up(db);
		expect(db.query("SELECT COUNT(*) AS n FROM legacy_child_scope_repairs").get()).toEqual({ n: 0 });
	} finally {
		db.close();
	}
});

test("child repairs union parent labels and leave missing or conflicting ownership unresolved", () => {
	const db = new Database(":memory:");
	try {
		db.exec(`CREATE TABLE compartments(id INTEGER PRIMARY KEY,key TEXT UNIQUE,created_at TEXT);
			CREATE TABLE compartment_members(compartment_id INTEGER,classification_id TEXT);
			CREATE TABLE classification_assignments(agent_id TEXT,target_kind TEXT,target_id TEXT,classification_id TEXT);
			INSERT INTO compartments VALUES(7,'cls_private','now'); INSERT INTO compartment_members VALUES(7,'cls_private');
			CREATE TABLE memories(id TEXT PRIMARY KEY,agent_id TEXT,compartment_id INTEGER);
			CREATE TABLE entities(id TEXT PRIMARY KEY,agent_id TEXT,compartment_id INTEGER);
			INSERT INTO memories VALUES('private','owner',7),('public','owner',NULL);
			INSERT INTO entities VALUES('same','owner',NULL),('foreign','other',NULL);
			CREATE TABLE memory_entity_mentions(memory_id TEXT,entity_id TEXT,agent_id TEXT,compartment_id INTEGER);
			INSERT INTO memory_entity_mentions VALUES('private','same',NULL,NULL),('public','foreign',NULL,NULL),('missing','same',NULL,NULL);
			CREATE TABLE embeddings(id TEXT PRIMARY KEY,source_id TEXT,source_type TEXT,agent_id TEXT,compartment_id INTEGER,vector BLOB,dimensions INTEGER,projection_compartment_id INTEGER);
			INSERT INTO embeddings VALUES('vector','private','memory',NULL,NULL,zeroblob(12),3,NULL);
			CREATE TABLE vec_embeddings(id TEXT PRIMARY KEY,embedding BLOB); INSERT INTO vec_embeddings VALUES('vector',zeroblob(12));`);
		up(db);
		up(db);
		expect(db.query("SELECT agent_id,compartment_id FROM memory_entity_mentions ORDER BY rowid").all()).toEqual([
			{ agent_id: "owner", compartment_id: 7 },
			{ agent_id: null, compartment_id: null },
			{ agent_id: null, compartment_id: null },
		]);
		expect(
			db
				.query("SELECT unresolved,repaired FROM legacy_child_scope_repairs WHERE table_name='memory_entity_mentions'")
				.get(),
		).toEqual({ unresolved: 2, repaired: 1 });
		expect(db.query("SELECT agent_id,compartment_id,projection_compartment_id FROM embeddings").get()).toEqual({
			agent_id: "owner",
			compartment_id: 7,
			projection_compartment_id: 7,
		});
		expect(db.query("SELECT COUNT(*) AS n FROM vec_embeddings").get()).toEqual({ n: 0 });
		expect(db.query("SELECT id FROM vec_embeddings__c7").all()).toEqual([{ id: "vector" }]);
	} finally {
		db.close();
	}
});

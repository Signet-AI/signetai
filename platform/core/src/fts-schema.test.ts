import { ensureCompartmentShards } from "./compartment-shards";
import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import {
	createMemoriesFts,
	refreshMemoriesFtsState,
	recreateMemoriesFts,
	readMemoriesFtsIntegrity,
	memoriesFtsIntegrityIsComplete,
} from "./fts-schema";

let database: Database | null = null;

afterEach(() => {
	database?.close();
	database = null;
});

describe("memories FTS state triggers", () => {
	test("keep counters aligned after mutations of unindexed rows", () => {
		database = new Database(":memory:");
		database.exec("CREATE TABLE memories (content TEXT NOT NULL)");
		for (let index = 0; index < 7; index += 1) {
			database.prepare("INSERT INTO memories (content) VALUES (?)").run(`core old ${index}`);
		}

		createMemoriesFts(database);
		const generation = database.prepare("PRAGMA schema_version").get();
		createMemoriesFts(database);
		expect(database.prepare("PRAGMA schema_version").get()).toEqual(generation);
		database.exec("INSERT INTO memories_fts(rowid, content) SELECT rowid, content FROM memories WHERE rowid <= 2");
		refreshMemoriesFtsState(database);

		database.prepare("DELETE FROM memories WHERE rowid = ?").run(7);
		database.prepare("UPDATE memories SET content = ? WHERE rowid = ?").run("core updated", 6);

		const state = database.prepare("SELECT memory_count, indexed_count FROM memories_fts_state").get() as {
			memory_count: number;
			indexed_count: number;
		};
		const physical = database.prepare("SELECT COUNT(*) AS count FROM memories_fts_docsize").get() as { count: number };
		const updated = database
			.prepare("SELECT COUNT(*) AS count FROM memories_fts WHERE memories_fts MATCH ?")
			.get("updated") as { count: number };

		expect(state).toEqual({ memory_count: 6, indexed_count: physical.count });
		expect(physical.count).toBe(3);
		expect(updated.count).toBe(1);
	});
});

test("FTS runtime repair and integrity counters exclude classified rows across moves", () => {
	const db = new Database(":memory:");
	db.exec("CREATE TABLE memories(content TEXT NOT NULL,compartment_id INTEGER)");
	createMemoriesFts(db);
	const generation = db.prepare("PRAGMA schema_version").get();
	createMemoriesFts(db);
	expect(db.prepare("PRAGMA schema_version").get()).toEqual(generation);
	ensureCompartmentShards(db, 1, 0);
	db.exec("INSERT INTO memories VALUES('public apple',NULL),('hidden apple',1)");
	refreshMemoriesFtsState(db);
	expect(db.prepare("SELECT memory_count,indexed_count FROM memories_fts_state").get()).toEqual({
		memory_count: 1,
		indexed_count: 1,
	});
	db.exec("UPDATE memories SET compartment_id=1 WHERE content='public apple'");
	expect(db.prepare("SELECT memory_count,indexed_count FROM memories_fts_state").get()).toEqual({
		memory_count: 0,
		indexed_count: 0,
	});
	recreateMemoriesFts(db);
	const integrity = readMemoriesFtsIntegrity(db);
	if (!integrity) throw new Error("missing integrity state");
	expect(memoriesFtsIntegrityIsComplete(integrity)).toBe(true);
	expect(db.prepare("SELECT count(*) n FROM memories_fts WHERE memories_fts MATCH 'apple'").get()).toEqual({ n: 0 });
	db.exec("UPDATE memories SET compartment_id=NULL WHERE content='public apple'");
	expect(db.prepare("SELECT count(*) n FROM memories_fts WHERE memories_fts MATCH 'apple'").get()).toEqual({ n: 1 });
	db.close();
});

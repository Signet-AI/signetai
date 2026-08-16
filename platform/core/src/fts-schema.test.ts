import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { createMemoriesFts, refreshMemoriesFtsState } from "./fts-schema";

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

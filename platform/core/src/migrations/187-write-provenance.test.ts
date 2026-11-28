import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { MIGRATIONS } from "./index";

test("cold copies inherit provenance on upgrade and remain restart safe", () => {
	const db = new Database(":memory:");
	try {
		for (const migration of MIGRATIONS.filter((entry) => entry.version <= 186)) migration.up(db);
		db.exec(
			"INSERT INTO memories(id,agent_id,author_user_id,content,created_at,updated_at) VALUES('memory','owner','departed','secret','now','now')",
		);
		db.prepare(
			"INSERT INTO memories_cold(archive_id,memory_id,agent_id,content,original_created_at,archived_at,original_row_json) VALUES('copy','memory','owner','secret','now','now',?)",
		).run(JSON.stringify({ id: "memory", agent_id: "owner", author_user_id: "departed", compartment_id: null }));
		for (const migration of MIGRATIONS.filter((entry) => entry.version > 186)) migration.up(db);
		expect(db.query("SELECT agent_id,author_user_id,compartment_id FROM memories_cold").get()).toEqual({
			agent_id: "owner",
			author_user_id: "departed",
			compartment_id: null,
		});
		const migration = MIGRATIONS.find((entry) => entry.version === 187);
		if (!migration) throw new Error("Migration 187 missing");
		migration.up(db);
		expect(db.query("SELECT COUNT(*) AS n FROM memories_cold").get()).toEqual({ n: 1 });
	} finally {
		db.close();
	}
});

test("fresh install and upgrade from v175 have the same schema", () => {
	const fresh = new Database(":memory:");
	const legacy = new Database(":memory:");
	try {
		for (const migration of MIGRATIONS) migration.up(fresh);
		for (const migration of MIGRATIONS.filter((entry) => entry.version <= 175)) migration.up(legacy);
		legacy.exec(
			"INSERT INTO memories(id,agent_id,content,created_at,updated_at) VALUES('legacy','owner','evidence','now','now')",
		);
		for (const migration of MIGRATIONS.filter((entry) => entry.version > 175)) migration.up(legacy);
		const schema = (db: Database) =>
			db
				.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name")
				.all();
		expect(schema(legacy)).toEqual(schema(fresh));
		expect(legacy.prepare("SELECT content FROM memories WHERE id='legacy'").get()).toEqual({ content: "evidence" });
		const migration = MIGRATIONS.find((entry) => entry.version === 187);
		if (!migration) throw new Error("Migration 187 missing");
		migration.up(legacy);
		expect(schema(legacy)).toEqual(schema(fresh));
	} finally {
		fresh.close();
		legacy.close();
	}
});

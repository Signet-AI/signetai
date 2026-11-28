import { Database } from "bun:sqlite";
import type { MigrationDb } from "./contract";
import { up as registry } from "./185-import-content-registry";
import { up as classifications } from "./177-classifications";
import { up as leases } from "./179-dreaming-evidence-leases";
import { MIGRATIONS, runMigrations } from "./index";
import { expect, test } from "bun:test";

for (const [version, migration, seed] of [
	[
		177,
		classifications,
		"INSERT INTO entities(id,name,entity_type,agent_id,created_at,updated_at,proposal_evidence) VALUES(? ,?,'project','default','now','now','[\"memory:evidence\"]')",
	],
	[
		179,
		leases,
		"INSERT INTO memory_history(id,memory_id,event,changed_by,reason,created_at) VALUES(?,'evidence','created','test','test','now')",
	],
	[
		185,
		registry,
		"INSERT INTO memory_artifacts(agent_id,source_id,source_kind,source_external_id,source_path,source_sha256,session_id,session_token,captured_at,updated_at) VALUES('default',?,'source_import_text',printf('%064d',1),?,'hash','unbound','unbound','now','now')",
	],
] as const) {
	test(`migration ${version} bounds corpus reads while retaining all backfilled rows`, () => {
		const db = new Database(":memory:");
		try {
			for (const entry of MIGRATIONS.filter((entry) => entry.version < version)) entry.up(db);
			db.exec(
				"INSERT INTO memories(id,agent_id,content,created_at,updated_at) VALUES('evidence','default','Evidence','now','now')",
			);
			const insert = db.prepare(seed);
			db.transaction(() => {
				for (let i = 0; i < 513; i++) {
					if (version === 179) insert.run(`row${i}`);
					else if (version === 177) insert.run(`row${i}`, `Row ${i}`);
					else insert.run(`source${i}`, `path${i}`);
				}
			})();
			const database: MigrationDb = db;
			const bounded: MigrationDb = {
				exec: (sql) => database.exec(sql),
				prepare: (sql) => {
					const statement = database.prepare(sql);
					return {
						run: (...args) => statement.run(...args),
						get: (...args) => statement.get(...args),
						all: (...args) => {
							const rows = statement.all(...args);
							if (!/sqlite_master|PRAGMA|pragma_/i.test(sql)) expect(rows.length).toBeLessThanOrEqual(256);
							return rows;
						},
					};
				},
			};
			migration(bounded);
			const table =
				version === 177 ? "evidence_citations" : version === 179 ? "memory_history" : "import_content_registry";
			expect(db.query(`SELECT COUNT(*) n FROM ${table}`).get()).toEqual({ n: 513 });
		} finally {
			db.close();
		}
	});
}

test("alias creator backfills seek by alias identity rather than rescanning each agent", () => {
	const db = new Database(":memory:");
	try {
		for (const entry of MIGRATIONS.filter((entry) => entry.version < 179)) entry.up(db);
		const database: MigrationDb = db;
		const plans: string[] = [];
		leases({
			prepare: (sql) => database.prepare(sql),
			exec: (sql) => {
				if (sql.trimStart().startsWith("UPDATE entity_aliases SET")) {
					const statement = sql.split(";")[0];
					if (!statement) throw new Error("Alias backfill missing");
					const explain = database.prepare(`EXPLAIN QUERY PLAN ${statement}`);
					plans.push(...explain.all().map((row) => String(row.detail)));
					explain.finalize?.();
				}
				database.exec(sql);
			},
		});
		expect(plans.length).toBeGreaterThan(0);
		expect(plans.filter((detail) => /SEARCH p /.test(detail)).every((detail) => detail.includes("<expr>=?"))).toBe(
			true,
		);
		expect(plans.some((detail) => /SCAN p|USE TEMP B-TREE/.test(detail))).toBe(false);
	} finally {
		db.close();
	}
});

test("v175 upgrades match a fresh schema after repairing every unshipped migration", () => {
	const db = new Database(":memory:");
	const fresh = new Database(":memory:");
	try {
		for (const entry of MIGRATIONS.filter((entry) => entry.version <= 175)) entry.up(db);
		runMigrations(db);
		runMigrations(fresh);
		const schema = (db: Database) =>
			db
				.query("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name")
				.all();
		expect(schema(db)).toEqual(schema(fresh));
		for (let version = 176; version <= 186; version++) {
			db.prepare("DELETE FROM schema_migrations WHERE version=?").run(version);
			runMigrations(db);
			expect(schema(db)).toEqual(schema(fresh));
		}
	} finally {
		db.close();
		fresh.close();
	}
});

import { Database } from "bun:sqlite";
import type { MigrationDb } from "./contract";
import { up as registry } from "./185-import-content-registry";
import { up as classifications } from "./177-classifications";
import { up as leases } from "./179-dreaming-evidence-leases";
import { up as authority } from "./184-credential-authority";
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

test("credential ancestry backfill seeks creation events by target identity", () => {
	const db = new Database(":memory:");
	try {
		for (const entry of MIGRATIONS.filter((entry) => entry.version < 184)) entry.up(db);
		const database: MigrationDb = db;
		const plans: string[] = [];
		authority({
			prepare: (sql) => database.prepare(sql),
			exec: (sql) => {
				const update = sql.split(";").find((part) => part.trimStart().startsWith("UPDATE api_keys SET parent_key_id"));
				if (update) {
					const explain = database.prepare(`EXPLAIN QUERY PLAN ${update}`);
					plans.push(...explain.all().map((row) => String(row.detail)));
					explain.finalize?.();
				}
				database.exec(sql);
			},
		});
		expect(plans.filter((detail) => /SEARCH a /.test(detail)).length).toBeGreaterThan(0);
		expect(plans.filter((detail) => /SEARCH a /.test(detail)).every((detail) => detail.includes("target_id=?"))).toBe(
			true,
		);
	} finally {
		db.close();
	}
});

test("legacy artifact citations use an indexed latest-reference lookup", () => {
	const db = new Database(":memory:");
	try {
		for (const entry of MIGRATIONS.filter((entry) => entry.version < 177)) entry.up(db);
		db.exec(`INSERT INTO entities(id,name,entity_type,agent_id,created_at,updated_at,proposal_evidence) VALUES('lookup-entity','Lookup','project','default','now','now','[{"source_id":"lookup-ref"}]');
			INSERT INTO memory_artifacts(agent_id,source_path,source_kind,source_sha256,session_id,session_token,source_node_id,captured_at,updated_at) VALUES('default','lookup/path','file','hash','unbound','unbound','lookup-ref','now','now');`);
		const database: MigrationDb = db;
		const plans: string[] = [];
		classifications({
			exec: (sql) => database.exec(sql),
			prepare: (sql) => {
				const statement = database.prepare(sql);
				return {
					run: (...args) => statement.run(...args),
					all: (...args) => statement.all(...args),
					get: (...args) => {
						if (sql.includes("SELECT source_path FROM") && sql.includes("ORDER BY captured_at")) {
							const explain = database.prepare(`EXPLAIN QUERY PLAN ${sql}`);
							plans.push(...explain.all(...args).map((row) => String(row.detail)));
							explain.finalize?.();
						}
						return statement.get(...args);
					},
				};
			},
		});
		expect(plans.length).toBeGreaterThan(0);
		expect(plans.some((detail) => detail.includes("USE TEMP B-TREE"))).toBe(false);
		expect(
			db.query("SELECT evidence_kind,evidence_id FROM evidence_citations WHERE derived_id='lookup-entity'").all(),
		).toEqual([{ evidence_kind: "artifact", evidence_id: "lookup/path" }]);
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

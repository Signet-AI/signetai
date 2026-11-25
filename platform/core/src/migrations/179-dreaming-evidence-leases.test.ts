import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { MIGRATIONS, runMigrations } from "./index";

function upgraded(): Database {
	const db = new Database(":memory:");
	runMigrations(db);
	return db;
}

describe("Dreaming lease migration", () => {
	it("snapshots classification epochs and preserves them across idempotent upgrades", () => {
		const db = upgraded();
		try {
			db.exec(
				"INSERT INTO dreaming_passes (id, agent_id, mode, status, created_at) VALUES ('before','default','incremental','running','now')",
			);
			expect(db.query("SELECT classification_epoch FROM dreaming_passes WHERE id='before'").get()).toEqual({
				classification_epoch: 0,
			});
			db.exec("INSERT INTO classifications (id,name) VALUES ('cls_secret','Secret')");
			db.exec(
				"INSERT INTO classification_assignments (target_kind,target_id,agent_id,classification_id) VALUES ('agent','alice','alice','cls_secret')",
			);
			db.exec("UPDATE classification_assignments SET applied_by='usr_alice'");
			db.exec("DELETE FROM classification_assignments");
			expect(db.query("SELECT epoch FROM dreaming_classification_epoch WHERE id=1").get()).toEqual({ epoch: 3 });
			db.exec(
				"INSERT INTO dreaming_passes (id, agent_id, mode, status, created_at) VALUES ('after','default','incremental','running','now')",
			);
			expect(db.query("SELECT classification_epoch FROM dreaming_passes WHERE id='after'").get()).toEqual({
				classification_epoch: 3,
			});
			const migration = MIGRATIONS.find((item) => item.version === 179);
			if (!migration) throw new Error("migration 179 missing");
			migration.up(db);
			expect(db.query("SELECT classification_epoch FROM dreaming_passes WHERE id='before'").get()).toEqual({
				classification_epoch: 0,
			});
			expect(db.query("SELECT epoch FROM dreaming_classification_epoch WHERE id=1").get()).toEqual({ epoch: 3 });
			for (const sql of [
				"SELECT dreaming_pass_id FROM ontology_proposals",
				"SELECT compartment_id FROM memory_head_revisions",
				"SELECT compartment_id FROM memory_head_publications",
			])
				expect(() => db.query(sql).all()).not.toThrow();
		} finally {
			db.close();
		}
	});
	it("keeps public and classified history indexes independent including NULL uniqueness", () => {
		const db = upgraded();
		try {
			db.exec(
				"INSERT INTO dreaming_history_nodes (agent_id,scope_key,level,idx,text,compartment_id) VALUES ('alice','alice',0,0,'public',NULL)",
			);
			expect(() =>
				db.exec(
					"INSERT INTO dreaming_history_nodes (agent_id,scope_key,level,idx,text,compartment_id) VALUES ('alice','alice',0,0,'secret',1)",
				),
			).not.toThrow();
			expect(() =>
				db.exec(
					"INSERT INTO dreaming_history_nodes (agent_id,scope_key,level,idx,text,compartment_id) VALUES ('alice','alice',0,0,'duplicate',NULL)",
				),
			).toThrow();
		} finally {
			db.close();
		}
	});

	it("rebuilds attributable legacy leaves and removes unproven merged history without deleting pass records", () => {
		const db = new Database(":memory:");
		try {
			for (const migration of MIGRATIONS.filter((migration) => migration.version < 179)) migration.up(db);
			db.exec(`INSERT INTO dreaming_passes (id,agent_id,scope_key,mode,status,compartment_id)
			VALUES ('public','alice','alice','incremental','completed',NULL),('secret','alice','alice','incremental','completed',1),('other','bob','bob','incremental','completed',NULL)`);
			db.exec(`INSERT INTO dreaming_history_nodes (agent_id,scope_key,level,idx,pass_id,text,compartment_id)
			VALUES ('alice','alice',0,0,'public','public leaf',NULL),('alice','alice',0,1,'secret','secret leaf',1),
			('alice','alice',0,2,'other','wrong owner',NULL),('alice','alice',1,0,NULL,'unproven aggregate',NULL)`);
			const migration = MIGRATIONS.find((migration) => migration.version === 179);
			if (!migration) throw new Error("migration missing");
			migration.up(db);
			expect(db.query("SELECT text,idx,compartment_id FROM dreaming_history_nodes ORDER BY text").all()).toEqual([
				{ text: "public leaf", idx: 0, compartment_id: null },
				{ text: "secret leaf", idx: 0, compartment_id: 1 },
			]);
			expect(db.query("SELECT COUNT(*) AS n FROM dreaming_passes").get()).toEqual({ n: 3 });
			db.exec(
				"INSERT INTO dreaming_history_nodes (agent_id,scope_key,level,idx,text) VALUES ('alice','alice',1,0,'new attributable aggregate')",
			);
			migration.up(db);
			expect(db.query("SELECT COUNT(*) AS n FROM dreaming_history_nodes").get()).toEqual({ n: 3 });
		} finally {
			db.close();
		}
	});
});

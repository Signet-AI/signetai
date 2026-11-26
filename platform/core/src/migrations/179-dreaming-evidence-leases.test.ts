import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { MIGRATIONS, runMigrations } from "./index";

function upgraded(): Database {
	const db = new Database(":memory:");
	runMigrations(db);
	return db;
}

describe("Dreaming lease migration", () => {
	it("backfills legacy alias labels and only same-agent creating evidence", () => {
		const db = new Database(":memory:");
		try {
			for (const migration of MIGRATIONS.filter((migration) => migration.version < 179)) migration.up(db);
			db.exec(`INSERT INTO classifications(id,name) VALUES('cls_alias','Alias');
				INSERT INTO compartments(id,key) VALUES(17,'cls_alias');
				INSERT INTO compartment_members VALUES(17,'cls_alias');
				INSERT INTO entities(id,name,canonical_name,entity_type,agent_id,created_at,updated_at) VALUES('parent','Atlas','atlas','project','default','now','now');
				INSERT INTO memories(id,agent_id,content,compartment_id,created_at,updated_at)
				VALUES('own-source','default','Private alias',17,'now','now'),('foreign-source','other','Foreign alias',17,'now','now');
				INSERT INTO ontology_proposals(id,agent_id,operation,payload,evidence,status,result,created_by,created_at,updated_at,compartment_id)
				VALUES('creator','default','create_entity_alias','{}','[{"source_ref":"memory:own-source","quote":"Private alias"},{"source_ref":"memory:foreign-source","quote":"Foreign alias"}]','applied','{"aliasId":"private-alias"}','dreaming','now','now',17);
				INSERT INTO entity_aliases(id,entity_id,alias,canonical_alias,agent_id,created_at,updated_at)
				VALUES('private-alias','parent','Compensation Review','compensation review','default','now','now');`);
			const migration = MIGRATIONS.find((migration) => migration.version === 179);
			if (!migration) throw new Error("migration missing");
			migration.up(db);
			migration.up(db);
			expect(db.query("SELECT compartment_id FROM entity_aliases WHERE id='private-alias'").get()).toEqual({
				compartment_id: 17,
			});
			expect(db.query("SELECT compartment_id FROM entities WHERE id='parent'").get()).toEqual({ compartment_id: null });
			expect(
				db
					.query(
						"SELECT derived_kind,derived_id,evidence_id FROM evidence_citations WHERE derived_kind IN ('alias','proposal') ORDER BY derived_kind",
					)
					.all(),
			).toEqual([
				{ derived_kind: "alias", derived_id: "private-alias", evidence_id: "own-source" },
				{ derived_kind: "proposal", derived_id: "creator", evidence_id: "own-source" },
			]);
			expect(() =>
				db.exec(
					"INSERT INTO entity_aliases(id,entity_id,alias,canonical_alias,agent_id,created_at,updated_at) VALUES('public-alias','parent','Compensation Review','compensation review','default','now','now')",
				),
			).not.toThrow();
			db.exec("DELETE FROM memories WHERE id='own-source'");
			expect(db.query("SELECT id FROM entity_aliases ORDER BY id").all()).toEqual([{ id: "public-alias" }]);
			expect(db.query("SELECT id FROM entities WHERE id='parent'").get()).toEqual({ id: "parent" });
			expect(db.query("SELECT * FROM evidence_citations WHERE evidence_id='own-source'").all()).toEqual([]);
		} finally {
			db.close();
		}
	});

	it("backfills every pass-writable child from its owned parents without losing rows", () => {
		const db = new Database(":memory:");
		try {
			for (const migration of MIGRATIONS.filter((migration) => migration.version < 179)) migration.up(db);
			db.exec(`INSERT INTO classifications(id,name) VALUES('cls_child','Child');
				INSERT INTO compartments(id,key) VALUES(19,'cls_child'); INSERT INTO compartment_members VALUES(19,'cls_child');
				INSERT INTO entities(id,name,canonical_name,entity_type,agent_id,compartment_id,created_at,updated_at)
				VALUES('child-parent','Atlas','atlas','project','default',19,'now','now'),('other-parent','Orion','orion','project','default',NULL,'now','now');
				INSERT INTO memories(id,agent_id,content,compartment_id,created_at,updated_at) VALUES('child-memory','default','Private claim',19,'now','now');
				INSERT INTO memory_entity_mentions(memory_id,entity_id) VALUES('child-memory','child-parent');
				INSERT INTO derived_memory_sources(derived_memory_id,agent_id,source_kind,source_id,created_at) VALUES('child-memory','default','memory','child-memory','now');
				INSERT INTO memory_history(id,memory_id,event,old_content,new_content,changed_by,reason,created_at) VALUES('child-history','child-memory','created',NULL,'Private claim','dreaming','Fixture','now');
				INSERT INTO relations(id,source_entity_id,target_entity_id,relation_type,created_at) VALUES('child-relation','child-parent','other-parent','related_to','now');`);
			const migration = MIGRATIONS.find((migration) => migration.version === 179);
			if (!migration) throw new Error("migration missing");
			migration.up(db);
			migration.up(db);
			for (const table of ["memory_entity_mentions", "derived_memory_sources", "memory_history", "relations"] as const)
				expect(db.query(`SELECT agent_id,compartment_id,dreaming_pass_id FROM ${table}`).all()).toEqual([
					{ agent_id: "default", compartment_id: 19, dreaming_pass_id: null },
				]);
			expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
		} finally {
			db.close();
		}
	});

	it("preserves community evidence citations introduced by migration 178", () => {
		const db = new Database(":memory:");
		try {
			for (const migration of MIGRATIONS.filter((migration) => migration.version < 179)) migration.up(db);
			db.exec(
				"INSERT INTO entity_communities(id,agent_id,name) VALUES('community-before','default','Community before upgrade')",
			);
			db.exec(
				"INSERT INTO memories(id,agent_id,content,created_at,updated_at) VALUES('source-before','default','Community evidence',datetime('now'),datetime('now'))",
			);
			db.exec(
				"INSERT INTO evidence_citations(derived_kind,derived_id,agent_id,evidence_kind,evidence_id) VALUES('community','community-before','default','memory','source-before')",
			);
			const migration = MIGRATIONS.find((migration) => migration.version === 179);
			if (!migration) throw new Error("migration missing");
			migration.up(db);
			migration.up(db);
			expect(
				db
					.query(
						"SELECT derived_kind,derived_id,evidence_id FROM evidence_citations WHERE derived_id='community-before'",
					)
					.get(),
			).toEqual({ derived_kind: "community", derived_id: "community-before", evidence_id: "source-before" });
		} finally {
			db.close();
		}
	});
	it("snapshots per-agent classification epochs across idempotent upgrades", () => {
		const db = upgraded();
		try {
			db.exec(
				"INSERT INTO dreaming_passes(id,agent_id,mode,status) VALUES('before','default','incremental','running'),('alice-before','alice','incremental','running')",
			);
			db.exec("INSERT INTO classifications(id,name) VALUES('cls_secret','Secret')");
			db.exec(
				"INSERT INTO classification_assignments(target_kind,target_id,agent_id,classification_id) VALUES('agent','alice','alice','cls_secret')",
			);
			db.exec("UPDATE classification_assignments SET applied_by='usr_alice'");
			db.exec("DELETE FROM classification_assignments");
			expect(db.query("SELECT epoch FROM dreaming_classification_epoch WHERE agent_id='alice'").get()).toEqual({
				epoch: 3,
			});
			expect(db.query("SELECT pass_id,valid FROM dreaming_pass_fences ORDER BY pass_id").all()).toEqual([
				{ pass_id: "alice-before", valid: 0 },
				{ pass_id: "before", valid: 1 },
			]);
			db.exec("INSERT INTO dreaming_passes(id,agent_id,mode,status) VALUES('after','alice','incremental','running')");
			const migration = MIGRATIONS.find((item) => item.version === 179);
			if (!migration) throw new Error("migration 179 missing");
			migration.up(db);
			expect(
				db.query("SELECT pass_id,agent_id,epoch FROM dreaming_pass_classification_epochs ORDER BY pass_id").all(),
			).toEqual([
				{ pass_id: "after", agent_id: "alice", epoch: 3 },
				{ pass_id: "alice-before", agent_id: "alice", epoch: 0 },
				{ pass_id: "before", agent_id: "default", epoch: 0 },
			]);
			expect(db.query("SELECT epoch FROM dreaming_classification_epoch WHERE agent_id='alice'").get()).toEqual({
				epoch: 3,
			});
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

	it("preserves every legacy history level with NULL labels and stable indexes", () => {
		const db = new Database(":memory:");
		try {
			for (const migration of MIGRATIONS.filter((migration) => migration.version < 179)) migration.up(db);
			db.exec(`INSERT INTO dreaming_passes (id,agent_id,scope_key,mode,status,compartment_id)
			VALUES ('public','alice','alice','incremental','completed',NULL),('secret','alice','alice','incremental','completed',1),('other','bob','bob','incremental','completed',NULL)`);
			db.exec(`INSERT INTO dreaming_history_nodes (agent_id,scope_key,level,idx,pass_id,text,compartment_id)
			VALUES ('alice','alice',0,0,'public','public leaf',NULL),('alice','alice',0,1,'secret','secret leaf',1),
			('alice','alice',0,2,'other','wrong owner',NULL),('alice','alice',1,0,NULL,'legacy aggregate',NULL),
			('alice','alice',2,0,NULL,'higher aggregate',NULL),('bob','bob',0,8,NULL,'orphan leaf',NULL)`);
			const before = db
				.query(
					"SELECT agent_id,scope_key,level,idx,pass_id,text,tokens_input,tokens_output,tokens_cache_read,created_at,NULL AS compartment_id FROM dreaming_history_nodes ORDER BY agent_id,scope_key,level,idx",
				)
				.all();
			const migration = MIGRATIONS.find((migration) => migration.version === 179);
			if (!migration) throw new Error("migration missing");
			migration.up(db);
			migration.up(db);
			expect(db.query("SELECT * FROM dreaming_history_nodes ORDER BY agent_id,scope_key,level,idx").all()).toEqual(
				before,
			);
			expect(db.query("SELECT COUNT(*) AS n FROM dreaming_passes").get()).toEqual({ n: 3 });
		} finally {
			db.close();
		}
	});

	it("preserves legacy head provenance under stable entry and revision identities", () => {
		const db = new Database(":memory:");
		try {
			for (const migration of MIGRATIONS.filter((migration) => migration.version < 179)) migration.up(db);
			db.exec(`INSERT INTO memory_head_entries(entry_id,agent_id,canonical_text,entry_hash,status,first_revision,last_revision,created_at,updated_at)
				VALUES('meeting','default','Legacy meeting','hash','active',1,1,'then','now');
				INSERT INTO memory_head_revisions(id,agent_id,revision,content,content_hash,rendered_token_count,pass_id,base_revision,base_hash,created_at)
				VALUES('legacy-revision','default',1,'Legacy meeting','hash',1,'legacy-pass',0,'','then');
				INSERT INTO memory_head_revision_entries(agent_id,revision,entry_id,ordinal,operation,provenance_json)
				VALUES('default',1,'meeting',0,'add','[]');
				INSERT INTO evidence_citations VALUES('head_entry','meeting','default','memory','source'),
				('head_revision','[1,"meeting"]','default','memory','source'),('head_revision','[1,"meeting"]','default','attribute','meeting');`);
			const migration = MIGRATIONS.find((migration) => migration.version === 179);
			if (!migration) throw new Error("migration missing");
			migration.up(db);
			migration.up(db);
			expect(
				db
					.query("SELECT canonical_text,first_revision,last_revision,created_at,updated_at FROM memory_head_entries")
					.get(),
			).toEqual({
				canonical_text: "Legacy meeting",
				first_revision: 1,
				last_revision: 1,
				created_at: "then",
				updated_at: "now",
			});
			expect(
				db
					.query(`SELECT COUNT(*) AS n FROM evidence_citations c JOIN memory_head_entries h ON h.id=c.derived_id
				WHERE c.derived_kind='head_entry' AND c.evidence_id='source'`)
					.get(),
			).toEqual({ n: 1 });
			expect(
				db
					.query(`SELECT COUNT(*) AS n FROM evidence_citations c JOIN memory_head_revision_entries e ON c.derived_id=json_array(e.revision_id,e.entry_id)
				WHERE c.derived_kind='head_revision'`)
					.get(),
			).toEqual({ n: 2 });
			expect(
				db
					.query(`SELECT COUNT(*) AS n FROM evidence_citations c JOIN memory_head_entries h ON c.evidence_id=h.id
				WHERE c.derived_kind='head_revision' AND c.evidence_kind='attribute'`)
					.get(),
			).toEqual({ n: 1 });
			expect(db.query("SELECT COUNT(*) AS n FROM evidence_citations").get()).toEqual({ n: 3 });
		} finally {
			db.close();
		}
	});

	it("marks only the latest legacy head revision current", () => {
		const db = new Database(":memory:");
		try {
			for (const migration of MIGRATIONS.filter((migration) => migration.version < 179)) migration.up(db);
			for (const revision of [1, 2, 3])
				db.prepare(`INSERT INTO memory_head_revisions
				(id,agent_id,revision,content,content_hash,rendered_token_count,pass_id,base_revision,base_hash,created_at)
				VALUES (?,'default',?,'legacy','hash',1,'legacy',0,'','now')`).run(`legacy-${revision}`, revision);
			const migration = MIGRATIONS.find((migration) => migration.version === 179);
			if (!migration) throw new Error("migration missing");
			migration.up(db);
			migration.up(db);
			expect(db.query("SELECT revision,is_current FROM memory_head_revisions ORDER BY revision").all()).toEqual([
				{ revision: 1, is_current: 0 },
				{ revision: 2, is_current: 0 },
				{ revision: 3, is_current: 1 },
			]);
		} finally {
			db.close();
		}
	});
});

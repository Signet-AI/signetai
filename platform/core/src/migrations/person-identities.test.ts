import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { MIGRATIONS, runMigrations } from "./index";

function seed(db: Database): void {
	db.exec(`INSERT INTO users(id,username,display_name,role) VALUES('alice','alice','Alex','member'),('bob','bob','Alex','member');
 INSERT INTO groups(id,name) VALUES('eng','Engineering');
 INSERT INTO agents(id,name,kind,owner_user_id,created_at,updated_at) VALUES('personal','Personal','personal','alice','now','now');
 INSERT INTO agents(id,name,kind,owner_group_id,created_at,updated_at) VALUES('team','Team','team','eng','now','now');`);
}
function people(db: Database) {
	return db
		.query(
			"SELECT agent_id,person_user_id,name,compartment_id,status,proposal_evidence,dreaming_pass_id FROM entities WHERE person_user_id IS NOT NULL ORDER BY agent_id,person_user_id",
		)
		.all();
}

describe("identity-owned structural people", () => {
	it("B1 migrates a legacy squatted display name without changing the ordinary entity", () => {
		const db = new Database(":memory:");
		try {
			for (const migration of MIGRATIONS.filter((m) => m.version < 179)) migration.up(db);
			seed(db);
			db.exec("INSERT INTO group_members(group_id,user_id,role) VALUES('eng','alice','member')");
			db.exec(
				"INSERT INTO entities(id,name,canonical_name,entity_type,agent_id,created_at,updated_at) VALUES('squatter','Alex (alice)','alex (alice)','project','team','then','then')",
			);
			const before = db
				.query(
					"SELECT id,name,canonical_name,entity_type,agent_id,compartment_id,created_at,updated_at FROM entities WHERE id='squatter'",
				)
				.get();
			const migration = MIGRATIONS.find((m) => m.version === 179);
			if (!migration) throw new Error("Missing migration");
			migration.up(db);
			migration.up(db);
			expect(
				db
					.query("SELECT name,compartment_id,status FROM entities WHERE agent_id='team' AND person_user_id='alice'")
					.get(),
			).toEqual({ name: "Alex (alice)", compartment_id: null, status: "active" });
			expect(
				db
					.query(
						"SELECT id,name,canonical_name,entity_type,agent_id,compartment_id,created_at,updated_at FROM entities WHERE id='squatter'",
					)
					.get(),
			).toEqual(before);
		} finally {
			db.close();
		}
	});

	it("B1 identity renames succeed even when an ordinary entity owns the new display name", () => {
		const db = new Database(":memory:");
		try {
			runMigrations(db);
			seed(db);
			db.exec("INSERT INTO group_members(group_id,user_id,role) VALUES('eng','alice','member')");
			db.exec(
				"INSERT INTO entities(id,name,canonical_name,entity_type,agent_id,created_at,updated_at) VALUES('squatter','New Alex (alice)','new alex (alice)','project','team','then','then')",
			);
			const before = db.query("SELECT * FROM entities WHERE id='squatter'").get();
			db.exec("UPDATE users SET display_name='New Alex' WHERE id='alice'");
			expect(db.query("SELECT name FROM entities WHERE agent_id='team' AND person_user_id='alice'").get()).toEqual({
				name: "New Alex (alice)",
			});
			expect(db.query("SELECT * FROM entities WHERE id='squatter'").get()).toEqual(before);
		} finally {
			db.close();
		}
	});

	it.each(["users", "api_keys"] as const)("O3 %s activity updates never enter identity projection", (table) => {
		const db = new Database(":memory:");
		try {
			runMigrations(db);
			seed(db);
			db.exec("INSERT INTO group_members(group_id,user_id,role) VALUES('eng','alice','member')");
			db.exec(
				"INSERT INTO api_keys(id,prefix,name,key_hash,user_id,agent_id,created_at) VALUES('activity-key','activity-prefix','Activity fixture','fixture-hash','alice','team','now')",
			);
			const before = people(db);
			db.exec(
				"CREATE TRIGGER identity_projection_probe BEFORE INSERT ON entities WHEN NEW.person_user_id IS NOT NULL BEGIN SELECT RAISE(ABORT,'activity_entered_identity_projection'); END",
			);
			expect(() =>
				db.exec(
					table === "users"
						? "UPDATE users SET last_active_at='later' WHERE id='alice'"
						: "UPDATE api_keys SET last_used_at='later' WHERE id='activity-key'",
				),
			).not.toThrow();
			expect(people(db)).toEqual(before);
			db.exec("DROP TRIGGER identity_projection_probe");
			db.exec("UPDATE users SET display_name='Alicia' WHERE id='alice'");
			expect(db.query("SELECT name FROM entities WHERE agent_id='team' AND person_user_id='alice'").get()).toEqual({
				name: "Alicia (alice)",
			});
		} finally {
			db.close();
		}
	});

	it("upgrades partition keys without cascading children and restores foreign-key enforcement", () => {
		const db = new Database(":memory:");
		try {
			db.exec(
				"CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY,applied_at TEXT NOT NULL,checksum TEXT NOT NULL)",
			);
			for (const migration of MIGRATIONS.filter((m) => m.version < 179)) {
				migration.up(db);
				db.query("INSERT INTO schema_migrations VALUES(?,'now','fixture')").run(migration.version);
			}
			seed(db);
			db.exec(
				"INSERT INTO entities(id,name,canonical_name,entity_type,agent_id,created_at,updated_at) VALUES('parent','Project Falcon','project falcon','project','team','now','now'); INSERT INTO entity_aspects(id,entity_id,agent_id,name,canonical_name) VALUES('aspect','parent','team','Preferences','preferences'); INSERT INTO entity_attributes(id,aspect_id,agent_id,kind,content,normalized_content) VALUES('attribute','aspect','team','fact','tea','tea'); PRAGMA foreign_keys=ON",
			);
			runMigrations(db);
			expect(db.query("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });
			expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
			expect(db.query("SELECT aspect_id,content FROM entity_attributes WHERE id='attribute'").get()).toEqual({
				aspect_id: "aspect",
				content: "tea",
			});
			db.exec(
				"INSERT INTO compartments(id,key) VALUES(7,'secret'); INSERT INTO entities(id,name,canonical_name,entity_type,agent_id,compartment_id,created_at,updated_at) VALUES('other-label','Project Falcon','project falcon','project','team',7,'now','now'); INSERT INTO entity_aspects(id,entity_id,agent_id,name,canonical_name,compartment_id) VALUES('other-aspect','parent','team','Preferences','preferences',7)",
			);
			expect(db.query("SELECT COUNT(*) AS n FROM entities WHERE name='Project Falcon'").get()).toEqual({ n: 2 });
			expect(db.query("SELECT COUNT(*) AS n FROM entity_aspects WHERE entity_id='parent'").get()).toEqual({ n: 2 });
			expect(() =>
				db
					.query(
						"INSERT INTO entity_aspects(id,entity_id,agent_id,name,canonical_name) VALUES('invalid','missing','team','Invalid','invalid')",
					)
					.run(),
			).toThrow("FOREIGN KEY");
		} finally {
			db.close();
		}
	});

	it("creates personal owners before evidence and follows group-derived act-as grants atomically", () => {
		const db = new Database(":memory:");
		try {
			runMigrations(db);
			seed(db);
			expect(people(db)).toEqual([
				{
					agent_id: "personal",
					person_user_id: "alice",
					name: "Alex (alice)",
					compartment_id: null,
					status: "active",
					proposal_evidence: "[]",
					dreaming_pass_id: null,
				},
			]);
			db.exec("INSERT INTO group_members(group_id,user_id,role) VALUES('eng','alice','member'),('eng','bob','owner')");
			expect(people(db)).toHaveLength(3);
			expect(db.query("SELECT name FROM entities WHERE agent_id='team' ORDER BY person_user_id").all()).toEqual([
				{ name: "Alex (alice)" },
				{ name: "Alex (bob)" },
			]);
			const person = db.query("SELECT id FROM entities WHERE agent_id='team' AND person_user_id='alice'").get();
			db.exec("DELETE FROM group_members WHERE user_id='alice'");
			expect(db.query("SELECT status FROM entities WHERE agent_id='team' AND person_user_id='alice'").get()).toEqual({
				status: "archived",
			});
			expect(db.query("SELECT status FROM entities WHERE agent_id='personal'").get()).toEqual({ status: "active" });
			db.exec("INSERT INTO group_members(group_id,user_id,role) VALUES('eng','alice','member')");
			expect(db.query("SELECT id FROM entities WHERE agent_id='team' AND person_user_id='alice'").get()).toEqual(
				person,
			);
			db.exec("UPDATE users SET display_name='Alicia' WHERE id='alice'");
			expect(db.query("SELECT name FROM entities WHERE person_user_id='alice'").all()).toEqual([
				{ name: "Alicia (alice)" },
				{ name: "Alicia (alice)" },
			]);
			db.exec("UPDATE agents SET owner_user_id='bob' WHERE id='personal'");
			expect(
				db.query("SELECT person_user_id,status FROM entities WHERE agent_id='personal' ORDER BY person_user_id").all(),
			).toEqual([
				{ person_user_id: "alice", status: "archived" },
				{ person_user_id: "bob", status: "active" },
			]);
			db.exec("UPDATE users SET status='deactivated' WHERE id='bob'");
			expect(db.query("SELECT DISTINCT status FROM entities WHERE person_user_id='bob'").all()).toEqual([
				{ status: "archived" },
			]);
			db.exec("UPDATE agents SET archived_at='now' WHERE id='team'");
			expect(db.query("SELECT DISTINCT status FROM entities WHERE agent_id='team'").all()).toEqual([
				{ status: "archived" },
			]);
		} finally {
			db.close();
		}
	});
	it("backfills existing grants and removes pass-derived identity provenance without relabeling children", () => {
		const db = new Database(":memory:");
		try {
			for (const migration of MIGRATIONS.filter((m) => m.version < 179)) migration.up(db);
			seed(db);
			db.exec("INSERT INTO group_members(group_id,user_id,role) VALUES('eng','alice','member'),('eng','bob','member')");
			db.exec("INSERT INTO compartments(id,key) VALUES(7,'secret')");
			db.exec(
				"INSERT INTO entities(id,agent_id,name,canonical_name,entity_type,person_user_id,compartment_id,proposal_evidence,created_at,updated_at) VALUES('existing','team','Secret inferred name','secret inferred name','person','alice',7,'[\"transcript:private\"]','now','now')",
			);
			db.exec(
				"INSERT INTO entity_aspects(id,agent_id,entity_id,name,canonical_name,compartment_id,created_at,updated_at) VALUES('child','team','existing','Private','private',7,'now','now')",
			);
			const migration = MIGRATIONS.find((m) => m.version === 179);
			if (!migration) throw new Error("Missing migration");
			migration.up(db);
			migration.up(db);
			expect(people(db)).toHaveLength(3);
			expect(
				db
					.query(
						"SELECT id,name,compartment_id,proposal_evidence FROM entities WHERE person_user_id='alice' AND agent_id='team'",
					)
					.get(),
			).toEqual({ id: "existing", name: "Alex (alice)", compartment_id: null, proposal_evidence: "[]" });
			expect(db.query("SELECT compartment_id FROM entity_aspects WHERE id='child'").get()).toEqual({
				compartment_id: 7,
			});
		} finally {
			db.close();
		}
	});
});

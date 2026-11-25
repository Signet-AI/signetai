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

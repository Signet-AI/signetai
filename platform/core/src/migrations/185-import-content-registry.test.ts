import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { MIGRATIONS, runMigrations } from "./index";
import { up } from "./185-import-content-registry";

test("185 retains existing imported source identity and backfills its current labels", () => {
	const db = new Database(":memory:");
	try {
		for (const migration of MIGRATIONS.filter((migration) => migration.version < 185)) migration.up(db);
		db.exec(`INSERT INTO classifications(id,name,created_at) VALUES('cls_hr','HR','now');
		INSERT INTO compartments(id,key,created_at) VALUES(1,'cls_hr','now');
		INSERT INTO compartment_members(compartment_id,classification_id) VALUES(1,'cls_hr');
		INSERT INTO classification_assignments(classification_id,target_kind,target_id,agent_id,applied_at) VALUES('cls_hr','source','legacy-source','a','now');
		INSERT INTO memory_artifacts(agent_id,source_path,source_sha256,source_kind,source_id,source_external_id,session_id,session_token,captured_at,updated_at,author_user_id,compartment_id)
		VALUES('a','imports/legacy-source/a.md','hash','source_import_markdown','legacy-source','${"a".repeat(64)}','unbound','unbound','now','now',NULL,1);`);
		up(db);
		up(db);
		expect(
			db
				.query(
					"SELECT r.agent_id,r.source_id,r.content_hash,c.key FROM import_content_registry r LEFT JOIN compartments c ON c.id=r.compartment_id",
				)
				.all(),
		).toEqual([{ agent_id: "a", source_id: "legacy-source", content_hash: "a".repeat(64), key: "cls_hr" }]);
		db.exec(
			`INSERT INTO import_content_registry(agent_id,source_id,content_hash,compartment_id,author_credential) SELECT agent_id,'another-source',content_hash,compartment_id,'local' FROM import_content_registry`,
		);
		expect(db.query("SELECT COUNT(*) AS n FROM import_content_registry").get()).toEqual({ n: 2 });
	} finally {
		db.close();
	}
});

test("185 is present in fresh and repeated initialization", () => {
	const db = new Database(":memory:");
	try {
		runMigrations(db);
		runMigrations(db);
		expect(db.query("SELECT version FROM schema_migrations WHERE version=185").get()).toEqual({ version: 185 });
		expect(db.query("SELECT * FROM import_content_registry").all()).toEqual([]);
	} finally {
		db.close();
	}
});

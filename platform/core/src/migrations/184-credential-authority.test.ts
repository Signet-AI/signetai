import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { MIGRATIONS, runMigrations } from "./index";
import { up } from "./184-credential-authority";

test("184 backfills audited key parents and bounds existing descendants", () => {
	const db = new Database(":memory:");
	try {
		for (const migration of MIGRATIONS.filter((m) => m.version < 184)) migration.up(db);
		db.exec(`INSERT INTO users(id,username,display_name,role) VALUES('u','u','User','member');
		INSERT INTO api_keys(id,prefix,name,key_hash,role,scope_json,permissions_json,created_at,expires_at,user_id,kind) VALUES
		('parent','parent','Parent','hash','member','{}','["recall"]','now','2090-01-01','u','personal'),
		('child','child','Child','hash','member','{}','["recall"]','now','2099-01-01','u','personal');
		INSERT INTO audit_events(id,at,actor_credential,action,target_kind,target_id,outcome) VALUES('created','now','api_key:parent','key.created','key','child','success');`);
		up(db);
		up(db);
		expect(db.query("SELECT parent_key_id,expires_at,revoked_at FROM api_keys WHERE id='child'").get()).toEqual({
			parent_key_id: "parent",
			expires_at: "2090-01-01",
			revoked_at: null,
		});
		db.exec("UPDATE api_keys SET revoked_at='revoked' WHERE id='parent'");
		expect(db.query("SELECT revoked_at FROM api_keys WHERE id='child'").get()).toEqual({ revoked_at: "revoked" });
	} finally {
		db.close();
	}
});

test("184 upgrades existing sessions without changing their authority and is idempotent", () => {
	const db = new Database(":memory:");
	try {
		for (const migration of MIGRATIONS.filter((m) => m.version < 184)) migration.up(db);
		db.exec(
			"INSERT INTO users(id,username,display_name,role) VALUES('u','u','User','member'); INSERT INTO auth_sessions(id,user_id,kind,token_hash,access_expires_at) VALUES('s','u','browser','hash','2099-01-01')",
		);
		up(db);
		up(db);
		expect(db.query("SELECT token_hash,permission_ceiling_json FROM auth_sessions WHERE id='s'").get()).toEqual({
			token_hash: "hash",
			permission_ceiling_json: null,
		});
		expect(() => db.exec("UPDATE auth_sessions SET permission_ceiling_json='invalid' WHERE id='s'")).toThrow();
	} finally {
		db.close();
	}
});
test("184 is included in fresh and repeated schema initialization", () => {
	const db = new Database(":memory:");
	try {
		runMigrations(db);
		runMigrations(db);
		expect(db.query("SELECT version FROM schema_migrations WHERE version=184").get()).toEqual({ version: 184 });
	} finally {
		db.close();
	}
});

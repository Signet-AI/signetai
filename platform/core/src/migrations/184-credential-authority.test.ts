import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { MIGRATIONS, runMigrations } from "./index";
import { up } from "./184-credential-authority";

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

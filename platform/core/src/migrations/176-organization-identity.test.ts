import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { MIGRATIONS, runMigrations } from "./index";

describe("organization identity migration", () => {
	test("fresh schema declares identity and author artifacts and is idempotent", () => {
		const db = new Database(":memory:");
		try {
			runMigrations(db);
			expect(db.query("SELECT agent_model, password_login FROM organization WHERE id = 1").get()).toEqual({
				agent_model: "personal",
				password_login: 1,
			});
			expect(MIGRATIONS.find((m) => m.version === 176)?.artifacts?.tables).toContain("auth_sessions");
			expect(
				db
					.query("PRAGMA table_info(memories)")
					.all()
					.some((row) => typeof row === "object" && row !== null && Reflect.get(row, "name") === "author_user_id"),
			).toBe(true);
			runMigrations(db);
			expect(db.query("SELECT COUNT(*) AS n FROM organization").get()).toEqual({ n: 1 });
		} finally {
			db.close();
		}
	});

	test("upgrade labels existing keys once without relabeling newly issued keys", () => {
		const db = new Database(":memory:");
		try {
			for (const migration of MIGRATIONS.filter((m) => m.version < 176)) migration.up(db);
			db.exec(
				"INSERT INTO api_keys (id,prefix,name,key_hash,role,scope_json,permissions_json,created_at) VALUES ('old','old','old','hash','agent','{}','[]','now')",
			);
			const migration = MIGRATIONS.find((m) => m.version === 176);
			expect(migration).toBeDefined();
			if (!migration) throw new Error("migration missing");
			migration.up(db);
			expect(db.query("SELECT legacy,kind FROM api_keys WHERE id = 'old'").get()).toEqual({
				legacy: 1,
				kind: "legacy",
			});
			db.exec(
				"INSERT INTO api_keys (id,prefix,name,key_hash,role,scope_json,permissions_json,created_at,kind) VALUES ('new','new','new','hash','member','{}','[]','now','personal')",
			);
			migration.up(db);
			expect(db.query("SELECT legacy FROM api_keys WHERE id = 'new'").get()).toEqual({ legacy: 0 });
		} finally {
			db.close();
		}
	});
});

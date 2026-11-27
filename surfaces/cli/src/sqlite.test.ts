import { expect, test } from "bun:test";
import { Database as BunDatabase } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "./sqlite";

test.each([
	{ readonly: false, journal: "wal" },
	{ readonly: true, journal: "delete" },
])("CLI file connection journal policy: %j", ({ readonly, journal }) => {
	const root = mkdtempSync(join(tmpdir(), "signet-cli-journal-"));
	const path = join(root, "workspace.db");
	let db: ReturnType<typeof Database> | undefined;
	try {
		const seed = new BunDatabase(path);
		seed.exec("CREATE TABLE fixture(id INTEGER PRIMARY KEY)");
		seed.close();
		db = readonly ? Database(path, { readonly: true }) : Database(path);
		expect(db.prepare("PRAGMA journal_mode").get()).toEqual({ journal_mode: journal });
	} finally {
		db?.close();
		rmSync(root, { recursive: true, force: true });
	}
});

test("direct CLI connections recursively purge dependent rows", () => {
	const db = Database(":memory:");
	try {
		db.exec(
			"CREATE TABLE chain(id INTEGER PRIMARY KEY,parent INTEGER);CREATE TRIGGER purge_child AFTER DELETE ON chain BEGIN DELETE FROM chain WHERE parent=old.id;END;INSERT INTO chain VALUES(1,NULL),(2,1),(3,2);DELETE FROM chain WHERE id=1",
		);
		expect(db.prepare("SELECT count(*) n FROM chain").get()).toEqual({ n: 0 });
		expect(db.prepare("PRAGMA recursive_triggers").get()).toEqual({ recursive_triggers: 1 });
	} finally {
		db.close();
	}
});

import { expect, test } from "bun:test";
import Database from "./sqlite";

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

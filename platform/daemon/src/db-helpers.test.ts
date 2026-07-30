import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { tableExists } from "./db-helpers";

test("tableExists returns false for a missing Bun SQLite table", () => {
	const db = new Database(":memory:");
	try {
		expect(tableExists(db, "missing_table")).toBeFalse();
	} finally {
		db.close();
	}
});

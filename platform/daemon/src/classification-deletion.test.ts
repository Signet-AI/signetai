import { expect, test } from "bun:test";
import { currentClassificationFixture } from "./test-support/classification-fixture.test";
import { purgeMemoryInTx, purgeSourceOwnedRowsInTx } from "./source-purge-tx";
import { removeAgentInTx } from "./agent-removal";
import { compartmentFor } from "@signet/core";
function assigned() {
	const db = currentClassificationFixture();
	db.exec("INSERT INTO classifications(id,name) VALUES('cls_hr','HR')");
	return db;
}
test("memory purge removes its assignments atomically with the target", () => {
	const db = assigned();
	db.exec(
		"INSERT INTO classification_assignments VALUES('memory','m','default','cls_hr','carol','now');CREATE TRIGGER fail_memory_delete BEFORE DELETE ON memories BEGIN SELECT RAISE(ABORT,'delete crash');END",
	);
	expect(() => db.transaction(() => purgeMemoryInTx(db, "m"))()).toThrow("delete crash");
	expect(db.prepare("SELECT count(*) n FROM classification_assignments").get()).toEqual({ n: 1 });
	db.exec("DROP TRIGGER fail_memory_delete");
	db.transaction(() => purgeMemoryInTx(db, "m"))();
	expect(db.prepare("SELECT count(*) n FROM classification_assignments").get()).toEqual({ n: 0 });
	db.close();
});
test("source purge removes only the resolved agents source assignment", () => {
	const db = assigned();
	db.exec(
		"INSERT INTO agents(id,name,created_at,updated_at) VALUES('other','Other','now','now');INSERT INTO classification_assignments VALUES('source','src','default','cls_hr','carol','now'),('source','src','other','cls_hr','carol','now')",
	);
	db.transaction(() => purgeSourceOwnedRowsInTx(db, { sourceId: "src", agentId: "default" }))();
	expect(db.prepare("SELECT agent_id FROM classification_assignments").all()).toEqual([{ agent_id: "other" }]);
	db.close();
});
test("agent archival drops assignments in the same owner removal transaction", () => {
	const db = assigned();
	db.exec(
		"INSERT INTO agents(id,name,created_at,updated_at) VALUES('other','Other','now','now');INSERT INTO memories(id,content,agent_id,created_at,updated_at) VALUES('other-memory','secret','other','now','now');INSERT INTO classification_assignments VALUES('agent','other','other','cls_hr','carol','now')",
	);
	const c = compartmentFor(db, ["cls_hr"]);
	db.prepare("UPDATE memories SET compartment_id=? WHERE agent_id='other'").run(c);
	const result = db.transaction(() =>
		removeAgentInTx(db, { agentId: "other", mode: "archive", changedBy: "test", changedAt: "now" }),
	)();
	expect(result).toMatchObject({ status: "removed" });
	expect(db.prepare("SELECT count(*) n FROM classification_assignments").get()).toEqual({ n: 0 });
	db.close();
});

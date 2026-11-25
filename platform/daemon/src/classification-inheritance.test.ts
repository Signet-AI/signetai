import { expect, test } from "bun:test";
import * as shards from "../../core/src/compartment-shards";
import { classificationFixture } from "./test-support/classification-fixture.test";
import { commitCompactionSummaryInTx } from "./session-transcripts";

function assigned() {
	const db = classificationFixture();
	db.exec(
		"INSERT INTO classifications(id,name) VALUES('cls_hr','HR');INSERT INTO classification_assignments VALUES('agent','default','default','cls_hr','carol','now')",
	);
	return db;
}
test("pending assignment guards reject evidence and child writes that forget compartments", () => {
	const db = assigned();
	expect(() =>
		db
			.prepare(
				"INSERT INTO memories(id,content,agent_id,created_at,updated_at) VALUES('forgot','secret','default','now','now')",
			)
			.run(),
	).toThrow("compartment_required");
	expect(() => db.prepare("UPDATE memories SET content='forgot label' WHERE id='m'").run()).toThrow(
		"compartment_required",
	);
	expect(() =>
		db.prepare("INSERT INTO memory_hints(id,memory_id,agent_id,hint) VALUES('hint','m','default','secret')").run(),
	).toThrow("compartment_required");
	db.close();
});
test("write helper unions pending scope assignments and parent labels before indexing", () => {
	const db = assigned();
	expect(typeof shards.compartmentForWrite).toBe("function");
	db.exec(
		"INSERT INTO classifications(id,name) VALUES('cls_session','Session'),('cls_source','Source'),('cls_memory','Memory'),('cls_parent','Parent');INSERT INTO classification_assignments VALUES('session','s','default','cls_session','carol','now'),('source','src','default','cls_source','carol','now'),('memory','new','default','cls_memory','carol','now')",
	);
	db.transaction(() => {
		const parent = shards.compartmentFor(db, ["cls_parent"]);
		const c = shards.compartmentForWrite(db, {
			agentId: "default",
			sessionKey: "s",
			sourceId: "src",
			memoryId: "new",
			parentCompartment: parent,
		});
		db.prepare(
			"INSERT INTO memories(id,content,agent_id,source_id,compartment_id,created_at,updated_at) VALUES('new','hidden','default','src',?,'now','now')",
		).run(c);
		expect(
			db
				.prepare("SELECT classification_id FROM compartment_members WHERE compartment_id=? ORDER BY classification_id")
				.all(c),
		).toEqual(
			["cls_hr", "cls_memory", "cls_parent", "cls_session", "cls_source"].map((classification_id) => ({
				classification_id,
			})),
		);
	})();
	expect(db.prepare("SELECT count(*) n FROM memories_fts WHERE memories_fts MATCH 'hidden'").get()).toEqual({ n: 0 });
	db.close();
});
test("compaction summaries inherit their session classification on insert and repeated upsert", () => {
	const db = assigned();
	for (const summaryId of ["summary-one", "summary-two"])
		db.transaction(() =>
			commitCompactionSummaryInTx(db, {
				agentId: "default",
				sessionKey: "session",
				harness: "test",
				project: null,
				summary: "hidden summary",
				summaryId,
				now: "2026-11-25T00:00:00.000Z",
			}),
		)();
	expect(db.prepare("SELECT count(*) n FROM session_summaries WHERE compartment_id IS NOT NULL").get()).toEqual({
		n: 1,
	});
	expect(
		db.prepare("SELECT count(*) n FROM memories WHERE id LIKE 'summary-%' AND compartment_id IS NOT NULL").get(),
	).toEqual({ n: 2 });
	expect(db.prepare("SELECT count(*) n FROM memories_fts WHERE memories_fts MATCH 'summary'").get()).toEqual({ n: 0 });
	db.close();
});

import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { MIGRATIONS } from "./index";
import { up, COMPARTMENT_TABLES } from "./177-classifications";

test("checkpoint migration resolves unique transcript owners and preserves ambiguous ownership", () => {
	const db = new Database(":memory:");
	for (const migration of MIGRATIONS) if (migration.version < 177) migration.up(db);
	db.exec(
		"INSERT INTO agents(id,name) VALUES('other','Other');INSERT INTO session_transcripts(session_key,content,agent_id,created_at) VALUES('one','x','default','now'),('shared','x','default','now'),('shared','y','other','now');INSERT INTO session_checkpoints(id,session_key,harness,trigger,digest,prompt_count,created_at) VALUES('a','one','test','test','x',1,'now'),('b','shared','test','test','y',1,'now')",
	);
	up(db);
	expect(db.prepare("SELECT id,agent_id FROM session_checkpoints ORDER BY id").all()).toEqual([
		{ id: "a", agent_id: "default" },
		{ id: "b", agent_id: null },
	]);
	up(db);
	expect(db.prepare("SELECT agent_id FROM session_checkpoints WHERE id='b'").get()).toEqual({ agent_id: null });
	db.close();
});
test("normalized copy citations admit all four copy kinds and attribute evidence", () => {
	const db = new Database(":memory:");
	up(db);
	for (const kind of ["contradiction", "head_revision", "proposal", "telemetry"]) {
		expect(() =>
			db.prepare("INSERT INTO evidence_citations VALUES(?,?,'default','attribute','attr')").run(kind, kind),
		).not.toThrow();
	}
	expect(db.prepare("SELECT count(*) n FROM evidence_citations").get()).toEqual({ n: 4 });
	db.close();
});

test("classification schema is repeatable and preserves guarded historical citations", () => {
	const db = new Database(":memory:");
	for (const migration of MIGRATIONS) if (migration.version < 177) migration.up(db);
	db.exec(
		`INSERT INTO entities(id,name,canonical_name,entity_type,agent_id,created_at,updated_at,proposal_evidence) VALUES ('e','E','e','concept','default','now','now','[{"source_ref":"transcript:session:1"},{"memory_id":"m"},7,"bad",null,{"source_kind":"artifact","source_id":"notes/x.md"}]')`,
	);
	db.exec(
		`INSERT INTO entities(id,name,canonical_name,entity_type,agent_id,created_at,updated_at,proposal_evidence) VALUES ('bad','Bad','bad','concept','default','now','now','not json')`,
	);
	up(db);
	up(db);
	expect(
		db.prepare("SELECT derived_id,evidence_kind,evidence_id FROM evidence_citations ORDER BY evidence_kind").all(),
	).toEqual([
		{ derived_id: "e", evidence_kind: "artifact", evidence_id: "notes/x.md" },
		{ derived_id: "e", evidence_kind: "memory", evidence_id: "m" },
		{ derived_id: "e", evidence_kind: "transcript", evidence_id: "session:1" },
	]);
	for (const table of COMPARTMENT_TABLES) {
		const exists = db.prepare("SELECT 1 FROM sqlite_master WHERE name=?").get(table);
		if (exists)
			expect(
				db
					.prepare(`PRAGMA table_info(${table})`)
					.all()
					.some((r) => typeof r === "object" && r !== null && "name" in r && r.name === "compartment_id"),
			).toBe(true);
	}
	db.close();
});

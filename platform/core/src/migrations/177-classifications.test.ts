import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { MIGRATIONS } from "./index";
import { up, COMPARTMENT_TABLES } from "./177-classifications";

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

import { expect, test } from "bun:test";
import { classificationFixture } from "./test-support/classification-fixture.test";
import { executeClassification } from "./classification-owner";
import { readScopeSql } from "./read-scope";
import { up } from "../../core/src/migrations/177-classifications";
const actor = {
	userId: "carol",
	groupIds: [],
	local: false,
	compliance: true,
	boundAgentId: null,
	allowedProjects: null,
	credential: "session:test",
};
function apply(
	db: ReturnType<typeof classificationFixture>,
	id: string,
	target: { kind: "memory" | "session"; id: string; agentId: string },
	remove = false,
) {
	const job = executeClassification(db, { op: "enqueue", actor, id, target, remove });
	if (typeof job !== "object" || job === null || !("jobId" in job) || typeof job.jobId !== "string")
		throw new Error("missing job");
	executeClassification(db, { op: "execute", jobId: job.jobId });
}
test("one derivation fans through every copy kind and the full copy chain", () => {
	const db = classificationFixture();
	db.exec(`
 INSERT INTO classifications(id,name) VALUES('cls_hr','HR');
 INSERT INTO entity_aspects(id,entity_id,agent_id,name,canonical_name) VALUES('aspect','e','default','Aspect','aspect');
 INSERT INTO entity_attributes(id,aspect_id,agent_id,kind,content,normalized_content) VALUES('attr','aspect','default','fact','claim','claim');
 INSERT INTO ontology_proposals(id,agent_id,operation,payload) VALUES('proposal','default','copy','{}'),('cycle','default','copy','{}');
 INSERT INTO ontology_contradictions(id,agent_id,entity_name,aspect_name,claim_key,left_content,right_content,detector,reason,detected_at,created_at,updated_at) VALUES('contradiction','default','e','a','c','left','right','manual','test','now','now','now');
 INSERT INTO memory_head_revision_entries(agent_id,revision,entry_id,ordinal,operation,provenance_json) VALUES('default',1,'entry',0,'add','{}');
 INSERT INTO memory_search_telemetry(id,agent_id,created_at,route,query,filters_json,method,result_count,timings_json,results_json) VALUES('telemetry','default','now','search','q','{}','keyword',1,'{}','[]');
 INSERT INTO session_recall_events(session_key,agent_id,item_kind,item_id,surface,mode) VALUES('s','default','memory','m','test','test');
 INSERT INTO evidence_citations VALUES('attribute','attr','default','memory','m'),('proposal','proposal','default','attribute','attr'),('proposal','proposal','default','attribute','cycle'),('proposal','cycle','default','attribute','proposal'),('contradiction','contradiction','default','attribute','proposal'),('head_revision','[1,"entry"]','default','attribute','contradiction'),('telemetry','telemetry','default','attribute','[1,"entry"]'),('telemetry','["s",0,"memory","m"]','default','memory','m');`);
	apply(db, "cls_hr", { kind: "memory", id: "m", agentId: "default" });
	const expected = db.prepare("SELECT compartment_id FROM memories WHERE id='m'").get();
	expect(expected).toMatchObject({ compartment_id: expect.any(Number) });
	for (const table of [
		"entity_attributes",
		"ontology_proposals",
		"ontology_contradictions",
		"memory_head_revision_entries",
		"memory_search_telemetry",
		"session_recall_events",
	])
		expect(db.prepare(`SELECT compartment_id FROM ${table}`).get()).toEqual(expected);
	apply(db, "cls_hr", { kind: "memory", id: "m", agentId: "default" }, true);
	for (const table of [
		"entity_attributes",
		"ontology_proposals",
		"ontology_contradictions",
		"memory_head_revision_entries",
		"memory_search_telemetry",
		"session_recall_events",
	])
		expect(db.prepare(`SELECT compartment_id FROM ${table}`).get()).toEqual({ compartment_id: null });
	db.close();
});
test("ambiguous checkpoints retain the union of owners and require all reach", () => {
	const db = classificationFixture();
	db.exec(
		`INSERT INTO agents(id,name,created_at,updated_at) VALUES('other','Other','now','now');INSERT INTO classifications(id,name) VALUES('cls_hr','HR'),('cls_legal','Legal');INSERT INTO session_transcripts(session_key,content,agent_id,created_at) VALUES('shared','one','default','now'),('shared','two','other','now');DROP TRIGGER IF EXISTS session_checkpoints_compartment_insert;INSERT INTO session_checkpoints(id,session_key,harness,trigger,digest,prompt_count,created_at) VALUES('checkpoint','shared','test','test','mixed',1,'now')`,
	);
	up(db);
	apply(db, "cls_hr", { kind: "session", id: "shared", agentId: "default" });
	apply(db, "cls_legal", { kind: "session", id: "shared", agentId: "other" });
	expect(() => db.prepare("UPDATE session_checkpoints SET compartment_id=NULL WHERE id='checkpoint'").run()).toThrow(
		"compartment_required",
	);
	const c = db.prepare("SELECT agent_id,compartment_id FROM session_checkpoints WHERE id='checkpoint'").get();
	expect(c?.agent_id).toBeNull();
	expect(
		db
			.prepare("SELECT classification_id FROM compartment_members WHERE compartment_id=? ORDER BY classification_id")
			.all(c?.compartment_id),
	).toEqual([{ classification_id: "cls_hr" }, { classification_id: "cls_legal" }]);
	for (const [reach, compartments, expected] of [
		[{ kind: "all" }, [c?.compartment_id], 1],
		[{ kind: "own", agentId: "default" }, [c?.compartment_id], 0],
		[{ kind: "all" }, [], 0],
	] as const) {
		if (compartments.some((x) => typeof x !== "number")) throw new Error("missing compartment");
		const scope = {
			reach,
			compartments: compartments.flatMap((x) => (typeof x === "number" ? [x] : [])),
			projects: null,
		};
		const sql = readScopeSql("r", scope, { visibility: null, checkpoint: true });
		expect(db.prepare("SELECT count(*) n FROM session_checkpoints r WHERE 1=1 " + sql.sql).get(...sql.args)).toEqual({
			n: expected,
		});
	}
	db.close();
});

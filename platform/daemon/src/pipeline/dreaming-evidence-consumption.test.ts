import { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, it } from "bun:test";
import { runMigrations } from "../../../core/src/migrations";
import { readEpisodicSource, searchEpisodicSources } from "../episodic-sources";
import {
	evidenceCursorForSource,
	recordDreamingEvidenceConsumptionInTx,
	importedSourceAttentionUpsert,
	resolveStalledEvidenceAttentionInTx,
	SEEN_IMPORTED_SOURCE_ATTENTION_SQL,
	verifiedDreamingEvidenceDelivery,
	persistedEvidenceDeliveries,
	pendingDreamingEvidenceContinuations,
	probeSourceEvidenceDrain,
} from "./dreaming-evidence-consumption";
import { searchDreamingEvidenceInDb } from "./dreaming-capabilities";

let db: Database;
beforeEach(() => {
	db = new Database(":memory:");
	runMigrations(db);
	db.exec(
		"INSERT INTO classifications(id,name) VALUES ('cls_secret','Secret'); INSERT INTO compartments(id,key) VALUES (1,'cls_secret'); INSERT INTO compartment_members VALUES(1,'cls_secret')",
	);
	for (const compartment of [1]) {
		db.query(
			`INSERT INTO memory_artifacts(source_path,source_sha256,source_kind,session_id,session_token,source_id,content,agent_id,compartment_id,captured_at,updated_at) VALUES('shared.md','same','file','session','token','source','evidence','alice',?,'2026-01-01','2026-01-01')`,
		).run(compartment);
	}
});
afterEach(() => db.close());

it("keeps equal artifact revisions in independent consumption partitions", () => {
	db.query(
		`INSERT INTO dreaming_passes(id,agent_id,mode,status,created_at) VALUES('public','alice','incremental','running','now')`,
	).run();
	db.query(
		`INSERT INTO dreaming_evidence_consumption(agent_id,source_kind,source_id,source_captured_at,source_entry_id,source_revision,delivered_offset,source_length,pass_id,updated_at) VALUES('alice','artifact','shared.md','2026-01-01','source','same',8,8,'public','now')`,
	).run();
	const source = readEpisodicSource(db, { agentId: "alice", from: "artifact:shared.md", exactCompartment: 1 });
	if (!source) throw new Error("missing fixture");
	expect(evidenceCursorForSource(db, "alice", source).offset).toBe(0);
	expect(
		searchEpisodicSources(db, {
			agentId: "alice",
			query: "",
			kind: "artifact",
			exactCompartment: 1,
			excludeDelivered: true,
			limit: 1,
		}).map((row) => row.id),
	).toEqual(["shared.md"]);
});

it("records stalled evidence independently under each pass label with actual artifact citations", () => {
	for (const compartment of [null, 1])
		for (let n = 0; n < 3; n++) {
			db.query("UPDATE memory_artifacts SET compartment_id=?").run(compartment);
			const passId = `${compartment}-${n}`;
			db.query(
				`INSERT INTO dreaming_passes(id,agent_id,mode,status,created_at,compartment_id) VALUES(?,'alice','incremental','running','now',?)`,
			).run(passId, compartment);
			const input = { agentId: "alice", passId, kind: "artifact" as const };
			const output = searchDreamingEvidenceInDb(db, input);
			expect(output.ok).toBe(true);
			db.query(
				`INSERT INTO dreaming_tool_calls(id,agent_id,pass_id,sequence,tool_name,input_json,output_json,success,latency_ms) VALUES(?,'alice',?,0,'search_evidence',?,?,1,0)`,
			).run(`tool-${passId}`, passId, JSON.stringify(input), JSON.stringify(output));
			db.transaction(() => recordDreamingEvidenceConsumptionInTx(db, { passId, deferredEvidence: new Set() }))();
		}
	expect(
		db.query("SELECT compartment_id,stalled_passes FROM dreaming_evidence_consumption ORDER BY compartment_id").all(),
	).toEqual([
		{ compartment_id: null, stalled_passes: 3 },
		{ compartment_id: 1, stalled_passes: 3 },
	]);
	expect(
		db
			.query(
				`SELECT a.compartment_id,c.evidence_id,a.dreaming_pass_id FROM dreaming_attention a JOIN evidence_citations c ON c.derived_kind='attention' AND c.derived_id=a.id ORDER BY a.compartment_id`,
			)
			.all(),
	).toEqual([
		{ compartment_id: null, evidence_id: "shared.md", dreaming_pass_id: "null-2" },
		{ compartment_id: 1, evidence_id: "shared.md", dreaming_pass_id: "1-2" },
	]);
});

it("inherits imported source and agent assignments inside its owner transaction", () => {
	db.exec(
		"INSERT INTO classifications(id,name) VALUES('cls_agent_secret','Agent Secret'); INSERT INTO classification_assignments(target_kind,target_id,agent_id,classification_id,applied_at) VALUES('source','source','alice','cls_secret','now'),('agent','alice','alice','cls_agent_secret','now')",
	);
	db.transaction(() => importedSourceAttentionUpsert(db, "alice", "source"))();
	const row = db
		.query<{ compartment_id: number }, []>("SELECT compartment_id FROM dreaming_attention WHERE agent_id='alice'")
		.get();
	if (!row) throw new Error("missing attention");
	expect(
		db
			.query("SELECT classification_id FROM compartment_members WHERE compartment_id=? ORDER BY classification_id")
			.all(row.compartment_id),
	).toEqual([{ classification_id: "cls_agent_secret" }, { classification_id: "cls_secret" }]);
	expect(
		db.query("SELECT evidence_kind,evidence_id FROM evidence_citations WHERE derived_kind='attention'").all(),
	).toEqual([{ evidence_kind: "artifact", evidence_id: "shared.md" }]);
});

it("uses the exact attention label for seen state and resolution", () => {
	for (const label of [null, 1]) {
		db.query(
			`INSERT INTO dreaming_attention(id,agent_id,kind,subject_ref,details_json,compartment_id,created_at) VALUES(?,'alice','evidence_requeue','source:source','{}',?,'2026-01-01')`,
		).run(`import-${label}`, label);
		db.query(
			`INSERT INTO dreaming_attention(id,agent_id,kind,subject_ref,details_json,compartment_id) VALUES(?,'alice','evidence_requeue','artifact:shared.md','{"reason":"evidence-stalled"}',?)`,
		).run(`stall-${label}`, label);
	}
	db.query(
		`INSERT INTO dreaming_passes(id,agent_id,mode,status,created_at,started_at,compartment_id) VALUES('secret-pass','alice','incremental','running','2027-01-01','2027-01-01',1)`,
	).run();
	expect(
		db.query(`SELECT compartment_id FROM dreaming_attention WHERE ${SEEN_IMPORTED_SOURCE_ATTENTION_SQL}`).all(),
	).toEqual([{ compartment_id: 1 }]);
	db.transaction(() => resolveStalledEvidenceAttentionInTx(db, "secret-pass", "alice", "artifact:shared.md"))();
	expect(
		db.query("SELECT id FROM dreaming_attention WHERE subject_ref='artifact:shared.md' AND resolved_at IS NULL").all(),
	).toEqual([{ id: "stall-null" }]);
});

it("skips a vanished delivered source without wedging the pass or changing another label", () => {
	db.query(
		`INSERT INTO dreaming_passes(id,agent_id,mode,status,created_at,compartment_id) VALUES('missing','alice','incremental','running','now',1)`,
	).run();
	const input = { agentId: "alice", passId: "missing", kind: "artifact" as const };
	const output = searchDreamingEvidenceInDb(db, input);
	db.query(
		`INSERT INTO dreaming_tool_calls(id,agent_id,pass_id,sequence,tool_name,input_json,output_json,success,latency_ms) VALUES('missing-tool','alice','missing',0,'search_evidence',?,?,1,0)`,
	).run(JSON.stringify(input), JSON.stringify(output));
	const delivery = persistedEvidenceDeliveries(db, "missing")[0];
	if (!delivery) throw new Error("missing actual delivered excerpt");
	db.query("DELETE FROM memory_artifacts WHERE compartment_id=1").run();
	db.query(
		`INSERT INTO memory_artifacts(source_path,source_sha256,source_kind,session_id,session_token,source_id,content,agent_id,compartment_id,captured_at,updated_at) VALUES('shared.md','same','file','session','token','source','evidence','alice',NULL,'2026-01-01','2026-01-01')`,
	).run();
	expect(
		readEpisodicSource(db, { agentId: "alice", from: "artifact:shared.md", exactCompartment: null }),
	).not.toBeNull();
	expect(verifiedDreamingEvidenceDelivery(db, delivery)).toBeNull();
	expect(() =>
		db.transaction(() =>
			recordDreamingEvidenceConsumptionInTx(db, { passId: "missing", deferredEvidence: new Set() }),
		)(),
	).not.toThrow();
	expect(db.query("SELECT COUNT(*) AS n FROM dreaming_evidence_consumption").get()).toEqual({ n: 0 });
});

it("filters continuation and drain progress by label before the page limit", () => {
	for (const label of [null, 1]) {
		const passId = `continuation-${label}`;
		db.query(
			`INSERT INTO dreaming_passes(id,agent_id,mode,status,created_at,compartment_id) VALUES(?,'alice','incremental','running','now',?)`,
		).run(passId, label);
		db.query(
			`INSERT INTO dreaming_evidence_consumption(agent_id,source_kind,source_id,source_captured_at,source_entry_id,source_revision,delivered_offset,source_length,pass_id,updated_at,compartment_id) VALUES('alice','artifact','shared.md','2026-01-01','source','same',?,8,?,'now',?)`,
		).run(label === null ? 8 : 2, passId, label);
	}
	expect(pendingDreamingEvidenceContinuations(db, "alice", 1, "artifact", 1).map((row) => row.id)).toEqual([
		"shared.md",
	]);
	expect(pendingDreamingEvidenceContinuations(db, "alice", 1, "artifact", null)).toEqual([]);
	expect(probeSourceEvidenceDrain(db, "alice", "source", { maxRenders: 1, compartmentId: 1 }).status).toBe("pending");
	expect(probeSourceEvidenceDrain(db, "alice", "source", { maxRenders: 1, compartmentId: null }).status).toBe(
		"drained",
	);
});

it("keeps review and exclusion keys independent and never hides another label's queue", () => {
	for (const label of [null, 1]) {
		const passId = `review-${label}`;
		db.query(
			`INSERT INTO dreaming_passes(id,agent_id,mode,status,created_at,compartment_id) VALUES(?,'alice','incremental','running','now',?)`,
		).run(passId, label);
		db.query(
			`INSERT INTO dreaming_evidence_reviews(agent_id,source_kind,source_id,source_captured_at,source_entry_id,source_revision,reason,pass_id,compartment_id) VALUES('alice','artifact','shared.md','2026-01-01','source','same','reviewed',?,?)`,
		).run(passId, label);
		db.query(
			`INSERT INTO dreaming_evidence_exclusions(agent_id,source_kind,source_id,reason,pass_id,compartment_id) VALUES('alice','artifact','shared.md','rejected',?,?)`,
		).run(passId, label);
	}
	expect(db.query("SELECT compartment_id FROM dreaming_evidence_reviews ORDER BY compartment_id").all()).toEqual([
		{ compartment_id: null },
		{ compartment_id: 1 },
	]);
	expect(db.query("SELECT compartment_id FROM dreaming_evidence_exclusions ORDER BY compartment_id").all()).toEqual([
		{ compartment_id: null },
		{ compartment_id: 1 },
	]);
	db.query("DELETE FROM dreaming_evidence_reviews WHERE compartment_id=1").run();
	expect(
		searchEpisodicSources(db, {
			agentId: "alice",
			query: "",
			kind: "artifact",
			exactCompartment: 1,
			excludeDelivered: true,
			limit: 1,
		}).map((row) => row.id),
	).toEqual(["shared.md"]);
	expect(db.query("SELECT compartment_id FROM dreaming_evidence_reviews").all()).toEqual([{ compartment_id: null }]);
});

it("refreshes large imported sources with bounded actual-source citations", () => {
	db.transaction(() => importedSourceAttentionUpsert(db, "alice", "source"))();
	const before = db
		.query<{ id: string; generation: number; compartment_id: number | null }, []>(
			"SELECT id,generation,compartment_id FROM dreaming_attention",
		)
		.all();
	db.transaction(() => {
		for (let n = 0; n < 201; n++)
			db.query(
				`INSERT INTO memory_artifacts(source_path,source_sha256,source_kind,session_id,session_token,source_id,content,agent_id,compartment_id,captured_at,updated_at) VALUES(?,'same','file','session','token','source','evidence','alice',1,'2026-01-01','2026-01-01')`,
			).run(`bulk-${n}.md`);
	})();
	expect(() => db.transaction(() => importedSourceAttentionUpsert(db, "alice", "source"))()).not.toThrow();
	expect(db.query("SELECT id,generation,compartment_id FROM dreaming_attention").all()).toEqual(
		before.map((row) => ({ ...row, generation: 1 })),
	);
	expect(db.query("SELECT evidence_id FROM evidence_citations WHERE derived_kind='attention'").all()).toEqual([
		{ evidence_id: "bulk-0.md" },
	]);
});

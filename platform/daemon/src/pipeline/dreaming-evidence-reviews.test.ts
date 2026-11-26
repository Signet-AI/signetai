import { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, it } from "bun:test";
import { runMigrations } from "../../../core/src/migrations";
import type { DbAccessor } from "../db-accessor";
import { registerDbOwnerIsolatedTestAccessor } from "../db-owner-runtime";
import { searchDreamingEvidenceInDb } from "./dreaming-capabilities";
import {
	getDreamingReviewedEvidence,
	recordDreamingReviewedExcludedEvidenceInTx,
	requestDreamingReviewedEvidenceRequeue,
} from "./dreaming-evidence-reviews";

let db: Database;
let accessor: DbAccessor;
beforeEach(() => {
	db = new Database(":memory:");
	runMigrations(db);
	accessor = {
		withReadDbAsync: async (fn) => fn(db),
		withWriteTxAsync: async (fn) => db.transaction(() => fn(db))(),
		withWriteDbAsync: async (fn) => fn(db),
		close: () => {},
	};
	registerDbOwnerIsolatedTestAccessor(accessor);
	db.exec(
		"INSERT INTO classifications(id,name) VALUES('secret','Secret'); INSERT INTO compartments(id,key) VALUES(1,'secret'); INSERT INTO compartment_members VALUES(1,'secret')",
	);
	db.exec(
		"INSERT INTO session_transcripts(session_key,content,agent_id,created_at,updated_at,completed_at) VALUES('same','Nothing durable.','alice','2026-01-01','2026-01-01','2026-01-01')",
	);
	for (const label of [null, 1]) {
		const passId = `pass-${label}`;
		db.query(
			"INSERT INTO dreaming_passes(id,agent_id,mode,status,created_at,compartment_id) VALUES(?,'alice','incremental','running','2026-01-01',?)",
		).run(passId, label);
		const input = { agentId: "alice", passId, sourceRef: "transcript:same" };
		const output = searchDreamingEvidenceInDb(db, input);
		db.query(
			"INSERT INTO dreaming_tool_calls(id,agent_id,pass_id,sequence,tool_name,input_json,output_json,success,latency_ms) VALUES(?,'alice',?,0,'search_evidence',?,?,1,0)",
		).run(`tool-${label}`, passId, JSON.stringify(input), JSON.stringify(output));
	}
});
afterEach(() => db.close());

it("records identical reviewed evidence separately for each running pass label", () => {
	for (const label of [null, 1])
		expect(
			recordDreamingReviewedExcludedEvidenceInTx(db, {
				passId: `pass-${label}`,
				scopeIds: new Set(["alice"]),
				entries: [{ agentId: "alice", sourceRef: "transcript:same", reason: "No durable fact" }],
				deferredEvidence: new Set(),
			}),
		).toBe(1);
	expect(db.query("SELECT compartment_id FROM dreaming_evidence_reviews ORDER BY compartment_id").all()).toEqual([
		{ compartment_id: null },
		{ compartment_id: 1 },
	]);
	db.exec("UPDATE dreaming_passes SET status='completed' WHERE id='pass-1'");
	expect(() =>
		recordDreamingReviewedExcludedEvidenceInTx(db, {
			passId: "pass-1",
			scopeIds: new Set(["alice"]),
			entries: [{ agentId: "alice", sourceRef: "transcript:same", reason: "No durable fact" }],
			deferredEvidence: new Set(),
		}),
	).toThrow("not running");
});

it("defaults review reads and requeues to public and validates the source before deletion", async () => {
	for (const label of [null, 1])
		db.query(
			"INSERT INTO dreaming_evidence_reviews(agent_id,source_kind,source_id,source_captured_at,source_entry_id,source_revision,reason,pass_id,reviewed_at,compartment_id) VALUES('alice','transcript','same','2026-01-01','','2026-01-01',?,?,'2026-01-01',?)",
		).run(label === null ? "public" : "private", `pass-${label}`, label);
	expect((await getDreamingReviewedEvidence(accessor, "alice")).map((row) => row.reason)).toEqual(["public"]);
	expect(await requestDreamingReviewedEvidenceRequeue(accessor, "alice", "transcript", "same")).toBe(true);
	expect(db.query("SELECT reason FROM dreaming_evidence_reviews").all()).toEqual([{ reason: "private" }]);
	db.exec("UPDATE session_transcripts SET compartment_id=1");
	expect(await requestDreamingReviewedEvidenceRequeue(accessor, "alice", "transcript", "same")).toBe(false);
	expect(db.query("SELECT reason FROM dreaming_evidence_reviews").all()).toEqual([{ reason: "private" }]);
	expect(
		await requestDreamingReviewedEvidenceRequeue(accessor, "alice", "transcript", "same", {
			reach: { kind: "own", agentId: "alice" },
			compartments: [1],
			projects: null,
		}),
	).toBe(true);
	expect(db.query("SELECT compartment_id FROM dreaming_attention ORDER BY compartment_id").all()).toEqual([
		{ compartment_id: null },
		{ compartment_id: 1 },
	]);
});

it("applies caller scope before the review page limit", async () => {
	const insert = db.query(
		"INSERT INTO dreaming_evidence_reviews(agent_id,source_kind,source_id,source_captured_at,source_entry_id,source_revision,reason,pass_id,reviewed_at,compartment_id) VALUES('alice','transcript',?,'2026-01-01','','2026-01-01',?,'pass-null',?,?)",
	);
	insert.run("public", "public", "2026-01-01", null);
	for (let index = 0; index < 501; index++) insert.run(`secret-${index}`, "private", "2026-02-01", 1);
	expect(
		(
			await getDreamingReviewedEvidence(accessor, "alice", {
				reach: { kind: "own", agentId: "alice" },
				compartments: [],
				projects: null,
			})
		).map((row) => row.sourceId),
	).toEqual(["public"]);
	expect(
		await getDreamingReviewedEvidence(accessor, "alice", {
			reach: { kind: "own", agentId: "bob" },
			compartments: "all",
			projects: null,
		}),
	).toEqual([]);
	expect(
		await getDreamingReviewedEvidence(accessor, "alice", {
			reach: { kind: "own", agentId: "alice" },
			compartments: "all",
			projects: ["project"],
		}),
	).toEqual([]);
});

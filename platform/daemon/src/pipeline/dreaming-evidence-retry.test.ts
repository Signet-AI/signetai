import { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, it } from "bun:test";
import { runMigrations } from "../../../core/src/migrations";
import {
	autoRequeueRepairedDreamingEvidenceInDb,
	collectRejectedDreamingEvidenceInDb,
	recordRejectedDreamingEvidenceInTx,
	resolveRequeuedDreamingEvidenceInTx,
} from "./dreaming-evidence-retry";

let db: Database;
beforeEach(() => {
	db = new Database(":memory:");
	runMigrations(db);
	db.exec(
		"INSERT INTO classifications(id,name) VALUES('secret','Secret'); INSERT INTO compartments(id,key) VALUES(1,'secret'); INSERT INTO compartment_members VALUES(1,'secret')",
	);
	for (const label of [null, 1]) {
		db.query(
			"INSERT INTO dreaming_passes(id,agent_id,mode,status,created_at,compartment_id) VALUES(?,'alice','incremental','running','2026-01-01',?)",
		).run(`pass-${label}`, label);
		if (label === null)
			db.query(
				"INSERT INTO memory_artifacts(source_path,source_sha256,source_kind,session_id,session_token,source_id,content,agent_id,compartment_id,captured_at,updated_at) VALUES('same','hash','file','s','t','src','repaired','alice',?,'2026-01-01','2026-01-01')",
			).run(label);
	}
});
afterEach(() => db.close());

it("records and resolves only the durable pass partition", () => {
	for (const label of [null, 1])
		recordRejectedDreamingEvidenceInTx(db, `pass-${label}`, [
			{
				agentId: "alice",
				sourceKind: "artifact",
				sourceId: "same",
				failureClass: "quote_mismatch",
				sourceFingerprint: "old",
			},
		]);
	expect(db.query("SELECT compartment_id FROM dreaming_evidence_exclusions ORDER BY compartment_id").all()).toEqual([
		{ compartment_id: null },
		{ compartment_id: 1 },
	]);
	db.exec("UPDATE dreaming_evidence_exclusions SET requeue_requested_at='now'");
	resolveRequeuedDreamingEvidenceInTx(db, "alice", "pass-1", { ok: true, items: [{ index: 0, ok: true }] }, [
		{ evidence: [{ source_ref: "artifact:same", quote: "repaired" }] },
	]);
	expect(db.query("SELECT compartment_id FROM dreaming_evidence_exclusions WHERE resolved_at IS NULL").all()).toEqual([
		{ compartment_id: null },
	]);
	expect(() =>
		recordRejectedDreamingEvidenceInTx(db, "missing", [
			{ agentId: "alice", sourceKind: "artifact", sourceId: "same", failureClass: "unknown", sourceFingerprint: null },
		]),
	).toThrow();
});

it("keeps classified hourly retries from consuming the public budget", () => {
	db.exec(
		"INSERT INTO dreaming_evidence_exclusions(agent_id,source_kind,source_id,reason,pass_id,excluded_at,failure_class,source_fingerprint,compartment_id,last_requeued_at,requeue_requested_at,retry_count) VALUES('alice','artifact','same','rejected','pass-1','2026-01-01','quote_mismatch','old',1,'2026-01-01T12:00:00.000Z','2026-01-01T12:00:00.000Z',1),('alice','artifact','same','rejected','pass-null','2026-01-01','quote_mismatch','old',NULL,NULL,NULL,0)",
	);
	expect(
		autoRequeueRepairedDreamingEvidenceInDb(
			db,
			{ cooldownMs: 0, hourlyBudget: 1, maxAttempts: 3 },
			Date.parse("2026-01-01T12:01:00Z"),
		),
	).toBe(1);
	expect(db.query("SELECT compartment_id FROM dreaming_attention").all()).toEqual([{ compartment_id: null }]);
});

it("reaches a repaired source after an unchanged prefix without exceeding the batch", () => {
	const insert = db.query(
		"INSERT INTO dreaming_evidence_exclusions(agent_id,source_kind,source_id,reason,pass_id,excluded_at,failure_class) VALUES('alice','artifact',?,'rejected','pass-null','2026-01-01','source_projection')",
	);
	for (let index = 0; index < 251; index++) insert.run(`missing-${index}`);
	insert.run("same");
	const policy = { cooldownMs: 0, hourlyBudget: 1, maxAttempts: 3 };
	expect(autoRequeueRepairedDreamingEvidenceInDb(db, policy, Date.parse("2026-01-01T12:01:00Z"))).toBe(0);
	expect(autoRequeueRepairedDreamingEvidenceInDb(db, policy, Date.parse("2026-01-01T12:01:00Z"))).toBe(1);
	expect(db.query("SELECT retry_count FROM dreaming_evidence_exclusions WHERE source_id='same'").get()).toEqual({
		retry_count: 1,
	});
});

it("treats hidden failed evidence as missing and derives write fingerprints from pass-readable sources", () => {
	db.exec("UPDATE memory_artifacts SET compartment_id=1");
	const operations = [{ evidence: [{ source_ref: "artifact:same", quote: "repaired" }] }];
	const result = { ok: false, items: [{ index: 0, ok: false }] };
	const hidden = collectRejectedDreamingEvidenceInDb(db, "alice", result, operations);
	const readable = collectRejectedDreamingEvidenceInDb(db, "alice", result, operations, "pass-1");
	expect(readable[0]?.failureClass).toBe("unknown");
	expect(readable[0]?.sourceFingerprint).toBeString();
	db.exec("DELETE FROM memory_artifacts");
	expect(collectRejectedDreamingEvidenceInDb(db, "alice", result, operations)).toEqual(hidden);
	recordRejectedDreamingEvidenceInTx(db, "pass-null", [
		{
			agentId: "alice",
			sourceKind: "artifact",
			sourceId: "same",
			failureClass: "quote_mismatch",
			sourceFingerprint: "private-fingerprint",
		},
	]);
	expect(
		db.query("SELECT compartment_id,source_fingerprint,failure_class FROM dreaming_evidence_exclusions").get(),
	).toEqual({ compartment_id: null, source_fingerprint: null, failure_class: "source_projection" });
});

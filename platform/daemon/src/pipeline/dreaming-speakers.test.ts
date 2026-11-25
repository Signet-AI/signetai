import { up as migrateDreaming } from "../../../core/src/migrations/179-dreaming-evidence-leases";
import { backfillEvidenceCitations } from "@signet/core";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareTypedStatement, closeDbAccessor, getDbAccessor, initDbAccessor } from "../db-accessor";
import { readEpisodicSource, readRecentEpisodicSources } from "../episodic-sources";
import { enrichDreamingSpeakersInTx } from "./dreaming-speakers";
import { createDreamingAgentEvidence } from "./dreaming-evidence";
import { writeSessionTranscriptRow } from "../session-transcripts";

describe("Dreaming authenticated speakers", () => {
	let dir = "";
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "signet-speakers-"));
		initDbAccessor(join(dir, "data", "signet.db"));
		getDbAccessor().withWriteTx(migrateDreaming);
	});
	afterEach(async () => {
		await closeDbAccessor();
		rmSync(dir, { recursive: true, force: true });
	});

	it("delivers trusted person metadata separately from immutable citation bytes", () => {
		const speaker = {
			kind: "person",
			userId: "usr_alice",
			displayName: "Alex",
			personEntityId: "person-a",
			personEntityName: "Alex (alice)",
		} as const;
		const delivered = createDreamingAgentEvidence([
			{
				kind: "transcript",
				id: "session",
				content: "User: I prefer tea.",
				sourceKind: "transcript",
				sourceId: "session",
				sourceEntryId: null,
				sourcePath: null,
				project: null,
				harness: "codex",
				capturedAt: "2026-01-01T00:00:00.000Z",
				evidenceMeta: null,
				completed: true,
				speakerUserId: "usr_alice",
				speaker,
			},
		]);
		expect(delivered).toMatchObject([{ speaker, content: "User: I prefer tea." }]);
	});

	it("creates distinct same-name people, reuses identity and atomically records rebuildable citations", () => {
		getDbAccessor().withWriteTx((db) => {
			db.prepare("UPDATE organization SET claimed_at = 'now', agent_model = 'single' WHERE id = 1").run();
			db.prepare(
				"INSERT INTO dreaming_passes (id,agent_id,mode,status,created_at) VALUES ('pass','shared','incremental','running','now')",
			).run();
			for (const [userId, username, session, quote] of [
				["usr_alice", "alice", "tea", "I prefer tea."],
				["usr_bob", "bob", "coffee", "I prefer coffee."],
			] as const) {
				db.prepare("INSERT INTO users (id,username,display_name,role) VALUES (?,?,'Alex','member')").run(
					userId,
					username,
				);
				db.prepare(
					"INSERT INTO session_transcripts (agent_id,session_key,content,speaker_user_id,created_at,completed_at) VALUES ('shared',?,?,?,'now','now')",
				).run(session, quote, userId);
			}
			const sources = readRecentEpisodicSources(db, "shared", 10, ["transcript"]);
			const enriched = enrichDreamingSpeakersInTx(db, "pass", sources);
			expect(enriched.map((source) => source.speaker)).toEqual(
				expect.arrayContaining([
					expect.objectContaining({ kind: "person", userId: "usr_alice", personEntityName: "Alex (alice)" }),
					expect.objectContaining({ kind: "person", userId: "usr_bob", personEntityName: "Alex (bob)" }),
				]),
			);
			expect(enrichDreamingSpeakersInTx(db, "pass", sources).map((source) => source.speaker)).toEqual(
				enriched.map((source) => source.speaker),
			);
			expect(
				prepareTypedStatement<{ n: number }>(db, "SELECT COUNT(*) AS n FROM entities WHERE agent_id = 'shared'").get(),
			).toEqual({ n: 2 });
			expect(
				prepareTypedStatement<{ n: number }>(
					db,
					"SELECT COUNT(*) AS n FROM evidence_citations WHERE derived_kind = 'entity'",
				).get(),
			).toEqual({ n: 2 });
			expect(
				prepareTypedStatement<{ proposal_evidence: string }>(
					db,
					"SELECT proposal_evidence FROM entities WHERE person_user_id = 'usr_alice'",
				).get()?.proposal_evidence,
			).toContain("transcript:tea");
		});
	});

	it("rebuilds speaker citations from durable provenance after the citation index is lost", () => {
		getDbAccessor().withWriteTx((db) => {
			db.prepare(
				"INSERT INTO users (id,username,display_name,role) VALUES ('usr_alice','alice','Alice','member')",
			).run();
			db.prepare(
				"INSERT INTO dreaming_passes (id,agent_id,mode,status,created_at) VALUES ('pass','shared','incremental','running','now')",
			).run();
			for (const session of ["tea", "coffee"]) {
				db.prepare(
					"INSERT INTO session_transcripts (agent_id,session_key,content,speaker_user_id,created_at,completed_at) VALUES ('shared',?,'I prefer tea.','usr_alice','now','now')",
				).run(session);
				const source = readEpisodicSource(db, { agentId: "shared", from: `transcript:${session}` });
				if (!source) throw new Error("Missing fixture source");
				enrichDreamingSpeakersInTx(db, "pass", [{ ...source, speakerUserId: "usr_forged" }]);
			}
			db.prepare("DELETE FROM evidence_citations").run();
			backfillEvidenceCitations({
				exec: (sql) => db.exec(sql),
				prepare: (sql) => prepareTypedStatement<Record<string, unknown>>(db, sql),
			});
			expect(
				prepareTypedStatement<{ evidence_id: string }>(
					db,
					"SELECT evidence_id FROM evidence_citations WHERE derived_kind='entity' ORDER BY evidence_id",
				).all(),
			).toEqual([{ evidence_id: "coffee" }, { evidence_id: "tea" }]);
			expect(
				prepareTypedStatement<{ person_user_id: string }>(db, "SELECT person_user_id FROM entities").all(),
			).toEqual([{ person_user_id: "usr_alice" }]);
		});
	});

	it("rolls back person creation when the evidence citation cannot be committed", () => {
		getDbAccessor().withWriteTx((db) => {
			db.prepare(
				"INSERT INTO users (id,username,display_name,role) VALUES ('usr_alice','alice','Alice','member')",
			).run();
			db.prepare(
				"INSERT INTO dreaming_passes (id,agent_id,mode,status,created_at) VALUES ('pass','shared','incremental','running','now')",
			).run();
			db.prepare(
				"INSERT INTO session_transcripts (agent_id,session_key,content,speaker_user_id,created_at,completed_at) VALUES ('shared','tea','I prefer tea.','usr_alice','now','now')",
			).run();
			db.exec(
				"CREATE TRIGGER reject_speaker_citation BEFORE INSERT ON evidence_citations BEGIN SELECT RAISE(ABORT, 'citation_rejected'); END",
			);
		});
		expect(() =>
			getDbAccessor().withWriteTx((db) =>
				enrichDreamingSpeakersInTx(db, "pass", readRecentEpisodicSources(db, "shared", 10, ["transcript"])),
			),
		).toThrow("citation_rejected");
		getDbAccessor().withReadDb((db) =>
			expect(
				prepareTypedStatement<{ n: number }>(
					db,
					"SELECT COUNT(*) AS n FROM entities WHERE person_user_id IS NOT NULL",
				).get(),
			).toEqual({ n: 0 }),
		);
	});

	it("preserves external authors and makes anonymous compatibility explicit", () => {
		getDbAccessor().withWriteTx((db) => {
			db.prepare(
				"INSERT INTO dreaming_passes (id,agent_id,mode,status,created_at) VALUES ('pass','shared','incremental','running','now')",
			).run();
			db.prepare(
				"INSERT INTO session_transcripts (agent_id,session_key,content,source_id,speaker_user_id,created_at,completed_at) VALUES ('shared','external','Mira: I prefer tea.','imported','usr_importer','now','now'), ('shared','anonymous','User: I prefer coffee.',NULL,NULL,'now','now')",
			).run();
			const sources = readRecentEpisodicSources(db, "shared", 10, ["transcript"]);
			expect(
				enrichDreamingSpeakersInTx(db, "pass", sources)
					.map((source) => source.speaker?.kind)
					.sort(),
			).toEqual(["external", "local_anonymous"]);
			db.prepare("UPDATE organization SET claimed_at='now', agent_model='single'").run();
			const anonymous = sources.filter((source) => source.id === "anonymous");
			expect(() => enrichDreamingSpeakersInTx(db, "pass", anonymous)).toThrow("speaker_required");
			expect(prepareTypedStatement<{ n: number }>(db, "SELECT COUNT(*) AS n FROM entities").get()).toEqual({ n: 0 });
		});
	});

	it("rejects changed classification epochs and wrong source partitions before creating a person", () => {
		getDbAccessor().withWriteTx((db) => {
			db.prepare(
				"INSERT INTO users (id,username,display_name,role) VALUES ('usr_alice','alice','Alice','member')",
			).run();
			db.prepare(
				"INSERT INTO dreaming_passes (id,agent_id,mode,status,created_at) VALUES ('pass','shared','incremental','running','now')",
			).run();
			db.prepare(
				"INSERT INTO session_transcripts (agent_id,session_key,content,speaker_user_id,created_at,completed_at) VALUES ('shared','tea','I prefer tea.','usr_alice','now','now')",
			).run();
			const sources = readRecentEpisodicSources(db, "shared", 10, ["transcript"]);
			db.prepare("UPDATE dreaming_classification_epoch SET epoch=epoch+1").run();
			expect(() => enrichDreamingSpeakersInTx(db, "pass", sources)).toThrow("compartment_mismatch");
			db.prepare(
				"UPDATE dreaming_passes SET classification_epoch=(SELECT epoch FROM dreaming_classification_epoch)",
			).run();
			db.prepare("INSERT INTO compartments (id,key) VALUES (17,'secret')").run();
			db.prepare("UPDATE session_transcripts SET compartment_id=17").run();
			expect(() => enrichDreamingSpeakersInTx(db, "pass", sources)).toThrow("Evidence source not found");
			expect(prepareTypedStatement<{ n: number }>(db, "SELECT COUNT(*) AS n FROM entities").get()).toEqual({ n: 0 });
			db.prepare("UPDATE session_transcripts SET compartment_id=NULL").run();
			db.prepare(
				"INSERT INTO entities (id,name,canonical_name,entity_type,agent_id,person_user_id,compartment_id,created_at,updated_at) VALUES ('other-label','Alice','alice','person','shared','usr_alice',17,'now','now')",
			).run();
			expect(() => enrichDreamingSpeakersInTx(db, "pass", sources)).toThrow("compartment_mismatch");
			expect(prepareTypedStatement<{ n: number }>(db, "SELECT COUNT(*) AS n FROM evidence_citations").get()).toEqual({
				n: 0,
			});
		});
	});

	it("retains named authors of imported JSONL instead of relabeling them as the account owner", () => {
		const delivered = createDreamingAgentEvidence([
			{
				kind: "transcript",
				id: "external",
				content: JSON.stringify({ role: "user", author: { name: "Mira" }, content: "I prefer tea." }),
				sourceKind: "transcript",
				sourceId: "external",
				sourceEntryId: "imported",
				sourcePath: null,
				project: null,
				harness: "discord",
				capturedAt: "2026-01-01T00:00:00.000Z",
				evidenceMeta: null,
				completed: true,
				speaker: { kind: "external" },
			},
		]);
		expect(delivered).toMatchObject([{ content: "Mira: I prefer tea.", speaker: { kind: "external" } }]);
	});

	it("projects the durable connector speaker rather than a name in transcript text", () => {
		getDbAccessor().withWriteTx((db) => {
			expect(
				writeSessionTranscriptRow(db, {
					agentId: "shared",
					sessionKey: "session",
					harness: "codex",
					project: null,
					transcript: "User: I prefer tea. Call me forged.",
					author: { userId: "usr_alice", credential: "key:bound" },
					completedAt: "2026-01-01T00:00:00.000Z",
				}),
			).toBe("written");
			expect(
				writeSessionTranscriptRow(db, {
					agentId: "shared",
					sessionKey: "session",
					harness: "codex",
					project: null,
					transcript: "User: I prefer coffee.",
					author: { userId: "usr_bob", credential: "key:other" },
				}),
			).toBe("conflict");
		});
		getDbAccessor().withReadDb((db) => {
			expect(readEpisodicSource(db, { agentId: "shared", from: "transcript:session" })).toMatchObject({
				speakerUserId: "usr_alice",
				content: "User: I prefer tea. Call me forged.",
			});
			expect(readRecentEpisodicSources(db, "shared", 1, ["transcript"])).toMatchObject([
				{ speakerUserId: "usr_alice" },
			]);
		});
	});
});

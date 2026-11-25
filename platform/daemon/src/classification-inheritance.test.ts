import { expect, test } from "bun:test";
import * as shards from "../../core/src/compartment-shards";
import { classificationFixture } from "./test-support/classification-fixture.test";
import { txIngestEnvelope } from "./transactions";
import { upsertMemoryArtifactInTx } from "./memory-lineage";
import { writeSessionTranscriptRow, commitCompactionSummaryInTx } from "./session-transcripts";

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
	expect(() => db.prepare("UPDATE memories SET source_id='forgot label' WHERE id='m'").run()).toThrow(
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
		expect(shards.compartmentForWrite(db, { agentId: "default", memoryId: "new" })).toBe(c);
	})();
	expect(db.prepare("SELECT count(*) n FROM memories_fts WHERE memories_fts MATCH 'hidden'").get()).toEqual({ n: 0 });
	db.close();
});
test("compaction summaries inherit their session classification on insert and repeated upsert", () => {
	const db = assigned();
	for (const summaryId of ["summary-one", "summary-two"])
		db.transaction(() =>
			commitCompactionSummaryInTx(db, {
				author: { userId: null, credential: "system" },
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

test("canonical memory ingestion inherits an already classified agent", () => {
	const db = assigned();
	db.transaction(() =>
		txIngestEnvelope(db, {
			author: { userId: null, credential: "system" },
			id: "ingested",
			content: "new secret",
			contentHash: "new-hash",
			who: "test",
			why: null,
			project: null,
			importance: 0.5,
			type: "fact",
			tags: null,
			pinned: 0,
			sourceType: "user",
			sourceId: null,
			agentId: "default",
			createdAt: "now",
		}),
	)();
	expect(db.prepare("SELECT compartment_id FROM memories WHERE id='ingested'").get()).toMatchObject({
		compartment_id: expect.any(Number),
	});
	db.close();
});
test("live transcripts inherit classified agents before their FTS triggers execute", () => {
	const db = assigned();
	db.transaction(() =>
		writeSessionTranscriptRow(db, {
			sessionKey: "live",
			transcript: "new secret",
			harness: "test",
			project: null,
			agentId: "default",
			capturedAt: "now",
		}),
	)();
	expect(db.prepare("SELECT compartment_id FROM session_transcripts WHERE session_key='live'").get()).toMatchObject({
		compartment_id: expect.any(Number),
	});
	expect(
		db.prepare("SELECT count(*) n FROM session_transcripts_fts WHERE session_transcripts_fts MATCH 'secret'").get(),
	).toEqual({ n: 0 });
	db.close();
});
test("scope guards seek complete assignment keys instead of scanning an agent", () => {
	const db = classificationFixture();
	const plan = db.prepare("EXPLAIN UPDATE memories SET source_id='other' WHERE id='m'").all();
	expect(plan.some((row) => row.opcode === "SeekGE" && row.p4 === "3")).toBe(true);
	db.close();
});
test("NULL-agent embeddings cannot bypass their parent memory compartment", () => {
	const db = assigned();
	const c = shards.compartmentForWrite(db, { agentId: "default", memoryId: "m" });
	db.prepare("UPDATE memories SET compartment_id=? WHERE id='m'").run(c);
	const insert = db.prepare(
		"INSERT INTO embeddings(id,content_hash,vector,dimensions,source_type,source_id,chunk_text,created_at,agent_id,compartment_id) VALUES('legacy','legacy',X'0000803f0000000000000000',3,'memory','m','secret','now',NULL,?)",
	);
	expect(() => insert.run(null)).toThrow("compartment_required");
	insert.run(c);
	shards.inheritEmbeddingCompartment(db, "embeddings", "legacy");
	expect(db.prepare("SELECT agent_id,compartment_id FROM embeddings WHERE id='legacy'").get()).toEqual({
		agent_id: "default",
		compartment_id: c,
	});
	db.close();
});
test("source artifact upserts inherit classified agents before their FTS triggers execute", () => {
	const db = assigned();
	db.transaction(() =>
		upsertMemoryArtifactInTx(db, {
			agentId: "default",
			sourcePath: "notes/private",
			sourceSha256: "hash",
			sourceKind: "source",
			sessionId: "source",
			sessionKey: null,
			sessionToken: "token",
			project: null,
			harness: null,
			capturedAt: "now",
			startedAt: null,
			endedAt: null,
			manifestPath: null,
			sourceNodeId: null,
			memorySentence: null,
			memorySentenceQuality: null,
			content: "new secret",
			updatedAt: "now",
			sourceMtimeMs: null,
			sourceId: "src",
			sourceRoot: null,
			sourceExternalId: null,
			sourceParentPath: null,
			sourceMetaJson: null,
		}),
	)();
	expect(
		db.prepare("SELECT compartment_id FROM memory_artifacts WHERE source_path='notes/private'").get(),
	).toMatchObject({ compartment_id: expect.any(Number) });
	expect(
		db.prepare("SELECT count(*) n FROM memory_artifacts_fts WHERE memory_artifacts_fts MATCH 'secret'").get(),
	).toEqual({ n: 0 });
	db.close();
});

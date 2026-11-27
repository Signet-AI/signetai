import { expect, test } from "bun:test";
import { currentClassificationFixture } from "../test-support/classification-fixture.test";
import { compartmentForWrite } from "../../../core/src/compartment-shards";
import { finalizeDreamingPassInDb } from "./dreaming";

for (const targetKind of ["agent", "session"] as const) {
	test(`manifests inherit ${targetKind} labels and the durable speaker`, () => {
		const db = currentClassificationFixture();
		try {
			db.prepare(
				"INSERT INTO session_transcripts(session_key,content,agent_id,created_at,completed_at,speaker_user_id) VALUES('classified-manifest','User: classified evidence','default',?,?, 'alice')",
			).run(new Date().toISOString(), new Date().toISOString());
			db.prepare("INSERT INTO classifications(id,name) VALUES('cls_manifest','Manifest')").run();
			db.prepare(
				"INSERT INTO classification_assignments(target_kind,target_id,agent_id,classification_id,applied_at) VALUES(?,?,?,?,?)",
			).run(
				targetKind,
				targetKind === "agent" ? "default" : "classified-manifest",
				"default",
				"cls_manifest",
				new Date().toISOString(),
			);
			const compartmentId = compartmentForWrite(db, { agentId: "default", sessionKey: "classified-manifest" });
			db.prepare(
				"INSERT INTO dreaming_passes(id,agent_id,mode,status,scope_key,compartment_id) VALUES('manifest-pass','default','incremental-hygiene','running','default',?)",
			).run(compartmentId);
			const source = {
				kind: "transcript",
				id: "classified-manifest",
				content: "User: classified evidence",
				sourceKind: "transcript",
				sourceId: "classified-manifest",
				sourcePath: null,
				sourceEntryId: null,
				project: null,
				harness: "hermes",
				capturedAt: new Date().toISOString(),
				evidenceMeta: null,
				completed: true,
			};
			db.transaction(() =>
				finalizeDreamingPassInDb(db, {
					passId: "manifest-pass",
					mode: "incremental-hygiene",
					agentId: "default",
					scopes: ["default"],
					transcriptManifestEntries: [{ scope: "default", source, content: source.content }],
					tokensConsumed: null,
					inputTokens: null,
					outputTokens: null,
					cacheReadTokens: null,
					cacheCreationTokens: null,
					peakContextTokens: null,
					totalCost: null,
					applied: 0,
					failed: 0,
					summary: "done",
					rejectedEvidence: [],
					memoryHeadCommitInput: null,
					hasBacklogByScope: [],
					nextWatermarkByScope: [],
				}),
			).immediate();
			expect(
				db
					.prepare(
						"SELECT author_user_id,compartment_id FROM session_summaries WHERE session_key='classified-manifest'",
					)
					.get(),
			).toEqual({ author_user_id: "alice", compartment_id: expect.any(Number) });
			expect(
				db
					.prepare(
						"SELECT classification_id FROM compartment_members WHERE compartment_id=(SELECT compartment_id FROM session_summaries WHERE session_key='classified-manifest')",
					)
					.all(),
			).toEqual([{ classification_id: "cls_manifest" }]);
		} finally {
			db.close();
		}
	});
}

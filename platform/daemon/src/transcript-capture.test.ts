import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { up as createHookUploads } from "../../core/src/migrations/180-hook-transcript-uploads";
import { formatLivePromptTranscript } from "./transcript-capture";
import { type CaptureEnqueueInput, enqueueTranscriptCaptureInTx } from "./transcript-capture-owner";

describe("transcript capture helpers", () => {
	test("formats live prompt transcript with optional assistant turn", () => {
		expect(formatLivePromptTranscript("next question", "previous answer")).toBe(
			"Assistant: previous answer\nUser: next question",
		);
		expect(formatLivePromptTranscript("next question")).toBe("User: next question");
	});

	test("concurrent admission replays its bound receipt after upload cleanup", () => {
		const db = new Database(":memory:");
		try {
			createHookUploads(db);
			db.prepare(
				"INSERT INTO hook_transcript_receipts (id,agent_id,principal_id,credential_kind,credential_id,harness,session_key,sha256,size_bytes,result_json) VALUES (?,?,?,?,?,?,?,?,?,?)",
			).run(
				"upload-a",
				"agent-a",
				"alice",
				"connector_key",
				"key-a",
				"codex",
				"session-a",
				"a".repeat(64),
				5,
				JSON.stringify({ memoriesSaved: 0, queued: true, transcriptCaptureJobId: "capture-existing" }),
			);
			const upload = {
				kind: "hook" as const,
				fileId: "upload-a",
				agentId: "agent-a",
				principalId: "alice",
				credentialKind: "connector_key",
				credentialId: "key-a",
				harness: "codex",
				sessionKey: "session-a",
			};
			const prepared: CaptureEnqueueInput = {
				input: {
					agentId: upload.agentId,
					harness: upload.harness,
					sessionKey: upload.sessionKey,
					sessionId: upload.sessionKey,
					project: null,
					transcript: "",
					capturedAt: new Date().toISOString(),
					endedAt: null,
					upload,
				},
				source: { path: "signet-upload:upload-a", sizeBytes: 5, mtimeMs: 0 },
				stored: null,
				sourceIdentity: "upload-a",
				sourceSha256: "a".repeat(64),
				id: "capture-duplicate",
				createdAt: new Date().toISOString(),
				maxAttempts: 3,
			};
			expect(enqueueTranscriptCaptureInTx(db, prepared)).toBe("capture-existing");
			for (const binding of [{ principalId: "bob" }, { credentialId: "key-b" }, { credentialKind: "api_key" }]) {
				expect(() =>
					enqueueTranscriptCaptureInTx(db, {
						...prepared,
						input: { ...prepared.input, upload: { ...upload, ...binding } },
					}),
				).toThrow("Transcript upload not found");
			}
			expect(() =>
				enqueueTranscriptCaptureInTx(db, {
					...prepared,
					input: { ...prepared.input, agentId: "agent-b", upload: { ...upload, agentId: "agent-b" } },
				}),
			).toThrow("Transcript upload not found");
			expect(db.prepare("SELECT COUNT(*) AS count FROM hook_transcript_uploads").get()).toEqual({ count: 0 });
			expect(db.prepare("SELECT COUNT(*) AS count FROM hook_transcript_receipts").get()).toEqual({ count: 1 });
			db.exec("UPDATE hook_transcript_receipts SET consumed_at = datetime('now','-8 days')");
			expect(() => enqueueTranscriptCaptureInTx(db, prepared)).toThrow("Transcript upload not found");
		} finally {
			db.close();
		}
	});
});

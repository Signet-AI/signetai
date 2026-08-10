import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clearContinuity, getState, initContinuity, recordPrompt } from "./continuity-state";
import { closeDbAccessor, getDbAccessor, initDbAccessor } from "./db-accessor";
import { upsertSessionTranscript } from "./session-transcripts";
import { createTtlEvictionHandler } from "./session-ttl-finalizer";

describe("TTL eviction finalizer (#902)", () => {
	let dir = "";

	afterEach(() => {
		closeDbAccessor();
		rmSync(dir, { recursive: true, force: true });
	});

	function setup(): void {
		dir = mkdtempSync(join(tmpdir(), "signet-ttl-finalizer-"));
		mkdirSync(join(dir, "memory"), { recursive: true });
		initDbAccessor(join(dir, "memory", "memories.db"));
	}

	it("writes a ttl_expired checkpoint from residual continuity state", () => {
		setup();
		const sessionKey = "ttl-checkpoint-sess";
		initContinuity(sessionKey, "hermes", "test-project");
		recordPrompt(sessionKey, "query-a", "prompt-a");
		const handler = createTtlEvictionHandler({
			accessor: getDbAccessor(),
			maxCheckpointsPerSession: 50,
		});
		expect(getState(sessionKey)).toBeDefined();

		const outcome = handler({
			sessionKey,
			agentId: "default",
			runtimePath: "plugin",
			claimedAt: new Date().toISOString(),
		});

		expect(outcome).toBe("skipped");
		const row = getDbAccessor().withReadDb(
			(db) =>
				db
					.prepare(
						"SELECT trigger, session_key FROM session_checkpoints WHERE session_key = ? ORDER BY created_at DESC LIMIT 1",
					)
					.get(sessionKey) as { trigger: string; session_key: string } | undefined,
		);
		expect(row?.trigger).toBe("ttl_expired");
		expect(row?.session_key).toBe(sessionKey);
		clearContinuity(sessionKey);
	});

	it("marks a retained transcript complete and deduplicates repeated TTL finalization", () => {
		setup();
		const transcript = `User: ${"x".repeat(600)}`;
		upsertSessionTranscript("ttl-transcript", transcript, "plugin", null, "agent-a");
		const handler = createTtlEvictionHandler({
			accessor: getDbAccessor(),
			maxCheckpointsPerSession: 50,
		});
		const info = {
			sessionKey: "ttl-transcript",
			agentId: "agent-a",
			runtimePath: "plugin" as const,
			claimedAt: new Date().toISOString(),
		};

		expect(handler(info)).toBe("finalized");
		expect(handler(info)).toBe("finalized");
		const row = getDbAccessor().withReadDb(
			(db) =>
				db
					.prepare("SELECT completed_at, content_hash FROM session_transcripts WHERE session_key = ? AND agent_id = ?")
					.get("ttl-transcript", "agent-a") as { completed_at: string | null; content_hash: string | null } | undefined,
		);
		expect(row?.completed_at).toBeTruthy();
		expect(row?.content_hash).toBeTruthy();
	});

	it("skips when there is no retained transcript", () => {
		setup();
		const handler = createTtlEvictionHandler({
			accessor: getDbAccessor(),
			maxCheckpointsPerSession: 50,
		});

		expect(
			handler({
				sessionKey: "ttl-empty-sess",
				agentId: "default",
				runtimePath: "plugin",
				claimedAt: new Date().toISOString(),
			}),
		).toBe("skipped");
	});
});

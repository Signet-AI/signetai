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
			isSummarySynthesisAvailable: () => true,
		});
		expect(getState(sessionKey)).toBeDefined();

		const outcome = handler({
			sessionKey,
			agentId: "default",
			runtimePath: "plugin",
			claimedAt: new Date().toISOString(),
		});

		// The checkpoint survives, but there is no summary to finalize without a transcript.
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

	it("returns skipped when there is no continuity state and no transcript", () => {
		setup();
		const handler = createTtlEvictionHandler({
			accessor: getDbAccessor(),
			maxCheckpointsPerSession: 50,
			isSummarySynthesisAvailable: () => true,
		});

		const outcome = handler({
			sessionKey: "ttl-empty-sess",
			agentId: "default",
			runtimePath: "plugin",
			claimedAt: new Date().toISOString(),
		});

		expect(outcome).toBe("skipped");
	});

	it("stores the content hash and deduplicates repeated TTL finalization", () => {
		setup();
		const transcript = `User: ${"x".repeat(600)}`;
		upsertSessionTranscript("ttl-transcript", transcript, "plugin", null, "agent-a");
		const handler = createTtlEvictionHandler({
			accessor: getDbAccessor(),
			maxCheckpointsPerSession: 50,
			isSummarySynthesisAvailable: () => true,
		});
		const info = {
			sessionKey: "ttl-transcript",
			agentId: "agent-a",
			runtimePath: "plugin" as const,
			claimedAt: new Date().toISOString(),
		};

		expect(handler(info)).toBe("finalized");
		expect(handler(info)).toBe("finalized");
		const jobs = getDbAccessor().withReadDb(
			(db) =>
				db
					.prepare("SELECT content_hash FROM summary_jobs WHERE session_key = ? AND agent_id = ?")
					.all("ttl-transcript", "agent-a") as Array<{ content_hash: string | null }>,
		);
		expect(jobs).toHaveLength(1);
		expect(jobs[0]?.content_hash).toBeTruthy();
	});

	it("skips finalization when synthesis is unavailable", () => {
		setup();
		upsertSessionTranscript("ttl-disabled", `User: ${"x".repeat(600)}`, "plugin", null, "agent-a");
		const handler = createTtlEvictionHandler({
			accessor: getDbAccessor(),
			maxCheckpointsPerSession: 50,
			isSummarySynthesisAvailable: () => false,
		});

		expect(
			handler({
				sessionKey: "ttl-disabled",
				agentId: "agent-a",
				runtimePath: "plugin",
				claimedAt: new Date().toISOString(),
			}),
		).toBe("skipped");
		const count = getDbAccessor().withReadDb(
			(db) => (db.prepare("SELECT COUNT(*) AS count FROM summary_jobs").get() as { count: number }).count,
		);
		expect(count).toBe(0);
	});
});

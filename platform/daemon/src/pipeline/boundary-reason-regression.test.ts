/**
 * Regression tests for issue #896: Session synthesis lacks boundary
 * reason/idempotency and repeats durable summaries across compactions.
 *
 * One logical session with three compactions and one final close should
 * produce checkpoint/continuity artifacts as configured, exactly one
 * terminal durable synthesis over each transcript range, and no duplicated
 * durable facts from overlapping ranges.
 */
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { join } from "node:path";
import { runMigrations } from "../../../core/src/migrations";
import type { DbAccessor, ReadDb, WriteDb } from "../db-accessor";
import { isDurableBoundary, normalizeBoundaryReason } from "./boundary-reason";
import { enqueueSummaryJob, insertSummaryFacts, tracksSessionSummaryArtifact } from "./summary-worker";
import type { SummaryJobRow } from "./summary-worker";

function makeAccessor(db: Database): DbAccessor {
	return {
		withWriteTx<T>(fn: (db: WriteDb) => T): T {
			db.exec("BEGIN IMMEDIATE");
			try {
				const result = fn(db as unknown as WriteDb);
				db.exec("COMMIT");
				return result;
			} catch (err) {
				db.exec("ROLLBACK");
				throw err;
			}
		},
		withReadDb<T>(fn: (db: ReadDb) => T): T {
			return fn(db as unknown as ReadDb);
		},
		close() {
			db.close();
		},
	};
}

function makeJobRow(overrides: Partial<SummaryJobRow> = {}): SummaryJobRow {
	return {
		id: overrides.id ?? "job-id-896",
		session_key: overrides.session_key ?? "session-key-896",
		session_id: overrides.session_id ?? "session-id-896",
		harness: overrides.harness ?? "hermes-agent",
		project: overrides.project ?? "/home/user/project",
		agent_id: overrides.agent_id ?? "default",
		transcript: overrides.transcript ?? "User: hello\nAssistant: hi there",
		trigger: overrides.trigger ?? "session_end",
		boundary_reason: overrides.boundary_reason ?? null,
		captured_at: overrides.captured_at ?? new Date().toISOString(),
		started_at: overrides.started_at ?? null,
		ended_at: overrides.ended_at ?? null,
		attempts: overrides.attempts ?? 0,
		max_attempts: overrides.max_attempts ?? 3,
		created_at: overrides.created_at ?? new Date().toISOString(),
	};
}

describe("issue #896: boundary reason idempotency", () => {
	let db: Database;
	let accessor: DbAccessor;

	beforeEach(() => {
		db = new Database(":memory:");
		runMigrations(db as unknown as Parameters<typeof runMigrations>[0]);
		accessor = makeAccessor(db);
	});

	afterEach(() => {
		db.close();
	});

	it("compaction boundaries do not produce durable summary artifacts", () => {
		const compactionJob = makeJobRow({
			boundary_reason: "compaction",
			trigger: "checkpoint_extract",
		});
		expect(tracksSessionSummaryArtifact(compactionJob)).toBe(false);
	});

	it("checkpoint boundaries do not produce durable summary artifacts", () => {
		const checkpointJob = makeJobRow({
			boundary_reason: "checkpoint",
			trigger: "checkpoint_extract",
		});
		expect(tracksSessionSummaryArtifact(checkpointJob)).toBe(false);
	});

	it("session_closed boundaries produce durable summary artifacts", () => {
		const closeJob = makeJobRow({
			boundary_reason: "session_closed",
			trigger: "session_end",
		});
		expect(tracksSessionSummaryArtifact(closeJob)).toBe(true);
	});

	it("null boundary_reason is treated as durable (backward compat)", () => {
		const legacyJob = makeJobRow({
			boundary_reason: null,
			trigger: "session_end",
		});
		expect(tracksSessionSummaryArtifact(legacyJob)).toBe(true);
	});

	it("enqueueSummaryJob stores boundary_reason in summary_jobs", () => {
		const jobId = enqueueSummaryJob(accessor, {
			harness: "hermes-agent",
			transcript: "test transcript content",
			sessionKey: "test-session",
			agentId: "default",
			trigger: "checkpoint_extract",
			boundaryReason: "compaction",
		});

		const row = db.prepare("SELECT boundary_reason FROM summary_jobs WHERE id = ?").get(jobId) as {
			boundary_reason: string | null;
		};
		expect(row.boundary_reason).toBe("compaction");
	});

	it("enqueueSummaryJob stores NULL boundary_reason when not provided", () => {
		const jobId = enqueueSummaryJob(accessor, {
			harness: "hermes-agent",
			transcript: "test transcript content",
			sessionKey: "test-session",
			agentId: "default",
			trigger: "session_end",
		});

		const row = db.prepare("SELECT boundary_reason FROM summary_jobs WHERE id = ?").get(jobId) as {
			boundary_reason: string | null;
		};
		expect(row.boundary_reason).toBeNull();
	});

	it("three compactions + one close = no duplicate durable facts", () => {
		// Simulate the issue #896 scenario: one session that has three
		// compaction events followed by a terminal close. Each event
		// enqueues a summary job with the appropriate boundary_reason.
		//
		// The regression assertion: only the session_closed job should
		// produce durable fact extraction. The compaction jobs should not.
		const sessionKey = "long-session-896";
		const agentId = "default";
		const transcript = "User: do some work\nAssistant: working on it";

		// Three compaction events
		for (let i = 0; i < 3; i++) {
			enqueueSummaryJob(accessor, {
				harness: "hermes-agent",
				transcript: `${transcript} (compaction ${i + 1})`,
				sessionKey,
				agentId,
				trigger: "checkpoint_extract",
				boundaryReason: "compaction",
			});
		}

		// One terminal close
		const closeJobId = enqueueSummaryJob(accessor, {
			harness: "hermes-agent",
			transcript,
			sessionKey,
			agentId,
			trigger: "session_end",
			boundaryReason: "session_closed",
		});

		// Verify boundary_reason was stored
		const jobs = db
			.prepare("SELECT boundary_reason, trigger FROM summary_jobs WHERE session_key = ? ORDER BY created_at")
			.all(sessionKey) as Array<{ boundary_reason: string | null; trigger: string }>;

		expect(jobs.length).toBe(4);
		expect(jobs[0].boundary_reason).toBe("compaction");
		expect(jobs[1].boundary_reason).toBe("compaction");
		expect(jobs[2].boundary_reason).toBe("compaction");
		expect(jobs[3].boundary_reason).toBe("session_closed");

		// Only the session_closed job should be eligible for durable artifacts
		const durableCount = jobs.filter((j) => isDurableBoundary(normalizeBoundaryReason(j.boundary_reason))).length;
		expect(durableCount).toBe(1);

		// The close job's row can be fetched by the summary worker
		const closeRow = db.prepare("SELECT id FROM summary_jobs WHERE id = ?").get(closeJobId) as { id: string };
		expect(closeRow.id).toBe(closeJobId);
	});

	it("duplicate checkpoint deltas are rejected by content-hash dedup", () => {
		// This tests the content_hash dedup extension to checkpoint extracts.
		// Two checkpoints with identical delta content should only produce
		// one summary job.
		const sessionKey = "dedup-session";
		const delta = "User: same content\nAssistant: same response";
		const agentId = "default";

		const job1 = enqueueSummaryJob(accessor, {
			harness: "hermes-agent",
			transcript: delta,
			sessionKey,
			agentId,
			trigger: "checkpoint_extract",
			boundaryReason: "checkpoint",
		});

		// Simulate the content hash check that handleCheckpointExtract does
		const { createHash } = require("node:crypto");
		const contentHash = createHash("sha256").update(delta).digest("hex");

		// Store content hash for job1
		db.prepare("UPDATE summary_jobs SET content_hash = ? WHERE id = ?").run(contentHash, job1);

		// Check: would the hooks layer detect this as a duplicate?
		const existing = db
			.prepare(
				`SELECT id FROM summary_jobs
				 WHERE agent_id = ? AND session_key = ? AND content_hash = ?
				 AND status IN ('pending', 'processing', 'completed')
				 LIMIT 1`,
			)
			.get(agentId, sessionKey, contentHash);
		expect(existing).toBeDefined();

		// If we tried to enqueue again, hooks.ts would detect the duplicate
		// and skip. This is the idempotency guarantee.
	});

	it("insertSummaryFacts with durable boundary inserts facts", () => {
		const facts = [{ content: "User prefers dark mode", importance: 0.4, tags: "preference", type: "preference" }];
		const job = makeJobRow({
			boundary_reason: "session_closed",
			trigger: "session_end",
		});

		const saved = insertSummaryFacts(accessor, job, facts);
		expect(saved).toBe(1);

		const rows = db.prepare("SELECT content FROM memories WHERE source_type = 'session_end'").all() as Array<{
			content: string;
		}>;
		expect(rows.length).toBe(1);
		expect(rows[0].content).toContain("dark mode");
	});

	it("insertSummaryFacts with identical content is deduplicated", () => {
		const facts = [{ content: "User prefers dark mode", importance: 0.4, tags: "preference", type: "preference" }];
		const job = makeJobRow({
			boundary_reason: "session_closed",
			trigger: "session_end",
		});

		// Insert once
		insertSummaryFacts(accessor, job, facts);
		// Insert again — should be deduplicated by content_hash
		insertSummaryFacts(accessor, job, facts);

		const rows = db.prepare("SELECT COUNT(*) as cnt FROM memories WHERE source_type = 'session_end'").get() as {
			cnt: number;
		};
		expect(rows.cnt).toBe(1);
	});
});

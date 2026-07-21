import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { runMigrations } from "../../../core/src/migrations";
import type { WriteDb } from "../db-accessor";
import { txForgetMemory, txIngestEnvelope } from "../transactions";
import { cancelJobForForgottenMemory, cancelJobsForForgottenMemory } from "./extraction-queue";
import { INGEST_JOB_TYPE } from "./ingest/lease";

function asWriteDb(db: Database): WriteDb {
	return db as unknown as WriteDb;
}

/** Insert a memory_jobs row in an arbitrary active status for a source memory. */
function insertJob(db: WriteDb, id: string, memoryId: string, jobType: string, status: string): void {
	const now = new Date().toISOString();
	db.prepare(
		`INSERT INTO memory_jobs
		 (id, memory_id, job_type, status, payload, attempts, max_attempts, agent_id,
		  created_at, updated_at)
		 VALUES (?, ?, ?, ?, '{}', 0, 5, 'default', ?, ?)`,
	).run(id, memoryId, jobType, status, now, now);
}

function statusOf(db: WriteDb, id: string): string {
	const row = db.prepare("SELECT status FROM memory_jobs WHERE id = ?").get(id) as { status: string };
	return row.status;
}

function insertMemory(db: Database, id: string): void {
	const now = new Date().toISOString();
	txIngestEnvelope(asWriteDb(db), {
		id,
		content: "source memory for forgotten-job cancellation test",
		normalizedContent: "source memory for forgotten-job cancellation test",
		contentHash: `hash-${id}`,
		who: "test",
		why: "test",
		project: "unit-test",
		importance: 0.6,
		type: "fact",
		tags: null,
		pinned: 0,
		isDeleted: 0,
		extractionStatus: "none",
		embeddingModel: null,
		extractionModel: null,
		updatedBy: "test",
		sourceType: "unit-test",
		sourceId: id,
		createdAt: now,
	});
}

describe("cancelJobsForForgottenMemory: #895 invariant across ingest + statuses", () => {
	let db: Database;
	let wdb: WriteDb;

	beforeEach(() => {
		db = new Database(":memory:");
		runMigrations(db as unknown as Parameters<typeof runMigrations>[0]);
		wdb = asWriteDb(db);
	});
	afterEach(() => db.close());

	// The primary #913 regression: a queued ingest job for a forgotten source
	// must be cancelled. Before the broadening, the cancel filter was hardcoded
	// to job_type='extract' AND status IN ('pending','leased'), so an ingest
	// job survived and the forgotten source produced descendants.
	it("cancels a pending ingest job for the forgotten source", () => {
		insertJob(wdb, "ingest-pending", "mem-1", INGEST_JOB_TYPE, "pending");
		const changes = cancelJobsForForgottenMemory(wdb, "mem-1", new Date().toISOString());
		expect(changes).toBe(1);
		expect(statusOf(wdb, "ingest-pending")).toBe("dead");
	});

	it.each([["leased"], ["planning"], ["applying"]])(
		"cancels an ingest job mid-lease (status=%s) so apply cannot produce descendants",
		(status) => {
			insertJob(wdb, `ingest-${status}`, "mem-1", INGEST_JOB_TYPE, status);
			expect(cancelJobsForForgottenMemory(wdb, "mem-1", new Date().toISOString())).toBe(1);
			expect(statusOf(wdb, `ingest-${status}`)).toBe("dead");
		},
	);

	// Regression guard: the existing extract coverage is preserved.
	it.each([["pending"], ["leased"]])("still cancels legacy extract jobs (status=%s)", (status) => {
		insertJob(wdb, `extract-${status}`, "mem-1", "extract", status);
		expect(cancelJobsForForgottenMemory(wdb, "mem-1", new Date().toISOString())).toBe(1);
		expect(statusOf(wdb, `extract-${status}`)).toBe("dead");
	});

	it("cancels every active job for the source in one call (extract + ingest, mixed phases)", () => {
		insertJob(wdb, "e1", "mem-1", "extract", "pending");
		insertJob(wdb, "i1", "mem-1", INGEST_JOB_TYPE, "pending");
		insertJob(wdb, "i2", "mem-1", INGEST_JOB_TYPE, "planning");
		insertJob(wdb, "i3", "mem-1", INGEST_JOB_TYPE, "applying");
		expect(cancelJobsForForgottenMemory(wdb, "mem-1", new Date().toISOString())).toBe(4);
		for (const id of ["e1", "i1", "i2", "i3"]) expect(statusOf(wdb, id)).toBe("dead");
	});

	it("does not touch terminal jobs or jobs for another source", () => {
		insertJob(wdb, "term-completed", "mem-1", INGEST_JOB_TYPE, "completed");
		insertJob(wdb, "term-dead", "mem-1", INGEST_JOB_TYPE, "dead");
		insertJob(wdb, "other-source", "mem-2", INGEST_JOB_TYPE, "pending");
		const changes = cancelJobsForForgottenMemory(wdb, "mem-1", new Date().toISOString());
		expect(changes).toBe(0);
		expect(statusOf(wdb, "term-completed")).toBe("completed");
		expect(statusOf(wdb, "term-dead")).toBe("dead");
		expect(statusOf(wdb, "other-source")).toBe("pending");
	});

	it("txForgetMemory cancels a queued ingest job for the forgotten source", () => {
		insertMemory(db, "mem-src");
		insertJob(wdb, "ingest-queued", "mem-src", INGEST_JOB_TYPE, "pending");

		const result = txForgetMemory(wdb, {
			memoryId: "mem-src",
			reason: "privacy request",
			changedBy: "operator",
			changedAt: new Date().toISOString(),
			force: false,
		});
		expect(result.status).toBe("deleted");
		expect(statusOf(wdb, "ingest-queued")).toBe("dead");
	});
});

describe("cancelJobForForgottenMemory: mid-lease re-check across statuses", () => {
	let db: Database;
	let wdb: WriteDb;

	beforeEach(() => {
		db = new Database(":memory:");
		runMigrations(db as unknown as Parameters<typeof runMigrations>[0]);
		wdb = asWriteDb(db);
	});
	afterEach(() => db.close());

	// Before the broadening, the singular cancel filtered status IN
	// ('pending','leased'), so a job re-checked while in planning/applying on the
	// unified ingest path would survive the cancel and still reach apply.
	it.each([["pending"], ["leased"], ["planning"], ["applying"]])(
		"dead-letters the job regardless of active phase (status=%s)",
		(status) => {
			insertJob(wdb, "j", "mem-1", INGEST_JOB_TYPE, status);
			cancelJobForForgottenMemory(wdb, "j");
			expect(statusOf(wdb, "j")).toBe("dead");
		},
	);

	it("is a no-op on a terminal job (does not resurrect)", () => {
		insertJob(wdb, "j", "mem-1", INGEST_JOB_TYPE, "completed");
		cancelJobForForgottenMemory(wdb, "j");
		expect(statusOf(wdb, "j")).toBe("completed");
	});
});
